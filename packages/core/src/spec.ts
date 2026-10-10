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
 * Where a public operation is offered. `local` is the CLI and the stdio MCP
 * server, which run on the caller's machine and can touch its files. `hosted`
 * is the MCP server on the API (design doc §9.4), which can't.
 */
export const SURFACES = ["local", "hosted"] as const;
export type Surface = (typeof SURFACES)[number];

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
  /** Surfaces that offer this operation. Defaults to every surface. */
  surfaces?: readonly Surface[];
  input: I;
  /**
   * Input on the hosted surface when it differs from `input`, because the
   * hosted server has no local files. The output is the same on every surface.
   */
  hostedInput?: InputSchema;
  /** Replaces `description` on the hosted surface. */
  hostedDescription?: string;
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

export function offeredOn(spec: OperationSpec, surface: Surface): boolean {
  return spec.visibility === "public" && (spec.surfaces ?? SURFACES).includes(surface);
}

/** The input schema callers use on `surface`. */
export function inputFor(spec: OperationSpec, surface: Surface): InputSchema {
  return surface === "hosted" ? (spec.hostedInput ?? spec.input) : spec.input;
}

/** The description callers see on `surface`. */
export function descriptionFor(spec: OperationSpec, surface: Surface): string {
  return surface === "hosted" ? (spec.hostedDescription ?? spec.description) : spec.description;
}
