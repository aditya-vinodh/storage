import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  basename,
  formatVersion,
  guessContentType,
  type InlineContent,
  inlineKind,
  inputFor,
  type OperationSpec,
  offeredOn,
  ops,
  parseUri,
  parseUriOfKind,
  StorageError,
} from "@storage/core";
import { recordAudit } from "../audit.js";
import { blobKey } from "../blobs/store.js";
import type { ServiceContext } from "../service/context.js";
import { HANDLERS } from "../service/index.js";
import { recordUrlIssued, resolveDownload } from "../service/objects.js";
import { describeIssues, runHandler } from "../service/run.js";
import { rewriteShorthand } from "../service/shorthand.js";
import { uploadCommitHandler, uploadInitiateHandler } from "../service/uploads.js";

export interface HostedResult {
  output: unknown;
  inline: InlineContent[];
}

/** Quotes a shell argument only when it has characters the shell would treat specially. */
function arg(value: string): string {
  return /^[A-Za-z0-9_\-.,/:@=+%]+$/.test(value) ? value : q(value);
}

/** Always single-quotes a shell argument. */
function q(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readBlob(ctx: ServiceContext, key: string, size: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of await ctx.blobs.read(key)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > size) {
      throw new StorageError("internal", "Stored blob is larger than its recorded size.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function runPut(rawInput: unknown, ctx: ServiceContext): Promise<unknown> {
  const parsed = inputFor(ops.put, "hosted").safeParse(rawInput);
  if (!parsed.success) {
    throw new StorageError("invalid_argument", `Invalid input for put: ${describeIssues(parsed.error)}`);
  }
  const input = parsed.data as {
    uri: string;
    bytes: string;
    content_type?: string;
    description?: string;
    meta?: Record<string, string>;
    if_match?: string;
    idempotency_key?: string;
  };
  const bytes = Buffer.from(input.bytes, "base64");
  const max = ctx.config.mcpMaxUploadBytes;
  if (bytes.length > max) {
    throw new StorageError(
      "too_large",
      `${bytes.length} bytes is over the ${max}-byte limit for put on the hosted MCP server.`,
      "Upload it with the storage CLI: storage put <file> <uri>",
    );
  }
  const target = parseUriOfKind(input.uri, ["object"]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const initiate = {
    uri: input.uri,
    size: bytes.length,
    sha256,
    content_type: input.content_type ?? guessContentType(target.path),
    description: input.description,
    meta: input.meta,
    if_match: input.if_match,
    idempotency_key: input.idempotency_key,
  };
  const started = (await runHandler(
    uploadInitiateHandler,
    ops.uploadInitiate.input,
    Object.fromEntries(Object.entries(initiate).filter(([, value]) => value !== undefined)),
    ctx,
  )) as { upload_id: string; upload: unknown };
  if (started.upload !== null) {
    const row = await ctx.db
      .selectFrom("uploads")
      .select("org_id")
      .where("id", "=", started.upload_id)
      .executeTakeFirstOrThrow();
    await ctx.blobs.write(blobKey(row.org_id, sha256), Readable.from(bytes), { size: bytes.length, sha256 });
  }
  return runHandler(uploadCommitHandler, ops.uploadCommit.input, { upload_id: started.upload_id }, ctx);
}

async function runGet(rawInput: unknown, ctx: ServiceContext): Promise<HostedResult> {
  const parsedInput = inputFor(ops.get, "hosted").safeParse(rawInput);
  if (!parsedInput.success) {
    throw new StorageError("invalid_argument", `Invalid input for get: ${describeIssues(parsedInput.error)}`);
  }
  const input = parsedInput.data as { uri: string; delivery?: "ref" | "inline" };
  const parsed = parseUri(input.uri);
  if (parsed.kind === "collection" || parsed.kind === "prefix") {
    throw new StorageError(
      "invalid_argument",
      `get takes an object URI; ${input.uri} is a ${parsed.kind}.`,
      "List it with the list tool, then get each object.",
    );
  }
  const { orgId, object, version, record } = await resolveDownload(ctx, input.uri);
  const delivery = input.delivery ?? ctx.principal.token.defaultDelivery ?? "ref";
  // `path` in get's output means a local path, so the object path stays out of hosted results.
  const { path: _objectPath, ...fields } = record;
  const key = blobKey(orgId, version.blob_sha256);

  const asRef = async (note?: string) => {
    const signed = await ctx.blobs.presignDownload(key, {
      contentType: version.content_type,
      filename: basename(object.path),
      expiresAt: new Date(ctx.now().getTime() + ctx.config.downloadTtlSeconds * 1000),
    });
    await recordUrlIssued(ctx, orgId, record, signed.expiresAt);
    const selector = parsed.version === null ? "" : formatVersion(parsed.version);
    return {
      output: {
        ...fields,
        delivery: "ref" as const,
        url: signed.url,
        url_expires_at: signed.expiresAt.toISOString(),
        fetch: {
          command: `storage get ${arg(record.uri + selector)} --to .`,
          curl: `curl -fsSL -o ${q(basename(object.path))} ${q(signed.url)}`,
        },
        ...(note === undefined ? {} : { note }),
      },
      inline: [],
    };
  };

  if (delivery !== "inline") {
    return asRef();
  }
  const kind = inlineKind(record.content_type);
  if (kind === "binary") {
    return asRef(`Inline delivery isn't available for ${record.content_type}; returned a signed URL instead.`);
  }
  const max = ctx.config.inlineMaxBytes;
  if (record.size > max) {
    return asRef(`${record.size} bytes is over the ${max}-byte inline limit; returned a signed URL instead.`);
  }
  const bytes = await readBlob(ctx, key, record.size);
  if (bytes.length !== record.size || createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
    throw new StorageError("internal", "Stored content does not match its recorded size or hash.");
  }
  let content: InlineContent;
  if (kind === "text") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return asRef(`${record.uri} is not valid UTF-8; returned a signed URL instead.`);
    }
    content = { kind: "text", uri: record.uri, sha256: record.sha256, text };
  } else {
    content = {
      kind: "image",
      uri: record.uri,
      sha256: record.sha256,
      data: bytes.toString("base64"),
      mime_type: (record.content_type.split(";")[0] ?? "").trim().toLowerCase(),
    };
  }
  await recordAudit(ctx.db, ctx.principal, ctx.now(), {
    orgId,
    action: "content.inline",
    target: `${record.uri}@${record.version}`,
    detail: { version: record.version, size: record.size },
  });
  return { output: { ...fields, delivery: "inline" as const }, inline: [content] };
}

/**
 * Runs an operation for the hosted MCP server. Bytes arrive and leave in the
 * tool call itself, so `put` and `get` run here instead of through signed URLs.
 */
export async function runHosted(spec: OperationSpec, input: unknown, ctx: ServiceContext): Promise<HostedResult> {
  if (!offeredOn(spec, "hosted")) {
    throw new StorageError(
      "invalid_argument",
      `${spec.name} isn't available on the hosted MCP server.`,
      "Use the storage CLI.",
    );
  }
  // put and get parse their URI before reaching a handler, so a gh-pr: URI is resolved here first.
  const rawInput = await rewriteShorthand(spec, input, ctx);
  let result: HostedResult;
  if (spec.name === ops.put.name) {
    result = { output: await runPut(rawInput, ctx), inline: [] };
  } else if (spec.name === ops.get.name) {
    result = await runGet(rawInput, ctx);
  } else {
    const handler = HANDLERS.get(spec.name);
    if (!handler) {
      throw new StorageError(
        "invalid_argument",
        `${spec.name} isn't available on the hosted MCP server.`,
        "Use the storage CLI.",
      );
    }
    result = { output: await runHandler(handler, inputFor(spec, "hosted"), rawInput, ctx), inline: [] };
  }
  const output = spec.output.safeParse(result.output);
  if (!output.success) {
    throw new Error(`Hosted ${spec.name} returned output that violates its schema: ${describeIssues(output.error)}`);
  }
  return { output: output.data, inline: result.inline };
}
