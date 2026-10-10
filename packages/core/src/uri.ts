import { StorageError } from "./errors.js";
import { normalizePath } from "./paths.js";

export const URI_SCHEME = "storage://";

/** Org and collection slugs: lowercase letters, digits, and inner hyphens, 1-64 characters. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const VERSION_SUFFIX = /@(\d+|sha256:[0-9a-f]{64})$/;

export type VersionSelector = { kind: "number"; version: number } | { kind: "sha256"; sha256: string };

export type UriKind = "org" | "collection" | "prefix" | "object";

export interface ParsedUri {
  org: string;
  collection: string | null;
  /** Normalized path inside the collection. Empty for the collection root; prefixes end with `/`. */
  path: string;
  version: VersionSelector | null;
  kind: UriKind;
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

function assertSlug(slug: string, what: "org" | "collection", input: string): void {
  if (!isValidSlug(slug)) {
    throw new StorageError(
      "invalid_argument",
      `Invalid ${what} slug "${slug}" in "${input}".`,
      "Slugs use lowercase letters, digits, and hyphens, and are at most 64 characters.",
    );
  }
}

/** Parses `storage://<org>/<collection>[/<path>][@<version>]` (design doc §9.1). */
export function parseUri(input: string): ParsedUri {
  if (input.startsWith("gh-pr:")) {
    throw new StorageError(
      "invalid_argument",
      "The gh-pr: shorthand is not supported yet.",
      "Use a storage://<org>/<collection>/ URI.",
    );
  }
  if (!input.startsWith(URI_SCHEME)) {
    throw new StorageError(
      "invalid_argument",
      `"${input}" is not a storage URI.`,
      "URIs look like storage://<org>/<collection>/<path>.",
    );
  }
  const rest = input.slice(URI_SCHEME.length);
  const firstSlash = rest.indexOf("/");
  const org = firstSlash === -1 ? rest : rest.slice(0, firstSlash);
  assertSlug(org, "org", input);
  const afterOrg = firstSlash === -1 ? "" : rest.slice(firstSlash + 1);
  if (afterOrg === "") {
    return { org, collection: null, path: "", version: null, kind: "org" };
  }

  const secondSlash = afterOrg.indexOf("/");
  const collection = secondSlash === -1 ? afterOrg : afterOrg.slice(0, secondSlash);
  assertSlug(collection, "collection", input);
  let rawPath = secondSlash === -1 ? "" : afterOrg.slice(secondSlash + 1);

  let version: VersionSelector | null = null;
  const match = rawPath === "" ? null : VERSION_SUFFIX.exec(rawPath);
  if (match?.[1] !== undefined) {
    const selector = match[1];
    version = selector.startsWith("sha256:")
      ? { kind: "sha256", sha256: selector.slice("sha256:".length) }
      : { kind: "number", version: Number.parseInt(selector, 10) };
    rawPath = rawPath.slice(0, match.index);
  }

  if (rawPath.startsWith("/")) {
    throw new StorageError("invalid_argument", `"${input}" contains an empty path segment.`);
  }
  const { path, isPrefix } = normalizePath(rawPath);
  if (version !== null && isPrefix) {
    throw new StorageError("invalid_argument", `A version can only be given for an object, not "${input}".`);
  }
  const kind: UriKind = path === "" ? "collection" : isPrefix ? "prefix" : "object";
  return { org, collection, path, version, kind };
}

export interface UriParts {
  org: string;
  collection?: string | null;
  path?: string;
  version?: VersionSelector | null;
}

export function formatUri(parts: UriParts): string {
  let uri = `${URI_SCHEME}${parts.org}/`;
  if (parts.collection) {
    uri += `${parts.collection}/${parts.path ?? ""}`;
  }
  if (parts.version) {
    uri += formatVersion(parts.version);
  }
  return uri;
}

/** Formats a version selector as its URI suffix, for example `@3` or `@sha256:<hex>`. */
export function formatVersion(version: VersionSelector): string {
  return version.kind === "number" ? `@${version.version}` : `@sha256:${version.sha256}`;
}

function withArticle(phrase: string): string {
  return /^[aeiou]/.test(phrase) ? `an ${phrase}` : `a ${phrase}`;
}

/** Parses a URI and checks that it addresses one of the allowed kinds. */
export function parseUriOfKind(input: string, allowed: readonly UriKind[]): ParsedUri {
  const parsed = parseUri(input);
  if (!allowed.includes(parsed.kind)) {
    const expected = allowed.join(" or ");
    throw new StorageError(
      "invalid_argument",
      `Expected ${withArticle(expected)} URI, got ${withArticle(parsed.kind)} URI: "${input}".`,
      parsed.kind === "object" && allowed.includes("prefix") ? "Add a trailing `/` to address a prefix." : undefined,
    );
  }
  return parsed;
}
