import { type LifecycleRule, normalizePath, ops, parseUriOfKind, StorageError } from "@storage/core";
import { recordAudit } from "../audit.js";
import { dueAt, durationMs, governingDeleteRule, parseRules } from "../lifecycle.js";
import { handle, type ServiceContext } from "./context.js";
import { type CollectionRow, collectionUri, resolveCollection } from "./resolve.js";

/** The shape both operations return, apart from `changed`. */
async function describeRules(ctx: ServiceContext, uri: string, collection: CollectionRow, rulesJson: string) {
  const rules = parseRules(rulesJson);
  const deleteRules = rules.filter((rule) => rule.delete_after !== undefined);
  const counts = new Map<string, number>();
  const key = (rule: { prefix: string; delete_after?: string }) => JSON.stringify([rule.prefix, rule.delete_after]);
  if (deleteRules.length > 0) {
    const rows = await ctx.db
      .selectFrom("objects")
      .select("path")
      .where("collection_id", "=", collection.id)
      .where("deleted_at", "is", null)
      .execute();
    for (const row of rows) {
      const governing = governingDeleteRule(rules, row.path, collection.created_at);
      if (governing) {
        const id = key(governing.rule);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }

  const now = ctx.now();
  const seen = new Set<string>();
  const scheduled: { prefix: string; delete_after: string; at: string; due: boolean; objects: number }[] = [];
  for (const rule of deleteRules) {
    const id = key(rule);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const at = dueAt(rule as LifecycleRule & { delete_after: string }, collection.created_at);
    const due = at <= now;
    const objects = counts.get(id) ?? 0;
    if (due && objects === 0) {
      continue;
    }
    scheduled.push({
      prefix: rule.prefix,
      delete_after: rule.delete_after as string,
      at: at.toISOString(),
      due,
      objects,
    });
  }
  scheduled.sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0,
  );
  const first = scheduled.find((entry) => !entry.due && entry.objects > 0);
  const next = first ? { prefix: first.prefix, at: first.at, objects: first.objects } : null;
  return { uri, rules, scheduled, next };
}

export const lifecycleHandler = handle(ops.lifecycle, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["collection"]);
  const { org, collection } = await resolveCollection(ctx, uri, "reader");
  return describeRules(ctx, collectionUri(org.slug, collection.slug), collection, collection.lifecycle_rules);
});

export const setLifecycleHandler = handle(ops.setLifecycle, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["collection"]);
  const { org, collection } = await resolveCollection(ctx, uri, "admin");
  const display = collectionUri(org.slug, collection.slug);

  const rules = input.rules.map((rule) => {
    const { path, isPrefix } = normalizePath(rule.prefix);
    if (path !== "" && !isPrefix) {
      throw new StorageError("invalid_argument", `Rule prefix "${rule.prefix}" must end with /.`);
    }
    if (rule.delete_after !== undefined) {
      durationMs(rule.delete_after);
      return { prefix: path, delete_after: rule.delete_after };
    }
    return { prefix: path, keep_versions: rule.keep_versions as number };
  });
  const json = JSON.stringify(rules);

  const changed = await ctx.db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("collections")
      .select("lifecycle_rules")
      .where("id", "=", collection.id)
      .executeTakeFirstOrThrow();
    if (current.lifecycle_rules === json) {
      return false;
    }
    const now = ctx.now();
    await trx
      .updateTable("collections")
      .set({ lifecycle_rules: json, updated_at: now.toISOString() })
      .where("id", "=", collection.id)
      .execute();
    await recordAudit(trx, ctx.principal, now, {
      orgId: org.id,
      action: "lifecycle.set",
      target: display,
      detail: { rules, previous: parseRules(current.lifecycle_rules) },
    });
    return true;
  });

  return { ...(await describeRules(ctx, display, collection, json)), changed };
});
