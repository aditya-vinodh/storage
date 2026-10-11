import { describe, expect, it } from "vitest";
import { describeRedirectTarget, isValidRedirectUri } from "./redirect-uri.js";

describe("isValidRedirectUri", () => {
  it.each([
    "https://example.com/cb",
    "https://example.com:8443/cb?x=1",
    "http://localhost:3000/cb",
    "http://127.0.0.1/cb",
    "http://[::1]:9/cb",
    "cursor://anysphere.cursor-retrieval/oauth/callback",
    "com.example.app:/oauth2redirect",
  ])("accepts %s", (uri) => {
    expect(isValidRedirectUri(uri)).toBe(true);
  });

  it.each([
    "",
    "not a url",
    "/relative",
    "http://example.com/cb",
    "http://localhost.evil.com/cb",
    "https://example.com/cb#frag",
    "https://user:pw@example.com/cb",
    "https://user@example.com/cb",
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "ftp://example.com/",
    "wss://example.com/",
    "https://exa mple.com/",
    "https://example.com/\ncb",
    `https://example.com/${"a".repeat(2000)}`,
  ])("rejects %j", (uri) => {
    expect(isValidRedirectUri(uri)).toBe(false);
  });
});

describe("describeRedirectTarget", () => {
  it("shows the host with port for http(s) and the scheme otherwise", () => {
    expect(describeRedirectTarget("https://example.com/cb")).toBe("example.com");
    expect(describeRedirectTarget("http://localhost:3000/cb")).toBe("localhost:3000");
    expect(describeRedirectTarget("cursor://x/y")).toBe("cursor:");
  });
});
