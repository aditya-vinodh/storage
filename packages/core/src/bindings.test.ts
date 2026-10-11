import { describe, expect, it } from "vitest";
import { formatTarget, isShorthand, parseShorthand, parseTarget, pullRequestSlug, pullRequestUrl } from "./bindings.js";

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

function shorthandError(input: string): { code?: string; hint?: string } | undefined {
  try {
    parseShorthand(input);
  } catch (error) {
    return error as { code?: string; hint?: string };
  }
  return undefined;
}

describe("isShorthand", () => {
  it("recognizes the gh-pr: scheme only", () => {
    expect(isShorthand("gh-pr:acme/web#1")).toBe(true);
    expect(isShorthand("storage://acme/c/")).toBe(false);
    expect(isShorthand("GH-PR:acme/web#1")).toBe(false);
  });
});

describe("parseShorthand", () => {
  it("parses the number form with an empty rest, lowercasing owner and repo", () => {
    expect(parseShorthand("gh-pr:Acme/Web#482")).toEqual({
      owner: "acme",
      repo: "web",
      pr: { number: 482 },
      rest: "",
    });
    expect(parseShorthand("gh-pr:acme/web#482/")).toMatchObject({ pr: { number: 482 }, rest: "" });
  });

  it("parses the branch form", () => {
    expect(parseShorthand("gh-pr:acme/web@main/")).toEqual({
      owner: "acme",
      repo: "web",
      pr: { branch: "main" },
      rest: "",
    });
    expect(parseShorthand("gh-pr:acme/web@main")).toMatchObject({ pr: { branch: "main" }, rest: "" });
  });

  it("keeps the path and version after the first slash as rest", () => {
    expect(parseShorthand("gh-pr:acme/web#482/shots/a.png").rest).toBe("shots/a.png");
    expect(parseShorthand("gh-pr:acme/web#482/shots/a.png@3").rest).toBe("shots/a.png@3");
    expect(parseShorthand("gh-pr:acme/web@main/x.txt@3")).toMatchObject({ pr: { branch: "main" }, rest: "x.txt@3" });
  });

  it("decodes %2F in a branch and keeps the case of the branch", () => {
    expect(parseShorthand("gh-pr:acme/web@feature%2Flogin/x.txt")).toMatchObject({
      pr: { branch: "feature/login" },
      rest: "x.txt",
    });
    expect(parseShorthand("gh-pr:acme/web@Feature%2FLogin/")).toMatchObject({ pr: { branch: "Feature/Login" } });
  });

  it("accepts the number and length limits", () => {
    expect(parseShorthand("gh-pr:acme/web#2147483647").pr).toEqual({ number: 2147483647 });
    expect(parseShorthand(`gh-pr:acme/web@${"b".repeat(255)}`).pr).toEqual({ branch: "b".repeat(255) });
  });

  const invalid = [
    ["a missing number", "gh-pr:acme/web"],
    ["a missing number before a path", "gh-pr:acme/web/x.txt"],
    ["#0", "gh-pr:acme/web#0"],
    ["a leading zero", "gh-pr:acme/web#012"],
    ["a number above 2^31-1", "gh-pr:acme/web#2147483648"],
    ["an empty branch", "gh-pr:acme/web@/x"],
    ["an empty branch at the end", "gh-pr:acme/web@"],
    ["a branch over 255 characters", `gh-pr:acme/web@${"b".repeat(256)}`],
    ["an invalid percent encoding", "gh-pr:acme/web@bad%ZZ/"],
    ["a truncated percent encoding", "gh-pr:acme/web@bad%/"],
    ["a control character in the branch", "gh-pr:acme/web@a%00b/"],
    ["a dot repo", "gh-pr:acme/.#1"],
    ["a dotdot repo", "gh-pr:acme/..#1"],
    ["a missing repo", "gh-pr:acme#1"],
    ["a bad owner", "gh-pr:-acme/web#1"],
    ["another scheme", "github:acme/web#1"],
    ["a storage URI", "storage://acme/web/"],
    ["an empty string", ""],
  ] as const;
  for (const [name, input] of invalid) {
    it(`rejects ${name} with invalid_argument and the shorthand hint`, () => {
      const error = shorthandError(input);
      expect(error?.code).toBe("invalid_argument");
      expect(error?.hint).toContain("gh-pr:acme/web#482/");
    });
  }
});

describe("pullRequestSlug", () => {
  it("is <repo>-pr-<number> for a simple repo", () => {
    expect(pullRequestSlug("web", 482)).toBe("web-pr-482");
  });

  it("lowercases and collapses runs of other characters into one hyphen", () => {
    expect(pullRequestSlug("My.Web_App", 7)).toBe("my-web-app-pr-7");
    expect(pullRequestSlug("a..__--b", 1)).toBe("a-b-pr-1");
  });

  it("trims leading and trailing hyphens", () => {
    expect(pullRequestSlug(".web.", 3)).toBe("web-pr-3");
    expect(pullRequestSlug("-_web_-", 3)).toBe("web-pr-3");
  });

  it("cuts a long repo so the slug is at most 64 characters", () => {
    const slug = pullRequestSlug("r".repeat(100), 482);
    expect(slug).toBe(`${"r".repeat(64 - "-pr-482".length)}-pr-482`);
    expect(slug).toHaveLength(64);
  });

  it("trims a hyphen left at the cut", () => {
    // "-pr-12" is 6 characters, so 58 characters of base fit; the hyphen lands at position 58.
    const repo = `${"a".repeat(57)}.${"b".repeat(20)}`;
    const slug = pullRequestSlug(repo, 12);
    expect(slug).toBe(`${"a".repeat(57)}-pr-12`);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug).not.toContain("--");
  });

  it("falls back to pr-<number> when nothing is left", () => {
    expect(pullRequestSlug("...", 9)).toBe("pr-9");
    expect(pullRequestSlug("_-_", 12)).toBe("pr-12");
  });
});
