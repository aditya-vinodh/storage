import { describe, expect, it } from "vitest";
import { PUBLIC_OPERATIONS, TOOL_NAMES, toolAllowed } from "./index.js";

describe("toolAllowed", () => {
  it("allows everything without a list", () => {
    expect(toolAllowed(null, "delete")).toBe(true);
  });

  it("always allows whoami and token management", () => {
    for (const op of ["whoami", "token_create", "token_list", "token_revoke"]) {
      expect(toolAllowed([], op), op).toBe(true);
    }
  });

  it("maps internal operations to the public tools that use them", () => {
    expect(toolAllowed(["put"], "upload_initiate")).toBe(true);
    expect(toolAllowed(["push"], "upload_commit")).toBe(true);
    expect(toolAllowed(["get"], "upload_commit")).toBe(false);
    expect(toolAllowed(["pull"], "download_url")).toBe(true);
    expect(toolAllowed(["put"], "download_url")).toBe(false);
  });

  it("otherwise requires the operation to be listed", () => {
    expect(toolAllowed(["list"], "list")).toBe(true);
    expect(toolAllowed(["list"], "delete")).toBe(false);
  });

  it("TOOL_NAMES matches the public operations", () => {
    expect([...TOOL_NAMES].sort()).toEqual(PUBLIC_OPERATIONS.map((op) => op.name).sort());
  });
});
