import { type LifecycleRule, lifecycleRuleSchema, StorageError } from "@storage/core";
import { z } from "zod";

/** Rule evaluation shared by the lifecycle operations, the write checks and the worker (docs/specs/lifecycle-rules.md). */

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const MAX_DURATION_DAYS = 36500;

export type DeleteRule = LifecycleRule & { delete_after: string };

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

/** When a delete rule is due: the collection's creation plus `delete_after`. */
export function dueAt(rule: DeleteRule, collectionCreatedAt: string): Date {
  return new Date(new Date(collectionCreatedAt).getTime() + durationMs(rule.delete_after));
}

function isDeleteRule(rule: LifecycleRule): rule is DeleteRule {
  return rule.delete_after !== undefined;
}

/**
 * The delete rule that governs `path`: the matching rule with the longest prefix, and among rules with that
 * prefix the one due earliest. Null when no delete rule matches.
 */
export function governingDeleteRule(
  rules: readonly LifecycleRule[],
  path: string,
  collectionCreatedAt: string,
): { rule: DeleteRule; dueAt: Date } | null {
  let best: { rule: DeleteRule; dueAt: Date } | null = null;
  for (const rule of rules) {
    if (!isDeleteRule(rule) || !path.startsWith(rule.prefix)) {
      continue;
    }
    const at = dueAt(rule, collectionCreatedAt);
    if (
      best === null ||
      rule.prefix.length > best.rule.prefix.length ||
      (rule.prefix.length === best.rule.prefix.length && at < best.dueAt)
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
  collection: { lifecycle_rules: string; created_at: string },
  collectionUri: string,
  path: string,
  now: Date,
): void {
  const governing = governingDeleteRule(parseRules(collection.lifecycle_rules), path, collection.created_at);
  if (governing && governing.dueAt <= now) {
    throw new StorageError(
      "precondition_failed",
      `Lifecycle rule ${prefixLabel(governing.rule.prefix)} deleted ${collectionUri}${governing.rule.prefix} on ${governing.dueAt.toISOString()}.`,
      "Change the rules with set-lifecycle to write here.",
    );
  }
}
