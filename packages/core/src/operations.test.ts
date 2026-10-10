import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OPERATIONS, PUBLIC_OPERATIONS } from "./operations.js";

describe("operation spec", () => {
  it("has unique names", () => {
    const names = OPERATIONS.map((op) => op.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(OPERATIONS.map((op) => [op.name, op] as const))(
    "%s converts to JSON Schema for both transports",
    (_name, op) => {
      const input = z.toJSONSchema(op.input, { io: "input" }) as { type: string; properties?: Record<string, unknown> };
      expect(input.type).toBe("object");
      for (const field of op.positional ?? []) {
        expect(input.properties).toHaveProperty(field);
      }
      expect(() => z.toJSONSchema(op.output)).not.toThrow();
    },
  );

  it("marks write operations with a role and destructive ones explicitly", () => {
    for (const op of PUBLIC_OPERATIONS) {
      if (op.access === "write") {
        expect(op.role, op.name).toBeDefined();
      }
    }
    expect(PUBLIC_OPERATIONS.find((op) => op.name === "delete")?.destructive).toBe(true);
  });
});
