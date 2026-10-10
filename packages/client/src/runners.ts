import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  basename,
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
import { downloadVerified, hasContent, transferFailed, uploadFile } from "./transfer.js";

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
