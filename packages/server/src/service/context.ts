import type { OperationSpec } from "@storage/core";
import type { z } from "zod";
import type { Principal } from "../auth.js";
import type { BlobStore } from "../blobs/store.js";
import type { ServerConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { GitHubApp } from "../github/app.js";
import type { SecretBox } from "../secret-box.js";
import type { GitHubConnector } from "../signin/github.js";

export type ServiceConfig = Pick<
  ServerConfig,
  | "maxFileSize"
  | "uploadTtlSeconds"
  | "downloadTtlSeconds"
  | "mcpMaxUploadBytes"
  | "inlineMaxBytes"
  | "linkMaxDays"
  | "consumerDomains"
  | "githubMembershipTtlSeconds"
  | "deleteGraceDays"
  | "githubApp"
  | "githubPollIntervalSeconds"
>;

/** Connecting GitHub accounts. Null unless GitHub and a Google sign-in provider are both configured. */
export type ConnectConfig = { github: GitHubConnector; publicUrl: string; box: SecretBox } | null;

export interface ServiceDeps {
  db: Db;
  blobs: BlobStore;
  config: ServiceConfig;
  connect: ConnectConfig;
  /** Null unless the GitHub App is configured (docs/specs/bindings.md). */
  githubApp: GitHubApp | null;
  /** The server's public URL for browser links. Null without browser sign-in. */
  publicUrl: string | null;
  now?: () => Date;
}

export interface ServiceContext {
  db: Db;
  blobs: BlobStore;
  config: ServiceConfig;
  principal: Principal;
  connect: ConnectConfig;
  githubApp: GitHubApp | null;
  publicUrl: string | null;
  /** True when a Google sign-in provider is configured. */
  googleSignIn: boolean;
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
