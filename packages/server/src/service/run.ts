import { StorageError } from "@storage/core";
import type { z } from "zod";
import type { RegisteredHandler, ServiceContext } from "./context.js";
import { rewriteShorthand } from "./shorthand.js";

export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

/**
 * Resolves a `gh-pr:` URI in `rawInput`, parses it with `inputSchema`, runs the handler, and checks its result
 * against the operation's output schema. Shared by the HTTP API and the hosted MCP server.
 */
export async function runHandler(
  handler: RegisteredHandler,
  inputSchema: z.ZodType,
  rawInput: unknown,
  ctx: ServiceContext,
): Promise<unknown> {
  const { name, output: outputSchema } = handler.spec;
  const input = inputSchema.safeParse(await rewriteShorthand(handler.spec, rawInput, ctx));
  if (!input.success) {
    throw new StorageError("invalid_argument", `Invalid input for ${name}: ${describeIssues(input.error)}`);
  }
  const result = await handler.run(input.data, ctx);
  const output = outputSchema.safeParse(result);
  if (!output.success) {
    throw new Error(`Handler for ${name} returned output that violates its schema: ${describeIssues(output.error)}`);
  }
  return output.data;
}
