import { formatTarget, ops, parseTarget, parseUriOfKind, StorageError } from "@storage/core";
import { recordAudit } from "../audit.js";
import { toBinding } from "../github/bindings.js";
import { newId } from "../ids.js";
import { handle } from "./context.js";
import { retryOnUniqueViolation } from "./grants.js";
import { collectionUri, resolveCollection } from "./resolve.js";

export const bindHandler = handle(ops.bind, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["collection"]);
  const { org, collection } = await resolveCollection(ctx, uri, "writer");
  const display = collectionUri(org.slug, collection.slug);
  const parsed = parseTarget(input.target);
  const target = formatTarget(parsed);

  // A lost race on either unique index reruns the transaction, which then sees the winner's row and reports a conflict.
  return retryOnUniqueViolation(() =>
    ctx.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("bindings")
        .selectAll()
        .where("collection_id", "=", collection.id)
        .executeTakeFirst();
      if (existing) {
        if (existing.target === target) {
          return { uri: display, binding: toBinding(existing), changed: false };
        }
        throw new StorageError(
          "conflict",
          `Collection ${display} is already bound to ${existing.target}.`,
          `Run storage unbind ${display} first.`,
        );
      }

      const holder = await trx
        .selectFrom("bindings")
        .innerJoin("collections", "collections.id", "bindings.collection_id")
        .select("collections.slug")
        .where("bindings.org_id", "=", org.id)
        .where("bindings.target", "=", target)
        .executeTakeFirst();
      if (holder) {
        throw new StorageError("conflict", `${target} is already bound to ${collectionUri(org.slug, holder.slug)}.`);
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
        state: "unknown" as const,
        closed_at: null,
        merged_at: null,
        source_updated_at: null,
        polled_at: null,
        poll_error: null,
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
