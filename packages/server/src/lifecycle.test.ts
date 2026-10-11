import type { LifecycleRule } from "@storage/core";
import { describe, expect, it } from "vitest";
import { durationMs, governingDeleteRule, keepVersionsFor } from "./lifecycle.js";

const DAY = 24 * 60 * 60 * 1000;
const CREATED = "2026-01-01T00:00:00.000Z";
const TIMES = { createdAt: CREATED, closedAt: null, mergedAt: null };

function invalidArgument(value: string) {
  try {
    durationMs(value);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("durationMs", () => {
  it("parses days and hours", () => {
    expect(durationMs("7d")).toBe(7 * DAY);
    expect(durationMs("12h")).toBe(12 * 3600 * 1000);
    expect(durationMs("36500d")).toBe(36500 * DAY);
  });

  it("rejects out-of-range and malformed durations with invalid_argument", () => {
    for (const value of ["36501d", "0d", "7", "1w"]) {
      expect(invalidArgument(value), value).toBe("invalid_argument");
    }
  });
});

describe("governingDeleteRule", () => {
  it("prefers the longest prefix even when it is due later", () => {
    const rules: LifecycleRule[] = [
      { prefix: "", delete_after: "30d" },
      { prefix: "keep/", delete_after: "3650d" },
    ];
    const got = governingDeleteRule(rules, "keep/x.txt", TIMES);
    expect(got?.rule.prefix).toBe("keep/");
    expect(got?.dueAt?.getTime()).toBe(new Date(CREATED).getTime() + 3650 * DAY);
    expect(governingDeleteRule(rules, "other.txt", TIMES)?.rule.prefix).toBe("");
  });

  it("picks the earliest due among equal prefixes", () => {
    const rules: LifecycleRule[] = [
      { prefix: "videos/", delete_after: "10d" },
      { prefix: "videos/", delete_after: "2d" },
      { prefix: "videos/", delete_after: "5d" },
    ];
    const got = governingDeleteRule(rules, "videos/a.mp4", TIMES);
    expect(got?.rule.delete_after).toBe("2d");
    expect(got?.dueAt?.getTime()).toBe(new Date(CREATED).getTime() + 2 * DAY);
  });

  it("returns null when nothing matches and ignores keep rules", () => {
    const rules: LifecycleRule[] = [
      { prefix: "videos/", delete_after: "2d" },
      { prefix: "", keep_versions: 3 },
    ];
    expect(governingDeleteRule(rules, "docs/a.txt", TIMES)).toBeNull();
    expect(governingDeleteRule([{ prefix: "", keep_versions: 3 }], "a.txt", TIMES)).toBeNull();
    expect(governingDeleteRule([], "a.txt", TIMES)).toBeNull();
  });
});

describe("event rules", () => {
  const closed = { createdAt: CREATED, closedAt: "2026-02-01T00:00:00.000Z", mergedAt: null };

  it("is due at the event time plus after, and undated before the event", () => {
    const rule: LifecycleRule = { prefix: "", delete_after_event: { event: "binding.closed", after: "7d" } };
    expect(governingDeleteRule([rule], "a.txt", TIMES)?.dueAt).toBeNull();
    expect(governingDeleteRule([rule], "a.txt", closed)?.dueAt?.getTime()).toBe(
      new Date(closed.closedAt).getTime() + 7 * DAY,
    );
    const merged: LifecycleRule = { prefix: "", delete_after_event: { event: "binding.merged", after: "1d" } };
    expect(governingDeleteRule([merged], "a.txt", closed)?.dueAt).toBeNull();
  });

  it("lets a dated rule beat an undated one at the same prefix, and the first undated stay", () => {
    const waitingA: LifecycleRule = { prefix: "", delete_after_event: { event: "binding.merged", after: "1d" } };
    const waitingB: LifecycleRule = { prefix: "", delete_after_event: { event: "binding.merged", after: "2d" } };
    const dated: LifecycleRule = { prefix: "", delete_after: "90d" };
    expect(governingDeleteRule([waitingA, dated], "a.txt", TIMES)?.rule).toBe(dated);
    expect(governingDeleteRule([waitingA, waitingB], "a.txt", TIMES)?.rule).toBe(waitingA);
  });
});

describe("keepVersionsFor", () => {
  it("uses the longest matching prefix", () => {
    const rules: LifecycleRule[] = [
      { prefix: "", keep_versions: 1 },
      { prefix: "docs/", keep_versions: 3 },
    ];
    expect(keepVersionsFor(rules, "docs/a.txt")).toBe(3);
    expect(keepVersionsFor(rules, "a.txt")).toBe(1);
  });

  it("uses the smallest count among equal prefixes", () => {
    const rules: LifecycleRule[] = [
      { prefix: "docs/", keep_versions: 5 },
      { prefix: "docs/", keep_versions: 2 },
      { prefix: "docs/", delete_after: "1d" },
    ];
    expect(keepVersionsFor(rules, "docs/a.txt")).toBe(2);
  });

  it("returns null when no keep rule matches", () => {
    expect(keepVersionsFor([{ prefix: "docs/", keep_versions: 2 }], "a.txt")).toBeNull();
    expect(keepVersionsFor([{ prefix: "", delete_after: "1d" }], "a.txt")).toBeNull();
    expect(keepVersionsFor([], "a.txt")).toBeNull();
  });
});
