import { StorageError } from "./errors.js";

/** A GitHub pull request a collection can be bound to (docs/specs/bindings.md). Owner and repo are lowercased. */
export interface BindingTarget {
  kind: "github";
  owner: string;
  repo: string;
  number: number;
}

const TARGET_PATTERN =
  /^github:([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9})$/;
const MAX_NUMBER = 2 ** 31 - 1;

/** Parses `github:<owner>/<repo>#<number>`. Throws `invalid_argument` for anything else. */
export function parseTarget(input: string): BindingTarget {
  const match = TARGET_PATTERN.exec(input);
  const repo = match?.[2];
  const number = match?.[3] === undefined ? Number.NaN : Number(match[3]);
  if (!match || repo === "." || repo === ".." || !(number <= MAX_NUMBER)) {
    throw new StorageError(
      "invalid_argument",
      `"${input}" isn't a binding target.`,
      "Targets look like github:acme/web#482.",
    );
  }
  return { kind: "github", owner: (match[1] as string).toLowerCase(), repo: (repo as string).toLowerCase(), number };
}

export function formatTarget(target: BindingTarget): string {
  return `github:${target.owner}/${target.repo}#${target.number}`;
}

export function pullRequestUrl(target: BindingTarget): string {
  return `https://github.com/${target.owner}/${target.repo}/pull/${target.number}`;
}

export const SHORTHAND_SCHEME = "gh-pr:";

/** A parsed `gh-pr:` URI (docs/specs/gh-pr-shorthand.md). Owner and repo are lowercased. */
export interface Shorthand {
  owner: string;
  repo: string;
  pr: { number: number } | { branch: string };
  /** The path and version after the `/` that follows the PR, empty for the collection itself. */
  rest: string;
}

const SHORTHAND_PATTERN =
  /^gh-pr:([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})(?:#([1-9][0-9]{0,9})|@([^/]+))(?:\/(.*))?$/s;
const MAX_BRANCH = 255;

export function isShorthand(input: string): boolean {
  return input.startsWith(SHORTHAND_SCHEME);
}

function decodeBranch(raw: string): string | null {
  try {
    const branch = decodeURIComponent(raw);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    return branch.length > 0 && branch.length <= MAX_BRANCH && !/[\u0000-\u001f\u007f]/.test(branch) ? branch : null;
  } catch {
    return null;
  }
}

/** Parses `gh-pr:<owner>/<repo>#<number>[/<rest>]` or `gh-pr:<owner>/<repo>@<branch>[/<rest>]`. */
export function parseShorthand(input: string): Shorthand {
  const match = SHORTHAND_PATTERN.exec(input);
  const repo = match?.[2];
  const number = match?.[3] === undefined ? null : Number(match[3]);
  const branch = match?.[4] === undefined ? null : decodeBranch(match[4]);
  if (
    !match ||
    repo === "." ||
    repo === ".." ||
    (number !== null && number > MAX_NUMBER) ||
    (number === null && branch === null)
  ) {
    throw new StorageError(
      "invalid_argument",
      `"${input}" isn't a gh-pr: URI.`,
      "Shorthand URIs look like gh-pr:acme/web#482/ or gh-pr:acme/web@main/.",
    );
  }
  return {
    owner: (match[1] as string).toLowerCase(),
    repo: (repo as string).toLowerCase(),
    pr: number !== null ? { number } : { branch: branch as string },
    rest: match[5] ?? "",
  };
}

const SLUG_MAX = 64;

/** The slug of a collection auto-created for a PR: `<repo>-pr-<number>`, cut to fit 64 characters. */
export function pullRequestSlug(repo: string, number: number): string {
  const suffix = `pr-${number}`;
  const base = repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX - suffix.length - 1)
    .replace(/-+$/, "");
  return base === "" ? suffix : `${base}-${suffix}`;
}
