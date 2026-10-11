import {
  type BindingTarget,
  formatTarget,
  formatUri,
  ops,
  parseTarget,
  parseUriOfKind,
  StorageError,
} from "@storage/core";
import { recordAudit } from "../audit.js";
import type { Db } from "../db/index.js";
import type { GitHubApp } from "../github/app.js";
import { type BindingRow, pullState, toBinding } from "../github/bindings.js";
import type { PullRequestState, PullResult } from "../github/pulls.js";
import { newId } from "../ids.js";
import { handle, type ServiceContext } from "./context.js";
import { retryOnUniqueViolation } from "./grants.js";
import { collectionUri, resolveCollection } from "./resolve.js";

export type Reader = Pick<Db, "selectFrom">;

/** The collection's existing binding if it's this target (a no-op bind), a conflict error if it's anything else. */
export async function checkConflicts(
  db: Reader,
  org: { id: string; slug: string },
  collection: { id: string },
  display: string,
  target: string,
): Promise<BindingRow | null> {
  const existing = await db
    .selectFrom("bindings")
    .selectAll()
    .where("collection_id", "=", collection.id)
    .executeTakeFirst();
  if (existing) {
    if (existing.target === target) {
      return existing;
    }
    throw new StorageError(
      "conflict",
      `Collection ${display} is already bound to ${existing.target}.`,
      `Run storage unbind ${display} first.`,
    );
  }

  const holder = await db
    .selectFrom("bindings")
    .innerJoin("collections", "collections.id", "bindings.collection_id")
    .select("collections.slug")
    .where("bindings.org_id", "=", org.id)
    .where("bindings.target", "=", target)
    .executeTakeFirst();
  if (holder) {
    throw new StorageError("conflict", `${target} is already bound to ${collectionUri(org.slug, holder.slug)}.`);
  }
  return null;
}

/**
 * Reads a pull request through an org's installation, with `bind`'s errors: a 404 or 403 means the app can't see
 * it, anything else is unavailable.
 */
export async function readPull(
  githubApp: GitHubApp,
  installationId: string,
  parsed: BindingTarget,
  orgUri: string,
): Promise<PullRequestState> {
  const target = formatTarget(parsed);
  let result: PullResult;
  try {
    result = await githubApp.pull(installationId, parsed.owner, parsed.repo, parsed.number);
  } catch (error) {
    console.warn(`Couldn't read ${target} from GitHub:`, error);
    throw new StorageError("unavailable", `Couldn't read ${target} from GitHub. Try again.`);
  }
  if (!result.ok) {
    if (result.status === 404 || result.status === 403) {
      throw new StorageError(
        "not_found",
        `${target} isn't visible to the GitHub App in ${orgUri}.`,
        "Add the repository to the app's installation on GitHub.",
      );
    }
    throw new StorageError("unavailable", `Couldn't read ${target} from GitHub. Try again.`);
  }
  return result.pull;
}

/** Inserts a binding that starts at the pull request's current state, and audits `binding.create`. */
export async function insertBinding(
  trx: Db,
  ctx: ServiceContext,
  options: {
    orgId: string;
    collectionId: string;
    display: string;
    target: BindingTarget;
    pull: PullRequestState;
    installationId: string;
  },
): Promise<BindingRow> {
  const { target: parsed, pull } = options;
  const target = formatTarget(parsed);
  const now = ctx.now();
  const row = {
    id: newId("bnd"),
    org_id: options.orgId,
    collection_id: options.collectionId,
    kind: "github" as const,
    target,
    owner: parsed.owner,
    repo: parsed.repo,
    number: parsed.number,
    ...pullState(pull),
    source_updated_at: pull.updated_at,
    polled_at: now.toISOString(),
    poll_error: null,
    installation_id: options.installationId,
    created_by: ctx.principal.id,
    created_at: now.toISOString(),
  };
  await trx.insertInto("bindings").values(row).execute();
  await recordAudit(trx, ctx.principal, now, {
    orgId: options.orgId,
    action: "binding.create",
    target: options.display,
    detail: { target },
  });
  return row;
}

export const bindHandler = handle(ops.bind, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["collection"]);
  const { org, collection } = await resolveCollection(ctx, uri, "writer");
  const display = collectionUri(org.slug, collection.slug);
  const parsed = parseTarget(input.target);
  const target = formatTarget(parsed);
  const orgUri = formatUri({ org: org.slug });

  const githubApp = ctx.githubApp;
  if (githubApp === null) {
    throw new StorageError("unavailable", "The GitHub App isn't configured on this server.");
  }

  // Cheap reads first, so a no-op or a conflict never costs a GitHub request.
  const bound = await checkConflicts(ctx.db, org, collection, display, target);
  if (bound) {
    return { uri: display, binding: toBinding(bound), changed: false };
  }

  const installation = await ctx.db
    .selectFrom("github_installations")
    .select("installation_id")
    .where("org_id", "=", org.id)
    .where("account_login", "=", parsed.owner)
    .executeTakeFirst();
  if (!installation) {
    throw new StorageError(
      "precondition_failed",
      `No GitHub installation in ${orgUri} covers ${parsed.owner}.`,
      `Install the app with: storage github install ${orgUri}`,
    );
  }

  const pull = await readPull(githubApp, installation.installation_id, parsed, orgUri);

  // A lost race on either unique index reruns the transaction, which then sees the winner's row and reports a conflict.
  return retryOnUniqueViolation(() =>
    ctx.db.transaction().execute(async (trx) => {
      const raced = await checkConflicts(trx, org, collection, display, target);
      if (raced) {
        return { uri: display, binding: toBinding(raced), changed: false };
      }

      const row = await insertBinding(trx, ctx, {
        orgId: org.id,
        collectionId: collection.id,
        display,
        target: parsed,
        pull,
        installationId: installation.installation_id,
      });
      return { uri: display, binding: toBinding(row), changed: true };
    }),
  );
});

export const unbindHandler = handle(ops.unbind, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["collection"]);
  const { org, collection } = await resolveCollection(ctx, uri, "writer");
  const display = collectionUri(org.slug, collection.slug);

  const changed = await ctx.db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom("bindings")
      .select(["id", "target"])
      .where("collection_id", "=", collection.id)
      .executeTakeFirst();
    if (!existing) {
      return false;
    }
    const deleted = await trx.deleteFrom("bindings").where("id", "=", existing.id).executeTakeFirst();
    if (Number(deleted.numDeletedRows) === 0) {
      return false;
    }
    await recordAudit(trx, ctx.principal, ctx.now(), {
      orgId: org.id,
      action: "binding.delete",
      target: display,
      detail: { target: existing.target },
    });
    return true;
  });

  return { uri: display, binding: null, changed };
});
