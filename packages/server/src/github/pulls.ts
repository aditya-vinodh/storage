/** Pull request state as GitHub reports it, from the REST API and webhooks (docs/specs/bindings.md). */

/** The fields of a pull request that bindings use, as GitHub reports them. */
export interface PullRequestState {
  state: "open" | "closed";
  closed_at: string | null;
  merged_at: string | null;
  updated_at: string;
}

export type PullResult = { ok: true; pull: PullRequestState } | { ok: false; status: number };

/** An ISO timestamp from GitHub, normalized with toISOString so stored times compare as strings. Undefined if invalid. */
function timestamp(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Reads a GitHub pull request payload's state fields. Returns null if they're missing or malformed. */
export function readPullRequest(value: unknown): PullRequestState | null {
  const pull = value as Record<string, unknown> | null;
  const closedAt = timestamp(pull?.closed_at);
  const mergedAt = timestamp(pull?.merged_at);
  const updatedAt = timestamp(pull?.updated_at);
  if (
    (pull?.state !== "open" && pull?.state !== "closed") ||
    typeof updatedAt !== "string" ||
    closedAt === undefined ||
    mergedAt === undefined
  ) {
    return null;
  }
  return { state: pull.state, closed_at: closedAt, merged_at: mergedAt, updated_at: updatedAt };
}
