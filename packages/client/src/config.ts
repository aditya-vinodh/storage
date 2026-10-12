import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StorageError } from "@storage/core";
import { parse, stringify } from "smol-toml";

/** The hosted server. Self-hosted servers are picked with `storage login --server` or STORAGE_SERVER. */
export const DEFAULT_SERVER = "https://api.storage.adityaone.com";
export const DEFAULT_PROFILE = "default";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface ClientConfig {
  /** Base URL of the Storage server. No trailing slash. */
  server: string;
  token: string | undefined;
  /** Root for local state; downloads are cached under `<home>/cache`. */
  home: string;
  profile: string;
  serverSource: "STORAGE_SERVER" | "profile" | "default";
  tokenSource: "STORAGE_TOKEN" | "credentials" | "none";
  configFile: string;
  credentialsFile: string;
}

/** `config.toml`: profiles and which one is the default. Safe to share; holds no secrets. */
interface ConfigFile {
  default_profile?: string;
  profiles?: Record<string, { server?: string }>;
}

/** `credentials.toml`, mode 0600: one token per profile. */
interface CredentialsFile {
  profiles?: Record<string, { token?: string }>;
}

export function configDir(env: NodeJS.ProcessEnv): string {
  if (env.STORAGE_CONFIG_DIR) {
    return resolve(env.STORAGE_CONFIG_DIR);
  }
  if (process.platform === "win32" && env.APPDATA) {
    return join(env.APPDATA, "storage");
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "storage");
}

function readToml<T>(file: string): T {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {} as T;
    }
    throw error;
  }
  try {
    return parse(text) as T;
  } catch (error) {
    throw new StorageError("invalid_argument", `Can't parse ${file}: ${(error as Error).message}`);
  }
}

/** Writes through a temporary file so a crash can't leave a truncated file behind. */
function writeToml(file: string, value: object, mode: number): void {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, stringify(value), { mode, flag: "wx" });
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  chmodSync(file, mode);
}

function normalizeServer(server: string): string {
  return server.replace(/\/+$/, "");
}

export function checkProfileName(profile: string): string {
  if (!PROFILE_PATTERN.test(profile)) {
    throw new StorageError(
      "invalid_argument",
      `Invalid profile name "${profile}".`,
      "Use letters, digits, - and _, up to 64 characters.",
    );
  }
  return profile;
}

/**
 * Resolves the server, token, and profile. Environment variables win over the
 * profile. A stored token is only used for its own profile's server, so
 * pointing STORAGE_SERVER somewhere else never sends it to that server.
 */
export function loadClientConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { profile?: string } = {},
): ClientConfig {
  const dir = configDir(env);
  const configFile = join(dir, "config.toml");
  const credentialsFile = join(dir, "credentials.toml");
  const config = readToml<ConfigFile>(configFile);
  const profile = checkProfileName(options.profile || env.STORAGE_PROFILE || config.default_profile || DEFAULT_PROFILE);
  const profileServer = config.profiles?.[profile]?.server;

  const envServer = env.STORAGE_SERVER ? normalizeServer(env.STORAGE_SERVER) : undefined;
  const server = envServer ?? (profileServer ? normalizeServer(profileServer) : DEFAULT_SERVER);
  const serverSource = envServer ? "STORAGE_SERVER" : profileServer ? "profile" : "default";

  let token: string | undefined = env.STORAGE_TOKEN || undefined;
  let tokenSource: ClientConfig["tokenSource"] = token ? "STORAGE_TOKEN" : "none";
  const servesProfile = profileServer !== undefined && normalizeServer(profileServer) === server;
  if (token === undefined && servesProfile) {
    token = readToml<CredentialsFile>(credentialsFile).profiles?.[profile]?.token || undefined;
    tokenSource = token ? "credentials" : "none";
  }

  return {
    server,
    token,
    home: resolve(env.STORAGE_HOME || join(homedir(), ".storage")),
    profile,
    serverSource,
    tokenSource,
    configFile,
    credentialsFile,
  };
}

/** Saves the profile's server and token, making it the default profile if there is none yet. */
export function saveLogin(env: NodeJS.ProcessEnv, login: { profile: string; server: string; token: string }): void {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const configFile = join(dir, "config.toml");
  const credentialsFile = join(dir, "credentials.toml");

  const config = readToml<ConfigFile>(configFile);
  config.profiles ??= {};
  config.profiles[login.profile] = { ...config.profiles[login.profile], server: normalizeServer(login.server) };
  config.default_profile ??= login.profile;
  writeToml(configFile, config, 0o644);

  const credentials = readToml<CredentialsFile>(credentialsFile);
  credentials.profiles ??= {};
  credentials.profiles[login.profile] = { token: login.token };
  writeToml(credentialsFile, credentials, 0o600);
}

/** Removes the profile's stored token. Returns false if there was none. */
export function removeLogin(env: NodeJS.ProcessEnv, profile: string): boolean {
  const credentialsFile = join(configDir(env), "credentials.toml");
  const credentials = readToml<CredentialsFile>(credentialsFile);
  if (!credentials.profiles?.[profile]?.token) {
    return false;
  }
  delete credentials.profiles[profile];
  writeToml(credentialsFile, credentials, 0o600);
  return true;
}
