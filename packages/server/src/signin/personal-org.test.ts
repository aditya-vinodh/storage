import { describe, expect, it } from "vitest";
import { personalOrgSlug } from "./shared.js";

describe("personalOrgSlug", () => {
  it("lowercases the local part and turns other characters into hyphens", () => {
    expect(personalOrgSlug("Jane.Doe+work@gmail.com")).toBe("jane-doe-work");
  });

  it("trims hyphens and caps the length at 40", () => {
    expect(personalOrgSlug("..x..@gmail.com")).toBe("x");
    expect(personalOrgSlug(`${"a".repeat(39)}.b@gmail.com`)).toBe("a".repeat(39));
  });

  it("falls back to user when nothing usable is left", () => {
    expect(personalOrgSlug("+++@gmail.com")).toBe("user");
  });
});
