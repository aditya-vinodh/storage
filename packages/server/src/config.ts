import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_INLINE_MAX_BYTES } from "@storage/core";
import type { S3BlobStoreOptions } from "./blobs/s3.js";

export interface ServerConfig {
  /** Public base URL of the API, used to build signed transfer URLs. No trailing slash. */
  publicUrl: string;
  host: string;
  port: number;
  dataDir: string;
  /** `sqlite:<path>`, `sqlite::memory:`, or `postgres://user:password@host:port/database`. */
  databaseUrl: string;
  blobs: BlobConfig;
  signingSecret: string;
  maxFileSize: number;
  uploadTtlSeconds: number;
  downloadTtlSeconds: number;
  /** Largest file the hosted MCP `put` accepts, in raw bytes. */
  mcpMaxUploadBytes: number;
  /** Largest object the hosted MCP `get` returns inline, in raw bytes. */
  inlineMaxBytes: number;
  /** Longest a share link can last, in days. 0 disables share links. */
  linkMaxDays: number;
  /** Email domains `google-domain:` grants refuse, on top of the built-in consumer list. Lowercased. */
  consumerDomains: string[];
  /** How long cached GitHub org and team memberships stay valid. */
  githubMembershipTtlSeconds: number;
  /** Browser sign-in providers (design doc §8.1). Null means not configured. */
  signIn: {
    github: { clientId: string; clientSecret: string } | null;
    google: { clientId: string; clientSecret: string; allowedDomains: string[] | null } | null;
  };
}

export type BlobConfig = { driver: "fs"; dir: string } | ({ driver: "s3"; createBucket: boolean } & S3BlobStoreOptions);

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 ** 3;
const DEFAULT_MCP_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_LINK_MAX_DAYS = 30;

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  throw new Error(`${name} must be true or false, got "${env[name]}".`);
}

function blobConfigFromEnv(env: NodeJS.ProcessEnv, dataDir: string): BlobConfig {
  const driver = env.STORAGE_BLOB_DRIVER || "fs";
  if (driver === "fs") {
    return { driver, dir: resolve(env.STORAGE_BLOB_DIR || join(dataDir, "blobs")) };
  }
  if (driver !== "s3") {
    throw new Error(`STORAGE_BLOB_DRIVER must be fs or s3, got "${driver}".`);
  }
  const bucket = env.STORAGE_S3_BUCKET;
  if (!bucket) {
    throw new Error("STORAGE_S3_BUCKET is required when STORAGE_BLOB_DRIVER=s3.");
  }
  const accessKeyId = env.STORAGE_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.STORAGE_S3_SECRET_ACCESS_KEY;
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error("Set both STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY, or neither.");
  }
  const endpoint = env.STORAGE_S3_ENDPOINT || undefined;
  return {
    driver,
    bucket,
    region: env.STORAGE_S3_REGION || env.AWS_REGION || "us-east-1",
    endpoint,
    publicEndpoint: env.STORAGE_S3_PUBLIC_ENDPOINT || undefined,
    // S3-compatible stores (MinIO and others) usually only route path-style requests.
    forcePathStyle: boolFromEnv(env, "STORAGE_S3_FORCE_PATH_STYLE", endpoint !== undefined),
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    createBucket: boolFromEnv(env, "STORAGE_S3_CREATE_BUCKET", false),
  };
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}

function nonNegativeIntFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}".`);
  }
  return value;
}

function signInFromEnv(env: NodeJS.ProcessEnv): ServerConfig["signIn"] {
  const pair = (prefix: string): { clientId: string; clientSecret: string } | null => {
    const clientId = env[`${prefix}_CLIENT_ID`];
    const clientSecret = env[`${prefix}_CLIENT_SECRET`];
    if (Boolean(clientId) !== Boolean(clientSecret)) {
      throw new Error(`Set both ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET, or neither.`);
    }
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  };
  const github = pair("STORAGE_GITHUB");
  const googlePair = pair("STORAGE_GOOGLE");
  const domains = (env.STORAGE_GOOGLE_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain !== "");
  if (domains.length > 0 && googlePair === null) {
    throw new Error("STORAGE_GOOGLE_ALLOWED_DOMAINS needs STORAGE_GOOGLE_CLIENT_ID and STORAGE_GOOGLE_CLIENT_SECRET.");
  }
  if (github !== null && googlePair === null) {
    throw new Error("STORAGE_GITHUB_CLIENT_ID needs Google sign-in (STORAGE_GOOGLE_CLIENT_ID).");
  }
  return {
    github,
    google: googlePair ? { ...googlePair, allowedDomains: domains.length > 0 ? domains : null } : null,
  };
}

/** Reads the signing secret from the environment, or creates one in the data directory on first run. */
function resolveSigningSecret(env: NodeJS.ProcessEnv, dataDir: string): string {
  const fromEnv = env.STORAGE_SIGNING_SECRET;
  if (fromEnv) {
    if (fromEnv.length < 32) {
      throw new Error("STORAGE_SIGNING_SECRET must be at least 32 characters.");
    }
    return fromEnv;
  }
  const file = join(dataDir, "signing-secret");
  if (existsSync(file)) {
    return readFileSync(file, "utf8").trim();
  }
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = intFromEnv(env, "STORAGE_PORT", intFromEnv(env, "PORT", 8787));
  const host = env.STORAGE_HOST || "127.0.0.1";
  const dataDir = resolve(env.STORAGE_DATA_DIR || ".storage-data");
  mkdirSync(dataDir, { recursive: true });
  const publicUrl = (env.STORAGE_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, "");
  return {
    publicUrl,
    host,
    port,
    dataDir,
    databaseUrl: env.STORAGE_DATABASE_URL || `sqlite:${join(dataDir, "storage.db")}`,
    blobs: blobConfigFromEnv(env, dataDir),
    signingSecret: resolveSigningSecret(env, dataDir),
    maxFileSize: intFromEnv(env, "STORAGE_MAX_FILE_SIZE", DEFAULT_MAX_FILE_SIZE),
    uploadTtlSeconds: intFromEnv(env, "STORAGE_UPLOAD_TTL_SECONDS", 3600),
    downloadTtlSeconds: intFromEnv(env, "STORAGE_DOWNLOAD_TTL_SECONDS", 300),
    mcpMaxUploadBytes: intFromEnv(env, "STORAGE_MCP_MAX_UPLOAD_BYTES", DEFAULT_MCP_MAX_UPLOAD_BYTES),
    inlineMaxBytes: intFromEnv(env, "STORAGE_INLINE_MAX_BYTES", DEFAULT_INLINE_MAX_BYTES),
    linkMaxDays: nonNegativeIntFromEnv(env, "STORAGE_LINK_MAX_DAYS", DEFAULT_LINK_MAX_DAYS),
    consumerDomains: (env.STORAGE_CONSUMER_DOMAINS ?? "")
      .split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain !== ""),
    githubMembershipTtlSeconds: intFromEnv(env, "STORAGE_GITHUB_MEMBERSHIP_TTL_SECONDS", 3600),
    signIn: signInFromEnv(env),
  };
}
