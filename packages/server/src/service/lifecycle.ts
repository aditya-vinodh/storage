import {
  type BindingEvent,
  formatUri,
  type LifecycleRule,
  normalizePath,
  ops,
  type ParsedUri,
  parseUriOfKind,
  type Role,
  StorageError,
} from "@storage/core";
import { recordAudit } from "../audit.js";
import { roleOnOrg } from "../auth.js";
import { toBinding } from "../github/bindings.js";
import {
  type DeleteRule,
  dueAt,
  durationMs,
  governingDeleteRule,
  isDeleteRule,
  parseRules,
  type RuleTimes,
} from "../lifecycle.js";
import { handle, type ServiceContext } from "./context.js";
import { type CollectionRow, collectionUri, findOrg, requireRole, resolveCollection } from "./resolve.js";

type RuleKey = { prefix: string; delete_after?: string; delete_after_event?: { event: BindingEvent; after: string } };

const ruleKey = (rule: RuleKey) =>
  JSON.stringify([rule.prefix, rule.delete_after, rule.delete_after_event?.event, rule.delete_after_event?.after]);

/** The shape both operations return for a collection, apart from `changed`. */
async function describeRules(
  ctx: ServiceContext,
  uri: string,
  collection: CollectionRow,
  rulesJson: string,
  times: RuleTimes,
  bindingRow: Parameters<typeof toBinding>[0] | undefined,
) {
  const rules = parseRules(rulesJson);
  const deleteRules = rules.filter(isDeleteRule);
  const now = ctx.now();

  const dated = new Map<string, { rule: DeleteRule; at: Date }>();
  const undated = new Map<string, DeleteRule>();
  for (const rule of deleteRules) {
    const id = ruleKey(rule);
    if (dated.has(id) || undated.has(id)) {
      continue;
    }
    const at = dueAt(rule, times);
    if (at === null) {
      undated.set(id, rule);
    } else {
      dated.set(id, { rule, at });
    }
  }

  const counts = new Map<string, number>();
  const waitingCounts = new Map<string, number>();
  if (deleteRules.length > 0) {
    const rows = await ctx.db
      .selectFrom("objects")
      .select("path")
      .where("collection_id", "=", collection.id)
      .where("deleted_at", "is", null)
      .execute();
    // If a waiting rule's event happened now, the objects it would govern are the ones it would win.
    const hypothetical = new Map<string, RuleTimes>();
    for (const [id, rule] of undated) {
      const event = (rule.delete_after_event as NonNullable<typeof rule.delete_after_event>).event;
      const at = now.toISOString();
      hypothetical.set(id, event === "binding.closed" ? { ...times, closedAt: at } : { ...times, mergedAt: at });
    }
    for (const row of rows) {
      const governing = governingDeleteRule(rules, row.path, times);
      if (governing) {
        const id = ruleKey(governing.rule);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      for (const [id, whatIf] of hypothetical) {
        if (ruleKey(governingDeleteRule(rules, row.path, whatIf)?.rule ?? { prefix: "\0" }) === id) {
          waitingCounts.set(id, (waitingCounts.get(id) ?? 0) + 1);
        }
      }
    }
  }

  const scheduled: {
    prefix: string;
    delete_after?: string;
    delete_after_event?: { event: BindingEvent; after: string };
    at: string;
    due: boolean;
    objects: number;
  }[] = [];
  for (const [id, { rule, at }] of dated) {
    const due = at <= now;
    const objects = counts.get(id) ?? 0;
    if (due && objects === 0) {
      continue;
    }
    scheduled.push({
      prefix: rule.prefix,
      ...(rule.delete_after !== undefined
        ? { delete_after: rule.delete_after }
        : { delete_after_event: rule.delete_after_event }),
      at: at.toISOString(),
      due,
      objects,
    });
  }
  scheduled.sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0,
  );
  const waiting = [...undated].map(([id, rule]) => {
    const { event, after } = rule.delete_after_event as NonNullable<typeof rule.delete_after_event>;
    return { prefix: rule.prefix, event, after, objects: waitingCounts.get(id) ?? 0 };
  });
  const first = scheduled.find((entry) => !entry.due && entry.objects > 0);
  const next = first ? { prefix: first.prefix, at: first.at, objects: first.objects } : null;
  return { uri, rules, scheduled, waiting, next, binding: bindingRow ? toBinding(bindingRow) : null };
}

async function collectionDetails(ctx: ServiceContext, collection: CollectionRow) {
  const bindingRow = await ctx.db
    .selectFrom("bindings")
    .selectAll()
    .where("collection_id", "=", collection.id)
    .executeTakeFirst();
  const times: RuleTimes = {
    createdAt: collection.created_at,
    closedAt: bindingRow?.closed_at ?? null,
    mergedAt: bindingRow?.merged_at ?? null,
  };
  return { times, bindingRow };
}

/** The org an org URI names, for the org default rules. Scoped tokens never reach them. */
async function resolveOrg(ctx: ServiceContext, uri: ParsedUri, need: Role) {
  const display = formatUri({ org: uri.org });
  // Needs no lookup, so it can't reveal whether the org exists.
  if (ctx.principal.token.scopes !== null) {
    throw new StorageError(
      "forbidden",
      "Scoped tokens can't read or change org default lifecycle rules.",
      "Use an unscoped token (from storage login).",
    );
  }
  const org = await findOrg(ctx, uri.org);
  const role = org ? await roleOnOrg(ctx.db, ctx.principal, org.id) : null;
  if (!org || role === null) {
    throw new StorageError("not_found", `Org ${display} not found.`);
  }
  requireRole(role, need, display);
  return { org, display };
}

const orgOutput = (uri: string, rules: LifecycleRule[]) => ({
  uri,
  rules,
  scheduled: [],
  waiting: [],
  next: null,
  binding: null,
});

export const lifecycleHandler = handle(ops.lifecycle, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["org", "collection"]);
  if (uri.collection === null) {
    const { org, display } = await resolveOrg(ctx, uri, "reader");
    return orgOutput(display, parseRules(org.default_lifecycle_rules));
  }
  const { org, collection } = await resolveCollection(ctx, uri, "reader");
  const { times, bindingRow } = await collectionDetails(ctx, collection);
  return describeRules(
    ctx,
    collectionUri(org.slug, collection.slug),
    collection,
    collection.lifecycle_rules,
    times,
    bindingRow,
  );
});

export const setLifecycleHandler = handle(ops.setLifecycle, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["org", "collection"]);
  const target =
    uri.collection === null
      ? { ...(await resolveOrg(ctx, uri, "admin")), collection: null }
      : await resolveCollection(ctx, uri, "admin").then((resolved) => ({
          ...resolved,
          display: collectionUri(resolved.org.slug, resolved.collection.slug),
        }));
  const { org, collection, display } = target;

  const rules = input.rules.map((rule) => {
    const { path, isPrefix } = normalizePath(rule.prefix);
    if (path !== "" && !isPrefix) {
      throw new StorageError("invalid_argument", `Rule prefix "${rule.prefix}" must end with /.`);
    }
    if (rule.delete_after !== undefined) {
      durationMs(rule.delete_after);
      return { prefix: path, delete_after: rule.delete_after };
    }
    if (rule.delete_after_event !== undefined) {
      const { event, after } = rule.delete_after_event;
      durationMs(after);
      return { prefix: path, delete_after_event: { event, after } };
    }
    return { prefix: path, keep_versions: rule.keep_versions as number };
  });
  const json = JSON.stringify(rules);

  const changed = await ctx.db.transaction().execute(async (trx) => {
    const current =
      collection === null
        ? await trx
            .selectFrom("orgs")
            .select("default_lifecycle_rules as lifecycle_rules")
            .where("id", "=", org.id)
            .executeTakeFirstOrThrow()
        : await trx
            .selectFrom("collections")
            .select("lifecycle_rules")
            .where("id", "=", collection.id)
            .executeTakeFirstOrThrow();
    if (current.lifecycle_rules === json) {
      return false;
    }
    const now = ctx.now();
    if (collection === null) {
      await trx.updateTable("orgs").set({ default_lifecycle_rules: json }).where("id", "=", org.id).execute();
    } else {
      await trx
        .updateTable("collections")
        .set({ lifecycle_rules: json, updated_at: now.toISOString() })
        .where("id", "=", collection.id)
        .execute();
    }
    await recordAudit(trx, ctx.principal, now, {
      orgId: org.id,
      action: "lifecycle.set",
      target: display,
      detail: { rules, previous: parseRules(current.lifecycle_rules) },
    });
    return true;
  });

  if (collection === null) {
    return { ...orgOutput(display, rules), changed };
  }
  const { times, bindingRow } = await collectionDetails(ctx, collection);
  return { ...(await describeRules(ctx, display, collection, json, times, bindingRow)), changed };
});
