import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { guessContentType, ops, StorageError } from "@storage/core";
import type { z } from "zod";
import { type ApiClient, errorFromResponse } from "./api.js";
import { sha256File } from "./files.js";

export async function transferFailed(response: Response, what: string): Promise<StorageError> {
  const error = await errorFromResponse(response);
  return new StorageError(error.code, `${what} failed: ${error.message}`, error.hint);
}

export interface UploadOptions {
  uri: string;
  size: number;
  sha256: string;
  content_type?: string | undefined;
  description?: string | undefined;
  meta?: Record<string, string> | undefined;
  if_match?: string | undefined;
  idempotency_key?: string | undefined;
}

/** Uploads a local file whose size and hash are already known: initiate, transfer (unless deduplicated), commit. */
export async function uploadFile(
  api: ApiClient,
  doFetch: typeof fetch,
  file: string,
  options: UploadOptions,
): Promise<z.output<typeof ops.uploadCommit.output>> {
  const initiated = await api.call(ops.uploadInitiate, {
    ...options,
    content_type: options.content_type ?? guessContentType(file),
  });
  if (initiated.upload !== null) {
    const response = await doFetch(initiated.upload.url, {
      method: initiated.upload.method,
      headers: { ...initiated.upload.headers, "content-length": String(options.size) },
      body: Readable.toWeb(createReadStream(file)) as ReadableStream,
      duplex: "half",
    } as RequestInit);
    if (!response.ok) {
      throw await transferFailed(response, "Upload");
    }
  }
  return api.call(ops.uploadCommit, { upload_id: initiated.upload_id });
}

export const CONTENT_MISMATCH = "Downloaded content does not match the expected size and sha256.";

/**
 * Downloads `url` into memory, verifying size and hash. Stops reading as soon
 * as the body runs past the expected size, so a bad server can't exhaust memory.
 */
export async function downloadToMemory(
  doFetch: typeof fetch,
  url: string,
  expected: { size: number; sha256: string },
): Promise<Buffer> {
  const response = await doFetch(url);
  if (!response.ok || response.body === null) {
    throw await transferFailed(response, "Download");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of Readable.fromWeb(response.body as NodeReadableStream)) {
    bytes += (chunk as Buffer).length;
    if (bytes > expected.size) {
      throw new StorageError("internal", CONTENT_MISMATCH);
    }
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  if (body.length !== expected.size || createHash("sha256").update(body).digest("hex") !== expected.sha256) {
    throw new StorageError("internal", CONTENT_MISMATCH);
  }
  return body;
}

/** Downloads `url` to `target`, verifying size and hash before moving it into place. */
export async function downloadVerified(
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
      throw new StorageError("internal", CONTENT_MISMATCH);
    }
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
}

/** True if `path` is a regular file with exactly the expected content. */
export async function hasContent(path: string, expected: { size: number; sha256: string }): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info?.isFile() === true && info.size === expected.size && (await sha256File(path)) === expected.sha256;
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight, preserving order
 * in the result. After the first failure no new calls start, and the error is
 * thrown once the calls already in flight have settled, so nothing keeps
 * writing after the caller sees the failure.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== null) {
    throw (failure as { error: unknown }).error;
  }
  return results;
}
