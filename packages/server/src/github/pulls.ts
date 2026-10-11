/** Reads pull request state from the GitHub REST API for polling (docs/specs/bindings.md). */

/** The fields of a pull request that bindings use, as GitHub reports them. */
export interface PullRequestState {
  state: "open" | "closed";
  closed_at: string | null;
  merged_at: string | null;
  updated_at: string;
}

export type PullResult = { ok: true; pull: PullRequestState } | { ok: false; status: number };

export interface GitHubPulls {
  /**
   * GET /repos/<owner>/<repo>/pulls/<number>. A non-2xx response is `{ ok: false, status }`; network failures and
   * unreadable bodies throw.
   */
  get(owner: string, repo: string, number: number): Promise<PullResult>;
}

const API_URL = "https://api.github.com";

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

export function githubPulls(options: { token: string; fetch?: typeof fetch }): GitHubPulls {
  const doFetch = options.fetch ?? fetch;
  return {
    async get(owner, repo, number) {
      const url = `${API_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
      const response = await doFetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "storage-server",
          authorization: `Bearer ${options.token}`,
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, status: response.status };
      }
      const pull = readPullRequest(await response.json());
      if (pull === null) {
        throw new Error(`GitHub ${url} returned a pull request without state and updated_at.`);
      }
      return { ok: true, pull };
    },
  };
}
