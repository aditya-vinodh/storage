import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { StorageError } from "@storage/core";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
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
