import { describe, expect, it } from "vitest";
import { StorageError } from "./errors.js";
import { formatUri, parseUri, parseUriOfKind } from "./uri.js";

const SHA = "9f2c".padEnd(64, "0");

describe("parseUri", () => {
  it("parses each URI kind", () => {
    expect(parseUri("storage://acme/")).toMatchObject({ org: "acme", collection: null, kind: "org" });
    expect(parseUri("storage://acme/pr-482")).toMatchObject({ collection: "pr-482", path: "", kind: "collection" });
    expect(parseUri("storage://acme/pr-482/")).toMatchObject({ collection: "pr-482", path: "", kind: "collection" });
    expect(parseUri("storage://acme/pr-482/screenshots/")).toMatchObject({ path: "screenshots/", kind: "prefix" });
    expect(parseUri("storage://acme/pr-482/screenshots/after.png")).toMatchObject({
      path: "screenshots/after.png",
      kind: "object",
      version: null,
    });
  });

  it("parses version selectors", () => {
    expect(parseUri("storage://acme/pr-482/a.png@3").version).toEqual({ kind: "number", version: 3 });
    expect(parseUri(`storage://acme/pr-482/a.png@sha256:${SHA}`).version).toEqual({ kind: "sha256", sha256: SHA });
  });

  it("keeps @ inside paths when it isn't a version suffix", () => {
    const parsed = parseUri("storage://acme/c/node_modules/@scope/pkg.json");
    expect(parsed.path).toBe("node_modules/@scope/pkg.json");
    expect(parsed.version).toBeNull();
  });

  it("rejects malformed URIs", () => {
    for (const bad of [
      "s3://acme/c/x",
      "storage://Acme/c/x",
      "storage://acme/c_d/x",
      "storage://acme/c/../x",
      "storage://acme/c//x",
      "storage://acme/c/dir/@3",
      "gh-pr:acme/web#482/",
    ]) {
      expect(() => parseUri(bad), bad).toThrow(StorageError);
    }
  });

  it("round-trips through formatUri", () => {
    for (const uri of ["storage://acme/", "storage://acme/pr-482/", "storage://acme/pr-482/a/b.png@7"]) {
      expect(formatUri(parseUri(uri))).toBe(uri);
    }
  });
});

describe("parseUriOfKind", () => {
  it("explains a kind mismatch", () => {
    expect(() => parseUriOfKind("storage://acme/c/dir", ["prefix", "collection"])).toThrow(
      'Expected a prefix or collection URI, got an object URI: "storage://acme/c/dir".',
    );
  });
});
