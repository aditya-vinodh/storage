import { type LifecycleRule, lifecycleRuleSchema, StorageError } from "@storage/core";
import { z } from "zod";
import type { Db } from "./db/index.js";

/** Rule evaluation shared by the lifecycle operations, the write checks and the worker (docs/specs/lifecycle-rules.md). */

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const MAX_DURATION_DAYS = 36500;

export type DeleteRule = LifecycleRule & ({ delete_after: string } | { delete_after_event: object });

/** Milliseconds in a `<n>d` or `<n>h` duration. Throws `invalid_argument` for anything else or above the cap. */
export function durationMs(value: string): number {
  const match = /^([1-9][0-9]{0,5})([dh])$/.exec(value);
  const ms = match ? Number(match[1]) * (match[2] === "d" ? DAY_MS : HOUR_MS) : Number.NaN;
  if (!Number.isFinite(ms) || ms > MAX_DURATION_DAYS * DAY_MS) {
    throw new StorageError(
      "invalid_argument",
      `"${value}" isn't a valid duration.`,
      `Use <n>d or <n>h, up to ${MAX_DURATION_DAYS}d, for example 7d or 12h.`,
    );
  }
  return ms;
}

const storedRules = z.array(lifecycleRuleSchema);

/** Reads `collections.lifecycle_rules`. */
export function parseRules(json: string): LifecycleRule[] {
  return storedRules.parse(JSON.parse(json));
}

/** The collection times delete rules count from. Event times are null until the binding's event happens. */
export interface RuleTimes {
  createdAt: string;
  closedAt: string | null;
  mergedAt: string | null;
}

/** Reads the collection's binding times (nulls if it has no binding). */
export async function ruleTimes(db: Db, collection: { id: string; created_at: string }): Promise<RuleTimes> {
  const binding = await db
    .selectFrom("bindings")
    .select(["closed_at", "merged_at"])
    .where("collection_id", "=", collection.id)
    .executeTakeFirst();
  return {
    createdAt: collection.created_at,
    closedAt: binding?.closed_at ?? null,
    mergedAt: binding?.merged_at ?? null,
  };
}

/**
 * When a delete rule is due: the collection's creation plus `delete_after`, or the binding event's time plus
 * `after`. Null while the event hasn't happened.
 */
export function dueAt(rule: DeleteRule, times: RuleTimes): Date | null {
  if (rule.delete_after !== undefined) {
    return new Date(new Date(times.createdAt).getTime() + durationMs(rule.delete_after));
  }
  const { event, after } = rule.delete_after_event as NonNullable<LifecycleRule["delete_after_event"]>;
  const at = event === "binding.closed" ? times.closedAt : times.mergedAt;
  return at === null ? null : new Date(new Date(at).getTime() + durationMs(after));
}

export function isDeleteRule(rule: LifecycleRule): rule is DeleteRule {
  return rule.delete_after !== undefined || rule.delete_after_event !== undefined;
}

/**
 * The delete rule that governs `path`: the matching rule with the longest prefix, and among rules with that
 * prefix the one due earliest. A rule with no due time counts as due last. Null when no delete rule matches.
 */
export function governingDeleteRule(
  rules: readonly LifecycleRule[],
  path: string,
  times: RuleTimes,
): { rule: DeleteRule; dueAt: Date | null } | null {
  let best: { rule: DeleteRule; dueAt: Date | null } | null = null;
  for (const rule of rules) {
    if (!isDeleteRule(rule) || !path.startsWith(rule.prefix)) {
      continue;
    }
    const at = dueAt(rule, times);
    if (
      best === null ||
      rule.prefix.length > best.rule.prefix.length ||
      (rule.prefix.length === best.rule.prefix.length && at !== null && (best.dueAt === null || at < best.dueAt))
    ) {
      best = { rule, dueAt: at };
    }
  }
  return best;
}

/** How many versions `path` keeps: the matching keep rule with the longest prefix, the smallest count among equals. */
export function keepVersionsFor(rules: readonly LifecycleRule[], path: string): number | null {
  let best: { prefix: string; keep: number } | null = null;
  for (const rule of rules) {
    if (rule.keep_versions === undefined || !path.startsWith(rule.prefix)) {
      continue;
    }
    if (
      best === null ||
      rule.prefix.length > best.prefix.length ||
      (rule.prefix.length === best.prefix.length && rule.keep_versions < best.keep)
    ) {
      best = { prefix: rule.prefix, keep: rule.keep_versions };
    }
  }
  return best?.keep ?? null;
}

/** How a rule's prefix is shown in messages: `(all)` for the whole collection. */
export function prefixLabel(prefix: string): string {
  return prefix === "" ? "(all)" : prefix;
}

/**
 * Throws `precondition_failed` if a due delete rule governs `path`, since the worker would delete whatever is
 * written or restored there on its next pass.
 */
export function assertNotExpired(
  collection: { lifecycle_rules: string },
  times: RuleTimes,
  collectionUri: string,
  path: string,
  now: Date,
): void {
  const governing = governingDeleteRule(parseRules(collection.lifecycle_rules), path, times);
  if (governing?.dueAt && governing.dueAt <= now) {
    throw new StorageError(
      "precondition_failed",
      `Lifecycle rule ${prefixLabel(governing.rule.prefix)} deleted ${collectionUri}${governing.rule.prefix} on ${governing.dueAt.toISOString()}.`,
      "Change the rules with set-lifecycle to write here.",
    );
  }
}
