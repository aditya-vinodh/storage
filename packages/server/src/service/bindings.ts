import { formatTarget, formatUri, ops, parseTarget, parseUriOfKind, StorageError } from "@storage/core";
import { recordAudit } from "../audit.js";
import type { Db } from "../db/index.js";
import { type BindingRow, pullState, toBinding } from "../github/bindings.js";
import type { PullResult } from "../github/pulls.js";
import { newId } from "../ids.js";
import { handle } from "./context.js";
import { retryOnUniqueViolation } from "./grants.js";
import { collectionUri, resolveCollection } from "./resolve.js";

type Reader = Pick<Db, "selectFrom">;

/** The collection's existing binding if it's this target (a no-op bind), a conflict error if it's anything else. */
async function checkConflicts(
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

  let result: PullResult;
  try {
    result = await githubApp.pull(installation.installation_id, parsed.owner, parsed.repo, parsed.number);
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
  const pull = result.pull;

  // A lost race on either unique index reruns the transaction, which then sees the winner's row and reports a conflict.
  return retryOnUniqueViolation(() =>
    ctx.db.transaction().execute(async (trx) => {
      const raced = await checkConflicts(trx, org, collection, display, target);
      if (raced) {
        return { uri: display, binding: toBinding(raced), changed: false };
      }

      const now = ctx.now();
      const row = {
        id: newId("bnd"),
        org_id: org.id,
        collection_id: collection.id,
        kind: "github" as const,
        target,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        ...pullState(pull),
        source_updated_at: pull.updated_at,
        polled_at: now.toISOString(),
        poll_error: null,
        installation_id: installation.installation_id,
        created_by: ctx.principal.id,
        created_at: now.toISOString(),
      };
      await trx.insertInto("bindings").values(row).execute();
      await recordAudit(trx, ctx.principal, now, {
        orgId: org.id,
        action: "binding.create",
        target: display,
        detail: { target },
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
