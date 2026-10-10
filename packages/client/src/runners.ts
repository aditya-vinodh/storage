import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  basename,
  type InlineContent,
  inlineKind,
  normalizePath,
  type OperationSpec,
  ops,
  parseUri,
  parseUriOfKind,
  StorageError,
} from "@storage/core";
import type { z } from "zod";
import type { ApiClient } from "./api.js";
import { safeJoin, sha256File } from "./files.js";
import { runPull, runPush } from "./sync.js";
import {
  CONTENT_MISMATCH,
  downloadToMemory,
  downloadVerified,
  hasContent,
  transferFailed,
  uploadFile,
} from "./transfer.js";

export interface RunnerContext {
  api: ApiClient;
  /** Root for local state; downloads are cached under `<home>/cache`. */
  home: string;
  /** Directory that relative local paths are resolved against. */
  cwd: string;
  /** Destination for streamed `delivery: "inline"` content (CLI). */
  stdout?: Writable;
  /** When set, inline content is collected and handed to `onContent` (MCP) instead of streamed to `stdout`. */
  inline?: { maxBytes: number; onContent(content: InlineContent): void };
  fetch?: typeof fetch;
}

export type Runner<S extends OperationSpec> = (
  input: z.output<S["input"]>,
  ctx: RunnerContext,
) => Promise<z.input<S["output"]>>;

const runPut: Runner<typeof ops.put> = async (input, ctx) => {
  const file = resolve(ctx.cwd, input.file);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    throw new StorageError("invalid_argument", `${input.file} is not a readable file.`);
  }
  return uploadFile(ctx.api, ctx.fetch ?? fetch, file, {
    uri: input.uri,
    size: info.size,
    sha256: await sha256File(file),
    content_type: input.content_type,
    description: input.description,
    meta: input.meta,
    if_match: input.if_match,
    idempotency_key: input.idempotency_key,
  });
};

const runGet: Runner<typeof ops.get> = async (input, ctx) => {
  const parsed = parseUri(input.uri);
  if (parsed.kind === "collection" || parsed.kind === "prefix") {
    throw new StorageError(
      "invalid_argument",
      `get takes an object URI; ${input.uri} is a ${parsed.kind}.`,
      `Download everything under it with: storage pull ${input.uri}`,
    );
  }
  const uri = parseUriOfKind(input.uri, ["object"]);
  const resolved = await ctx.api.call(ops.downloadUrl, { uri: input.uri });
  const { url, url_expires_at: _expires, ...version } = resolved;
  const doFetch = ctx.fetch ?? fetch;

  // Paths are normalized server-side; re-validate before touching the filesystem.
  const checked = normalizePath(version.path);
  if (checked.isPrefix || checked.path !== version.path) {
    throw new StorageError("internal", `Server returned an invalid path "${version.path}".`);
  }

  // `path` in the output is the local path, so the object path must not leak into inline results.
  const { path: _objectPath, ...inlineVersion } = version;
  const downloadRef = async (note?: string) => {
    const target =
      input.to === undefined
        ? safeJoin(resolve(ctx.home, "cache"), uri.org, uri.collection as string, ...version.path.split("/"))
        : safeJoin(resolve(ctx.cwd, input.to), basename(version.path));
    if (!(await hasContent(target, version))) {
      await downloadVerified(doFetch, url, target, version);
    }
    return { ...version, delivery: "ref" as const, path: target, ...(note === undefined ? {} : { note }) };
  };

  if (input.delivery === "inline") {
    if (ctx.inline === undefined) {
      if (ctx.stdout === undefined) {
        throw new StorageError("internal", "Inline delivery needs an output stream or an inline collector.");
      }
      await streamInline(doFetch, url, ctx.stdout, version);
      return { ...inlineVersion, delivery: "inline" };
    }
    const { maxBytes, onContent } = ctx.inline;
    const kind = inlineKind(version.content_type);
    if (kind === "binary") {
      return downloadRef(
        `Inline delivery isn't available for ${version.content_type}; downloaded to a local path instead.`,
      );
    }
    if (version.size > maxBytes) {
      return downloadRef(
        `${version.size} bytes is over the ${maxBytes}-byte inline limit; downloaded to a local path instead.`,
      );
    }
    const bytes = await downloadToMemory(doFetch, url, version);
    if (kind === "text") {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return downloadRef(`${version.uri} is not valid UTF-8; downloaded to a local path instead.`);
      }
      onContent({ kind: "text", uri: version.uri, sha256: version.sha256, text });
    } else {
      onContent({
        kind: "image",
        uri: version.uri,
        sha256: version.sha256,
        data: bytes.toString("base64"),
        mime_type: (version.content_type.split(";")[0] ?? "").trim().toLowerCase(),
      });
    }
    return { ...inlineVersion, delivery: "inline" };
  }

  return downloadRef();
};

/** Streams the download to `out` (left open), then verifies size and hash. Bytes are already written on mismatch. */
async function streamInline(
  doFetch: typeof fetch,
  url: string,
  out: Writable,
  expected: { size: number; sha256: string },
): Promise<void> {
  const response = await doFetch(url);
  if (!response.ok || response.body === null) {
    throw await transferFailed(response, "Download");
  }
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream), meter, out, { end: false });
  if (size !== expected.size || hash.digest("hex") !== expected.sha256) {
    throw new StorageError("internal", CONTENT_MISMATCH);
  }
}

const RUNNERS = new Map<string, Runner<OperationSpec>>([
  [ops.put.name, runPut as Runner<OperationSpec>],
  [ops.get.name, runGet as Runner<OperationSpec>],
  [ops.push.name, runPush as Runner<OperationSpec>],
  [ops.pull.name, runPull as Runner<OperationSpec>],
]);

/**
 * Runs a public operation from the client side. Operations that touch local
 * files (`put`, `get`, `push`, `pull`) run here; the rest are forwarded to the
 * server as is. Shared by the CLI and, later, the local MCP server.
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
