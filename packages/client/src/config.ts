import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ClientConfig {
  /** Base URL of the Storage server. No trailing slash. */
  server: string;
  token: string | undefined;
  /** Root for local state; downloads are cached under `<home>/cache`. */
  home: string;
}

export const DEFAULT_SERVER = "http://localhost:8787";

export function loadClientConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  return {
    server: (env.STORAGE_SERVER || DEFAULT_SERVER).replace(/\/+$/, ""),
    token: env.STORAGE_TOKEN || undefined,
    home: resolve(env.STORAGE_HOME || join(homedir(), ".storage")),
  };
}
