import type { LifecycleRule } from "@storage/core";
import { describe, expect, it } from "vitest";
import { dueAt, governingDeleteRule, type RuleTimes } from "./lifecycle.js";

const DAY = 24 * 60 * 60 * 1000;
const CREATED = "2026-01-01T00:00:00.000Z";
const CLOSED = "2026-02-01T00:00:00.000Z";
const MERGED = "2026-02-02T00:00:00.000Z";

const OPEN: RuleTimes = { createdAt: CREATED, closedAt: null, mergedAt: null };
const CLOSED_ONLY: RuleTimes = { createdAt: CREATED, closedAt: CLOSED, mergedAt: null };
const MERGED_PR: RuleTimes = { createdAt: CREATED, closedAt: CLOSED, mergedAt: MERGED };

const closedRule = (prefix: string, after: string): LifecycleRule => ({
  prefix,
  delete_after_event: { event: "binding.closed", after },
});
const mergedRule = (prefix: string, after: string): LifecycleRule => ({
  prefix,
  delete_after_event: { event: "binding.merged", after },
});
const timeRule = (prefix: string, after: string): LifecycleRule => ({ prefix, delete_after: after });

const at = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms);

describe("dueAt with event rules", () => {
  it("is null for a closed rule until the PR closes, then closed_at plus after", () => {
    const rule = closedRule("", "7d") as Parameters<typeof dueAt>[0];
    expect(dueAt(rule, OPEN)).toBeNull();
    expect(dueAt(rule, CLOSED_ONLY)).toEqual(at(CLOSED, 7 * DAY));
    expect(dueAt(rule, MERGED_PR)).toEqual(at(CLOSED, 7 * DAY));
  });

  it("is null for a merged rule unless the PR merged, then merged_at plus after", () => {
    const rule = mergedRule("", "12h") as Parameters<typeof dueAt>[0];
    expect(dueAt(rule, OPEN)).toBeNull();
    expect(dueAt(rule, CLOSED_ONLY)).toBeNull();
    expect(dueAt(rule, MERGED_PR)).toEqual(at(MERGED, 12 * 3600 * 1000));
  });

  it("counts a time rule from creation regardless of events", () => {
    const rule = timeRule("", "3d") as Parameters<typeof dueAt>[0];
    expect(dueAt(rule, OPEN)).toEqual(at(CREATED, 3 * DAY));
    expect(dueAt(rule, MERGED_PR)).toEqual(at(CREATED, 3 * DAY));
  });
});

describe("governingDeleteRule with event rules", () => {
  it("returns null when no delete rule matches, ignoring keep rules", () => {
    expect(governingDeleteRule([{ prefix: "", keep_versions: 2 }], "a.txt", OPEN)).toBeNull();
    expect(governingDeleteRule([closedRule("videos/", "1d")], "a.txt", CLOSED_ONLY)).toBeNull();
  });

  it("returns an event rule with a null due time while the event hasn't happened", () => {
    const rule = closedRule("", "7d");
    const out = governingDeleteRule([rule], "a.txt", OPEN);
    expect(out?.rule).toEqual(rule);
    expect(out?.dueAt).toBeNull();
  });

  it("returns the due time once the event has happened", () => {
    const out = governingDeleteRule([closedRule("", "7d")], "a.txt", CLOSED_ONLY);
    expect(out?.dueAt).toEqual(at(CLOSED, 7 * DAY));
  });

  it("among equal prefixes picks the earlier due time across kinds", () => {
    const rules = [timeRule("", "90d"), closedRule("", "7d")];
    // closed + 7d (Feb 8) is before created + 90d (Apr 1).
    expect(governingDeleteRule(rules, "a.txt", CLOSED_ONLY)?.rule).toEqual(rules[1]);
    // created + 1d beats closed + 7d.
    const early = [closedRule("", "7d"), timeRule("", "1d")];
    expect(governingDeleteRule(early, "a.txt", CLOSED_ONLY)?.rule).toEqual(early[1]);
  });

  it("counts a rule with no due time as last among equal prefixes, in either order", () => {
    const time = timeRule("", "90d");
    const event = closedRule("", "7d");
    expect(governingDeleteRule([time, event], "a.txt", OPEN)?.rule).toEqual(time);
    expect(governingDeleteRule([event, time], "a.txt", OPEN)?.rule).toEqual(time);
    expect(governingDeleteRule([event, time], "a.txt", OPEN)?.dueAt).toEqual(at(CREATED, 90 * DAY));
  });

  it("returns a null-due rule when every equal-prefix rule is waiting", () => {
    const out = governingDeleteRule([closedRule("", "7d"), mergedRule("", "1d")], "a.txt", OPEN);
    expect(out).not.toBeNull();
    expect(out?.dueAt).toBeNull();
  });

  it("prefers the longest prefix even when it has no due time", () => {
    const keep = closedRule("keep/", "365d");
    const rules = [timeRule("", "1d"), keep];
    const out = governingDeleteRule(rules, "keep/x", OPEN);
    expect(out?.rule).toEqual(keep);
    expect(out?.dueAt).toBeNull();
    expect(governingDeleteRule(rules, "a.txt", OPEN)?.rule).toEqual(rules[0]);
  });
});
