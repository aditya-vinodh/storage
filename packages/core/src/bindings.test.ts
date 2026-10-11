import { describe, expect, it } from "vitest";
import { formatTarget, parseTarget, pullRequestUrl } from "./bindings.js";

function codeOf(input: string): string | undefined {
  try {
    parseTarget(input);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("parseTarget", () => {
  it("parses a target and lowercases owner and repo", () => {
    expect(parseTarget("github:Acme/Web#482")).toEqual({ kind: "github", owner: "acme", repo: "web", number: 482 });
  });

  it("accepts dots, underscores and hyphens in repo names and inner hyphens in owners", () => {
    expect(parseTarget("github:my-org/my_repo.js-x#1")).toMatchObject({ owner: "my-org", repo: "my_repo.js-x" });
    expect(parseTarget("github:a/b#1")).toMatchObject({ owner: "a", repo: "b" });
  });

  it("accepts the length and number limits", () => {
    expect(parseTarget(`github:${"a".repeat(39)}/${"r".repeat(100)}#2147483647`).number).toBe(2147483647);
  });

  const invalid = [
    "github:acme/web",
    "github:acme#1",
    "gh:acme/web#1",
    "github:acme/web#0",
    "github:acme/web#01",
    "github:acme/web#-1",
    "github:acme/web#2147483648",
    "github:-acme/web#1",
    "github:acme-/web#1",
    "github:ac_me/web#1",
    `github:${"a".repeat(40)}/web#1`,
    `github:acme/${"r".repeat(101)}#1`,
    "github:acme/..#1",
    "github:acme/.#1",
    "github:acme/web/extra#1",
    "github:acme/we b#1",
    "github:acme/web#1 ",
    "",
  ];
  for (const input of invalid) {
    it(`rejects "${input.length > 60 ? `${input.slice(0, 20)}...` : input}" with invalid_argument and a hint`, () => {
      expect(codeOf(input)).toBe("invalid_argument");
    });
  }

  it("includes the example in the hint", () => {
    try {
      parseTarget("nope");
      expect.unreachable();
    } catch (error) {
      expect((error as { hint?: string }).hint).toBe("Targets look like github:acme/web#482.");
    }
  });
});

describe("formatTarget and pullRequestUrl", () => {
  it("round-trips a parsed target in normalized form", () => {
    expect(formatTarget(parseTarget("github:Acme/Web#482"))).toBe("github:acme/web#482");
  });

  it("builds the pull request URL", () => {
    expect(pullRequestUrl(parseTarget("github:Acme/Web#482"))).toBe("https://github.com/acme/web/pull/482");
  });
});
