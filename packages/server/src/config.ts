import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ServerConfig {
  /** Public base URL of the API, used to build signed transfer URLs. No trailing slash. */
  publicUrl: string;
  host: string;
  port: number;
  dataDir: string;
  /** `sqlite:<path>` or `sqlite::memory:`. */
  databaseUrl: string;
  blobDir: string;
  signingSecret: string;
  maxFileSize: number;
  uploadTtlSeconds: number;
  downloadTtlSeconds: number;
}

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 ** 3;

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
    blobDir: resolve(env.STORAGE_BLOB_DIR || join(dataDir, "blobs")),
    signingSecret: resolveSigningSecret(env, dataDir),
    maxFileSize: intFromEnv(env, "STORAGE_MAX_FILE_SIZE", DEFAULT_MAX_FILE_SIZE),
    uploadTtlSeconds: intFromEnv(env, "STORAGE_UPLOAD_TTL_SECONDS", 3600),
    downloadTtlSeconds: intFromEnv(env, "STORAGE_DOWNLOAD_TTL_SECONDS", 300),
  };
}
