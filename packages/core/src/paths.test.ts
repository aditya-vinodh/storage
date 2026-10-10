import { describe, expect, it } from "vitest";
import { basename, MAX_PATH_SEGMENTS, normalizePath } from "./paths.js";

describe("normalizePath", () => {
  it("strips leading slashes and keeps trailing ones as prefixes", () => {
    expect(normalizePath("/a/b.png")).toEqual({ path: "a/b.png", isPrefix: false });
    expect(normalizePath("a/b/")).toEqual({ path: "a/b/", isPrefix: true });
    expect(normalizePath("")).toEqual({ path: "", isPrefix: true });
    expect(normalizePath("/")).toEqual({ path: "", isPrefix: true });
  });

  it("is case-sensitive and accepts UTF-8", () => {
    expect(normalizePath("Shots/Ünïcødé.png").path).toBe("Shots/Ünïcødé.png");
  });

  it("rejects unsafe paths", () => {
    for (const bad of ["a//b", "a/./b", "../a", "a/..", "a\\b", "a\u0000b", "a\nb"]) {
      expect(() => normalizePath(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("enforces segment and byte limits", () => {
    expect(() =>
      normalizePath(
        Array(MAX_PATH_SEGMENTS + 1)
          .fill("a")
          .join("/"),
      ),
    ).toThrow(/segments/);
    expect(() => normalizePath("é".repeat(513))).toThrow(/bytes/);
  });
});

describe("basename", () => {
  it("returns the last segment", () => {
    expect(basename("a/b/c.png")).toBe("c.png");
    expect(basename("c.png")).toBe("c.png");
    expect(basename("a/b/")).toBe("b");
  });
});
