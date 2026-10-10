import { StorageError } from "./errors.js";

export const MAX_PATH_BYTES = 1024;
export const MAX_PATH_SEGMENTS = 32;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface NormalizedPath {
  /** Normalized path without a leading slash. Prefixes keep their trailing slash. Empty string is the collection root. */
  path: string;
  isPrefix: boolean;
}

/**
 * Normalizes an object path or prefix inside a collection (design doc §9.2).
 * A leading `/` is optional and a trailing `/` marks a prefix.
 */
export function normalizePath(input: string): NormalizedPath {
  if (CONTROL_CHARS.test(input)) {
    throw new StorageError("invalid_argument", "Path contains control characters.");
  }
  if (input.includes("\\")) {
    throw new StorageError("invalid_argument", "Path contains a backslash.", "Use `/` to separate path segments.");
  }
  const trimmed = input.replace(/^\/+/, "");
  if (trimmed === "") {
    return { path: "", isPrefix: true };
  }
  const isPrefix = trimmed.endsWith("/");
  const body = isPrefix ? trimmed.slice(0, -1) : trimmed;
  const segments = body.split("/");
  for (const segment of segments) {
    if (segment === "") {
      throw new StorageError("invalid_argument", `Path "${input}" contains an empty segment.`);
    }
    if (segment === "." || segment === "..") {
      throw new StorageError("invalid_argument", `Path "${input}" contains a "${segment}" segment.`);
    }
  }
  if (segments.length > MAX_PATH_SEGMENTS) {
    throw new StorageError("invalid_argument", `Path has more than ${MAX_PATH_SEGMENTS} segments.`);
  }
  const path = isPrefix ? `${body}/` : body;
  if (new TextEncoder().encode(path).length > MAX_PATH_BYTES) {
    throw new StorageError("invalid_argument", `Path is longer than ${MAX_PATH_BYTES} bytes.`);
  }
  return { path, isPrefix };
}

export function basename(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}
