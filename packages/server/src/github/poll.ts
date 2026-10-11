import { formatUri } from "@storage/core";
import type { ServerConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { GitHubApp } from "./app.js";
import { applyPullRequest } from "./bindings.js";

/** Polls GitHub for the state of bound pull requests that webhooks haven't reported (docs/specs/bindings.md). */

const BATCH = 100;

interface Due {
  id: string;
  org_id: string;
  installation_id: string;
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
  deps: { db: Db; githubApp: GitHubApp | null; config: Pick<ServerConfig, "githubPollIntervalSeconds"> },
  now: Date,
): Promise<number> {
  const { db, githubApp } = deps;
  if (githubApp === null) {
    return 0;
  }
  const cutoff = new Date(now.getTime() - deps.config.githubPollIntervalSeconds * 1000).toISOString();
  const columns = ["id", "org_id", "installation_id", "target", "owner", "repo", "number"] as const;

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
    const key = `${row.installation_id}:${row.owner}/${row.repo}#${row.number}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const orgIds = [...new Set([...groups.values()].flat().map((row) => row.org_id))];
  const orgs =
    orgIds.length === 0 ? [] : await db.selectFrom("orgs").select(["id", "slug"]).where("id", "in", orgIds).execute();
  const slugs = new Map(orgs.map((org) => [org.id, org.slug]));
  const linked =
    orgIds.length === 0
      ? []
      : await db
          .selectFrom("github_installations")
          .select(["org_id", "installation_id"])
          .where("org_id", "in", orgIds)
          .execute();
  const links = new Set(linked.map((row) => `${row.org_id}:${row.installation_id}`));

  let polled = 0;
  const mark = async (rows: Due[], pollError: string | null) => {
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

  for (const all of groups.values()) {
    // A group can span orgs, and only the orgs that still link the installation may read through it.
    const rows: Due[] = [];
    for (const row of all) {
      if (links.has(`${row.org_id}:${row.installation_id}`)) {
        rows.push(row);
      } else {
        const org = formatUri({ org: slugs.get(row.org_id) ?? row.org_id });
        await mark([row], `The GitHub installation for ${row.target} was removed from ${org}.`);
      }
    }
    const first = rows[0];
    if (first === undefined) {
      continue;
    }

    try {
      const result = await githubApp.pull(first.installation_id, first.owner, first.repo, first.number);
      if (result.ok) {
        await applyPullRequest(
          db,
          { installationId: first.installation_id, owner: first.owner, repo: first.repo, number: first.number },
          result.pull,
          "poll",
          now,
        );
        await mark(rows, null);
      } else {
        await mark(rows, `GitHub returned ${result.status} for ${first.target}.`);
      }
    } catch (error) {
      console.warn(`Couldn't poll ${first.target}:`, error);
      await mark(rows, `Couldn't reach GitHub for ${first.target}.`);
    }
  }
  return polled;
}
