import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { StorageError } from "@storage/core";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
};

export function guessContentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Joins `segments` under `root`, refusing any result that escapes it. */
export function safeJoin(root: string, ...segments: string[]): string {
  const target = resolve(root, ...segments);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== target) {
    throw new StorageError("invalid_argument", `Refusing to write outside ${root}.`);
  }
  return target;
}
