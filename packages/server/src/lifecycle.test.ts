import type { LifecycleRule } from "@storage/core";
import { describe, expect, it } from "vitest";
import { durationMs, governingDeleteRule, keepVersionsFor } from "./lifecycle.js";

const DAY = 24 * 60 * 60 * 1000;
const CREATED = "2026-01-01T00:00:00.000Z";

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
    const got = governingDeleteRule(rules, "keep/x.txt", CREATED);
    expect(got?.rule.prefix).toBe("keep/");
    expect(got?.dueAt.getTime()).toBe(new Date(CREATED).getTime() + 3650 * DAY);
    expect(governingDeleteRule(rules, "other.txt", CREATED)?.rule.prefix).toBe("");
  });

  it("picks the earliest due among equal prefixes", () => {
    const rules: LifecycleRule[] = [
      { prefix: "videos/", delete_after: "10d" },
      { prefix: "videos/", delete_after: "2d" },
      { prefix: "videos/", delete_after: "5d" },
    ];
    const got = governingDeleteRule(rules, "videos/a.mp4", CREATED);
    expect(got?.rule.delete_after).toBe("2d");
    expect(got?.dueAt.getTime()).toBe(new Date(CREATED).getTime() + 2 * DAY);
  });

  it("returns null when nothing matches and ignores keep rules", () => {
    const rules: LifecycleRule[] = [
      { prefix: "videos/", delete_after: "2d" },
      { prefix: "", keep_versions: 3 },
    ];
    expect(governingDeleteRule(rules, "docs/a.txt", CREATED)).toBeNull();
    expect(governingDeleteRule([{ prefix: "", keep_versions: 3 }], "a.txt", CREATED)).toBeNull();
    expect(governingDeleteRule([], "a.txt", CREATED)).toBeNull();
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
