import { type Binding, formatUri, parseTarget, pullRequestUrl } from "@storage/core";
import type { Selectable } from "kysely";
import { recordAuditAs } from "../audit.js";
import type { Db } from "../db/index.js";
import type { BindingsTable } from "../db/schema.js";
import { collectionUri } from "../service/resolve.js";
import type { PullRequestState } from "./pulls.js";

/** Bindings to GitHub pull requests and the state updates webhooks and polling apply (docs/specs/bindings.md). */

export type BindingRow = Selectable<BindingsTable>;

/** The actor on audit events for state changes that GitHub reported. */
export const GITHUB_ACTOR = "system:github";

export function toBinding(row: BindingRow): Binding {
  return {
    target: row.target,
    url: pullRequestUrl(parseTarget(row.target)),
    state: row.state,
    closed_at: row.closed_at,
    merged_at: row.merged_at,
    updated_at: row.source_updated_at,
    poll_error: row.poll_error,
  };
}

/** The binding state columns for a pull request's state. */
export function pullState(pull: PullRequestState): {
  state: "open" | "closed" | "merged";
  closed_at: string | null;
  merged_at: string | null;
} {
  const state = pull.merged_at !== null ? "merged" : pull.state === "closed" ? "closed" : "open";
  return {
    state,
    closed_at: state === "open" ? null : (pull.closed_at ?? pull.merged_at ?? pull.updated_at),
    merged_at: state === "merged" ? pull.merged_at : null,
  };
}

const AUDIT_ACTIONS = { merged: "binding.merged", closed: "binding.closed", open: "binding.reopened" } as const;

/**
 * Applies a pull request's state to every binding of it, in any org (docs/specs/bindings.md). Each binding is
 * updated in its own transaction. Returns how many bindings were written; out-of-order updates are skipped.
 */
export async function applyPullRequest(
  db: Db,
  match: { installationId: string; owner: string; repo: string; number: number },
  pull: PullRequestState,
  source: "webhook" | "poll",
  now: Date,
): Promise<number> {
  const candidates = await db
    .selectFrom("bindings")
    .select("id")
    .where("installation_id", "=", match.installationId)
    .where("owner", "=", match.owner.toLowerCase())
    .where("repo", "=", match.repo.toLowerCase())
    .where("number", "=", match.number)
    .execute();
  const pullUpdated = new Date(pull.updated_at);

  let written = 0;
  for (const { id } of candidates) {
    const applied = await db.transaction().execute(async (trx) => {
      // Take the row lock first, so two deliveries for one pull request apply one after the other.
      await trx
        .updateTable("bindings")
        .set((eb) => ({ state: eb.ref("state") }))
        .where("id", "=", id)
        .execute();
      const row = await trx.selectFrom("bindings").selectAll().where("id", "=", id).executeTakeFirst();
      if (!row) {
        return false;
      }
      if (row.source_updated_at !== null && new Date(row.source_updated_at) > pullUpdated) {
        return false;
      }

      const { state, closed_at: closedAt, merged_at: mergedAt } = pullState(pull);
      await trx
        .updateTable("bindings")
        .set({ state, closed_at: closedAt, merged_at: mergedAt, source_updated_at: pull.updated_at })
        .where("id", "=", id)
        .execute();

      if (state !== row.state && !(row.state === "unknown" && state === "open")) {
        const collection = await trx
          .selectFrom("collections")
          .innerJoin("orgs", "orgs.id", "collections.org_id")
          .select(["collections.slug as collection", "orgs.slug as org"])
          .where("collections.id", "=", row.collection_id)
          .executeTakeFirstOrThrow();
        await recordAuditAs(trx, GITHUB_ACTOR, null, now, {
          orgId: row.org_id,
          action: AUDIT_ACTIONS[state],
          target: collectionUri(collection.org, collection.collection),
          detail: { target: row.target, source, at: mergedAt ?? closedAt ?? pull.updated_at },
        });
      }
      return true;
    });
    if (applied) {
      written += 1;
    }
  }
  return written;
}

/**
 * Removes every org's link to a GitHub installation, for example after GitHub reports it uninstalled. Audits
 * `github.uninstall` once per org, in the same transaction. Returns how many links were removed.
 */
export async function unlinkInstallation(db: Db, installationId: string, now: Date): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("github_installations")
      .innerJoin("orgs", "orgs.id", "github_installations.org_id")
      .select([
        "github_installations.id as id",
        "github_installations.org_id as org_id",
        "github_installations.account_login as account",
        "orgs.slug as slug",
      ])
      .where("github_installations.installation_id", "=", installationId)
      .execute();
    let removed = 0;
    for (const row of rows) {
      const deleted = await trx.deleteFrom("github_installations").where("id", "=", row.id).executeTakeFirst();
      if (Number(deleted.numDeletedRows) === 0) {
        continue;
      }
      removed += 1;
      await recordAuditAs(trx, GITHUB_ACTOR, null, now, {
        orgId: row.org_id,
        action: "github.uninstall",
        target: formatUri({ org: row.slug }),
        detail: { installation_id: installationId, account: row.account },
      });
    }
    return removed;
  });
}
