import type { z } from "zod";

export const ROLES = ["reader", "writer", "admin"] as const;
export type Role = (typeof ROLES)[number];

export function roleAtLeast(have: Role, need: Role): boolean {
  return ROLES.indexOf(have) >= ROLES.indexOf(need);
}

export function highestRole(roles: Iterable<Role>): Role | null {
  let best: Role | null = null;
  for (const role of roles) {
    if (best === null || roleAtLeast(role, best)) {
      best = role;
    }
  }
  return best;
}

export function lowestRole(a: Role, b: Role): Role {
  return roleAtLeast(a, b) ? b : a;
}

// biome-ignore lint/suspicious/noExplicitAny: operation input shapes vary per operation
export type InputSchema = z.ZodObject<any>;

/**
 * One operation, defined once. The CLI commands and MCP tools are generated
 * from these definitions so the transports can't drift apart (design doc §10).
 */
export interface OperationSpec<I extends InputSchema = InputSchema, O extends z.ZodType = z.ZodType> {
  name: string;
  /** One line, shown in CLI help and as the MCP tool title. */
  summary: string;
  /** Written for agents. Used as the MCP tool description and the CLI long help. */
  description: string;
  access: "read" | "write";
  /** Minimum role on the target org or collection. Absent for operations without a target. */
  role?: Role;
  destructive?: boolean;
  /**
   * `public` operations are CLI commands and MCP tools. `internal` operations are
   * the wire protocol between clients and the server and are never exposed directly.
   */
  visibility: "public" | "internal";
  input: I;
  output: O;
  /** Input fields taken as positional CLI arguments, in order. */
  positional?: readonly (keyof z.input<I> & string)[];
}

export function defineOperation<I extends InputSchema, O extends z.ZodType>(
  spec: OperationSpec<I, O>,
): OperationSpec<I, O> {
  return spec;
}

export type OperationInput<S> = S extends OperationSpec<infer I, z.ZodType> ? z.input<I> : never;
export type OperationParsedInput<S> = S extends OperationSpec<infer I, z.ZodType> ? z.output<I> : never;
export type OperationOutput<S> = S extends OperationSpec<InputSchema, infer O> ? z.output<O> : never;
