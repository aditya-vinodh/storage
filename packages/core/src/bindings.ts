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
