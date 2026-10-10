import { describe, expect, it } from "vitest";
import { formatScope, parseScopeArg, StorageError, scopeMatches, scopeSchema } from "./index.js";

describe("scopeMatches", () => {
  it("supports * and ? globs in the collection part", () => {
    expect(scopeMatches("acme/pr-*", "acme", "pr-1")).toBe(true);
    expect(scopeMatches("acme/pr-*", "acme", "pr-")).toBe(true);
    expect(scopeMatches("acme/pr-*", "acme", "prx")).toBe(false);
    expect(scopeMatches("acme/pr-*", "other", "pr-1")).toBe(false);
    expect(scopeMatches("acme/*", "acme", "anything-at-all")).toBe(true);
    expect(scopeMatches("acme/*", "other", "docs")).toBe(false);
    expect(scopeMatches("acme/pr-?", "acme", "pr-1")).toBe(true);
    expect(scopeMatches("acme/pr-?", "acme", "pr-10")).toBe(false);
    expect(scopeMatches("acme/docs", "acme", "docs")).toBe(true);
    expect(scopeMatches("acme/docs", "acme", "docs2")).toBe(false);
    expect(scopeMatches("acme/docs", "acme", "xdocs")).toBe(false);
  });
});

describe("scopeSchema", () => {
  it("rejects malformed scopes", () => {
    for (const collection of ["acme", "acme/", "ACME/x", "acme/x_y", "acme/{a,b}", "*/x"]) {
      expect(scopeSchema.safeParse({ collection, role: "reader" }).success, collection).toBe(false);
    }
    expect(scopeSchema.safeParse({ collection: "acme/x", role: "owner" }).success).toBe(false);
  });

  it("accepts literal and glob scopes", () => {
    for (const collection of ["acme/*", "acme/pr-*", "acme/docs"]) {
      expect(scopeSchema.safeParse({ collection, role: "writer" }).success, collection).toBe(true);
    }
  });
});

describe("parseScopeArg", () => {
  it("parses <org>/<glob>:<role>", () => {
    const scope = parseScopeArg("acme/pr-*:writer");
    expect(scope).toEqual({ collection: "acme/pr-*", role: "writer" });
    expect(formatScope(scope)).toBe("acme/pr-*:writer");
  });

  it("rejects a missing or unknown role and a missing collection", () => {
    for (const arg of ["acme/pr-*", "acme/x:boss", ":reader"]) {
      let error: unknown;
      try {
        parseScopeArg(arg);
      } catch (e) {
        error = e;
      }
      expect(error, arg).toBeInstanceOf(StorageError);
      expect((error as StorageError).code).toBe("invalid_argument");
    }
  });
});
