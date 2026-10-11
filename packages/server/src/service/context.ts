import type { OperationSpec } from "@storage/core";
import type { z } from "zod";
import type { Principal } from "../auth.js";
import type { BlobStore } from "../blobs/store.js";
import type { ServerConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { GitHubConnector } from "../signin/github.js";

export type ServiceConfig = Pick<
  ServerConfig,
  "maxFileSize" | "uploadTtlSeconds" | "downloadTtlSeconds" | "mcpMaxUploadBytes" | "inlineMaxBytes" | "linkMaxDays"
>;

/** Connecting GitHub accounts. Null unless GitHub and a Google sign-in provider are both configured. */
export type ConnectConfig = { github: GitHubConnector; publicUrl: string } | null;

export interface ServiceDeps {
  db: Db;
  blobs: BlobStore;
  config: ServiceConfig;
  connect: ConnectConfig;
  now?: () => Date;
}

export interface ServiceContext {
  db: Db;
  blobs: BlobStore;
  config: ServiceConfig;
  principal: Principal;
  connect: ConnectConfig;
  now: () => Date;
}

export interface RegisteredHandler {
  spec: OperationSpec;
  run(input: unknown, ctx: ServiceContext): Promise<unknown>;
}

/** Binds a server-side implementation to an operation spec, typed by the spec's input and output schemas. */
export function handle<S extends OperationSpec>(
  spec: S,
  run: (input: z.output<S["input"]>, ctx: ServiceContext) => Promise<z.input<S["output"]>>,
): RegisteredHandler {
  return { spec, run: run as RegisteredHandler["run"] };
}
