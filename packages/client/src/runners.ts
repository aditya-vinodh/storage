import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { basename, normalizePath, type OperationSpec, ops, parseUriOfKind, StorageError } from "@storage/core";
import type { z } from "zod";
import { type ApiClient, errorFromResponse } from "./api.js";
import { guessContentType, safeJoin, sha256File } from "./files.js";

export interface RunnerContext {
  api: ApiClient;
  /** Root for local state; downloads are cached under `<home>/cache`. */
  home: string;
  /** Directory that relative local paths are resolved against. */
  cwd: string;
  /** Destination for `delivery: "inline"` content. */
  stdout: Writable;
  fetch?: typeof fetch;
}

type Runner<S extends OperationSpec> = (
  input: z.output<S["input"]>,
  ctx: RunnerContext,
) => Promise<z.input<S["output"]>>;

async function transferFailed(response: Response, what: string): Promise<StorageError> {
  const error = await errorFromResponse(response);
  return new StorageError(error.code, `${what} failed: ${error.message}`, error.hint);
}

const runPut: Runner<typeof ops.put> = async (input, ctx) => {
  const file = resolve(ctx.cwd, input.file);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    throw new StorageError("invalid_argument", `${input.file} is not a readable file.`);
  }
  const sha256 = await sha256File(file);

  const initiated = await ctx.api.call(ops.uploadInitiate, {
    uri: input.uri,
    size: info.size,
    sha256,
    content_type: input.content_type ?? guessContentType(file),
    description: input.description,
    meta: input.meta,
    if_match: input.if_match,
    idempotency_key: input.idempotency_key,
  });

  if (initiated.upload !== null) {
    const doFetch = ctx.fetch ?? fetch;
    const response = await doFetch(initiated.upload.url, {
      method: initiated.upload.method,
      headers: { ...initiated.upload.headers, "content-length": String(info.size) },
      body: Readable.toWeb(createReadStream(file)) as ReadableStream,
      duplex: "half",
    } as RequestInit);
    if (!response.ok) {
      throw await transferFailed(response, "Upload");
    }
  }

  return ctx.api.call(ops.uploadCommit, { upload_id: initiated.upload_id });
};

/** Downloads `url` to `target`, verifying size and hash before moving it into place. */
async function downloadVerified(
  doFetch: typeof fetch,
  url: string,
  target: string,
  expected: { size: number; sha256: string },
): Promise<void> {
  const response = await doFetch(url);
  if (!response.ok || response.body === null) {
    throw await transferFailed(response, "Download");
  }
  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.partial-${randomBytes(6).toString("hex")}`;
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream),
      meter,
      createWriteStream(partial, { flags: "wx" }),
    );
    if (bytes !== expected.size || hash.digest("hex") !== expected.sha256) {
      throw new StorageError("internal", "Downloaded content does not match the expected size and sha256.");
    }
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
}

async function hasContent(path: string, expected: { size: number; sha256: string }): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info?.isFile() === true && info.size === expected.size && (await sha256File(path)) === expected.sha256;
}

const runGet: Runner<typeof ops.get> = async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["object"]);
  const resolved = await ctx.api.call(ops.downloadUrl, { uri: input.uri });
  const { url, url_expires_at: _expires, ...version } = resolved;
  const doFetch = ctx.fetch ?? fetch;

  // Paths are normalized server-side; re-validate before touching the filesystem.
  const checked = normalizePath(version.path);
  if (checked.isPrefix || checked.path !== version.path) {
    throw new StorageError("internal", `Server returned an invalid path "${version.path}".`);
  }

  if (input.delivery === "inline") {
    const response = await doFetch(url);
    if (!response.ok || response.body === null) {
      throw await transferFailed(response, "Download");
    }
    await pipeline(Readable.fromWeb(response.body as NodeReadableStream), ctx.stdout, { end: false });
    return { ...version, delivery: "inline" };
  }

  const target =
    input.to === undefined
      ? safeJoin(resolve(ctx.home, "cache"), uri.org, uri.collection as string, ...version.path.split("/"))
      : safeJoin(resolve(ctx.cwd, input.to), basename(version.path));
  if (!(await hasContent(target, version))) {
    await downloadVerified(doFetch, url, target, version);
  }
  return { ...version, delivery: "ref", path: target };
};

const RUNNERS = new Map<string, Runner<OperationSpec>>([
  [ops.put.name, runPut as Runner<OperationSpec>],
  [ops.get.name, runGet as Runner<OperationSpec>],
]);

/**
 * Runs a public operation from the client side. Operations that touch local
 * files (`put`, `get`) run here; the rest are forwarded to the server as is.
 * Shared by the CLI and, later, the local MCP server.
 */
export async function runOperation<S extends OperationSpec>(
  spec: S,
  rawInput: unknown,
  ctx: RunnerContext,
): Promise<z.output<S["output"]>> {
  const parsed = spec.input.safeParse(rawInput);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
      .join("; ");
    throw new StorageError("invalid_argument", `Invalid input for ${spec.name}: ${details}`);
  }
  const runner = RUNNERS.get(spec.name);
  const result = runner ? await runner(parsed.data, ctx) : await ctx.api.call(spec, parsed.data as z.input<S["input"]>);
  return spec.output.parse(result) as z.output<S["output"]>;
}
