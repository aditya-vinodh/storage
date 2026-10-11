import type { ServerConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { applyPullRequest } from "./bindings.js";
import type { GitHubPulls } from "./pulls.js";

/** Polls GitHub for the state of bound pull requests that webhooks haven't reported (docs/specs/bindings.md). */

const BATCH = 100;

interface Due {
  id: string;
  target: string;
  owner: string;
  repo: string;
  number: number;
}

/**
 * Polls up to 100 unmerged bindings that are due, never-polled first and then oldest, fetching each pull request once.
 * Returns how many bindings got a new `polled_at`.
 */
export async function pollBindings(
  deps: { db: Db; github: GitHubPulls | null; config: Pick<ServerConfig, "githubAdapter"> },
  now: Date,
): Promise<number> {
  const { db, github } = deps;
  if (github === null) {
    return 0;
  }
  const cutoff = new Date(now.getTime() - deps.config.githubAdapter.pollIntervalSeconds * 1000).toISOString();
  const columns = ["id", "target", "owner", "repo", "number"] as const;

  // SQLite and Postgres order nulls differently, so the never-polled bindings are read on their own.
  const fresh: Due[] = await db
    .selectFrom("bindings")
    .select(columns)
    .where("state", "<>", "merged")
    .where("polled_at", "is", null)
    .orderBy("created_at")
    .orderBy("id")
    .limit(BATCH)
    .execute();
  const stale: Due[] =
    fresh.length >= BATCH
      ? []
      : await db
          .selectFrom("bindings")
          .select(columns)
          .where("state", "<>", "merged")
          .where("polled_at", "<=", cutoff)
          .orderBy("polled_at")
          .orderBy("id")
          .limit(BATCH - fresh.length)
          .execute();

  const groups = new Map<string, Due[]>();
  for (const row of [...fresh, ...stale]) {
    const key = `${row.owner}/${row.repo}#${row.number}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  let polled = 0;
  for (const rows of groups.values()) {
    const first = rows[0] as Due;
    const mark = async (pollError: string | null) => {
      await db
        .updateTable("bindings")
        .set({ polled_at: now.toISOString(), poll_error: pollError })
        .where(
          "id",
          "in",
          rows.map((row) => row.id),
        )
        .execute();
      polled += rows.length;
    };

    try {
      const result = await github.get(first.owner, first.repo, first.number);
      if (result.ok) {
        await applyPullRequest(db, first, result.pull, "poll", now);
        await mark(null);
      } else if (result.status === 401 || result.status === 403) {
        console.warn(
          `GitHub returned ${result.status} while polling ${first.target}; check STORAGE_GITHUB_POLL_TOKEN.`,
        );
        return polled;
      } else {
        await mark(`GitHub returned ${result.status} for ${first.target}.`);
      }
    } catch (error) {
      console.warn(`Couldn't poll ${first.target}:`, error);
      await mark(`Couldn't reach GitHub for ${first.target}.`);
    }
  }
  return polled;
}
