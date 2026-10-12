import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configDir, loadClientConfig, removeLogin, saveLogin } from "./config.js";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "storage-config-"));
  env = { STORAGE_CONFIG_DIR: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("configDir", () => {
  it("prefers STORAGE_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(configDir({ STORAGE_CONFIG_DIR: "/a", XDG_CONFIG_HOME: "/b" })).toBe("/a");
    if (process.platform !== "win32") {
      expect(configDir({ XDG_CONFIG_HOME: "/b" })).toBe("/b/storage");
      expect(configDir({})).toBe(join(homedir(), ".config", "storage"));
    }
  });
});

describe("loadClientConfig", () => {
  it("falls back to the default server with no files or environment", () => {
    expect(loadClientConfig(env)).toMatchObject({
      server: "https://api.storage.adityaone.com",
      token: undefined,
      profile: "default",
      serverSource: "default",
      tokenSource: "none",
    });
  });

  it("lets STORAGE_TOKEN and STORAGE_SERVER override the profile", () => {
    saveLogin(env, { profile: "default", server: "https://a.test", token: "saved" });
    expect(loadClientConfig({ ...env, STORAGE_TOKEN: "env" })).toMatchObject({
      server: "https://a.test",
      token: "env",
      tokenSource: "STORAGE_TOKEN",
    });
    expect(loadClientConfig({ ...env, STORAGE_SERVER: "https://a.test///" })).toMatchObject({
      token: "saved",
      serverSource: "STORAGE_SERVER",
    });
    expect(loadClientConfig({ ...env, STORAGE_SERVER: "https://b.test" })).toMatchObject({
      server: "https://b.test",
      token: undefined,
      tokenSource: "none",
    });
  });

  it("reports unparseable files as invalid arguments", () => {
    writeFileSync(join(dir, "config.toml"), "profiles = [");
    expect(() => loadClientConfig(env)).toThrow(expect.objectContaining({ code: "invalid_argument" }));
  });

  it("rejects profile names that could escape a TOML table or path", () => {
    expect(() => loadClientConfig(env, { profile: "a.b" })).toThrow(/Invalid profile name/);
    expect(() => loadClientConfig({ ...env, STORAGE_PROFILE: "-x" })).toThrow(/Invalid profile name/);
  });
});

describe("saveLogin and removeLogin", () => {
  it("adds profiles without touching others and keeps the first as the default", () => {
    saveLogin(env, { profile: "work", server: "https://a.test/", token: "t1" });
    saveLogin(env, { profile: "ci", server: "https://b.test", token: "t2" });

    expect(loadClientConfig(env)).toMatchObject({ profile: "work", server: "https://a.test", token: "t1" });
    expect(loadClientConfig(env, { profile: "ci" })).toMatchObject({ server: "https://b.test", token: "t2" });
    expect(readFileSync(join(dir, "config.toml"), "utf8")).not.toMatch(/t1|t2/);
    expect(readdirSync(dir).sort()).toEqual(["config.toml", "credentials.toml"]);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "credentials.toml")).mode & 0o777).toBe(0o600);
    }

    expect(removeLogin(env, "work")).toBe(true);
    expect(removeLogin(env, "work")).toBe(false);
    expect(loadClientConfig(env)).toMatchObject({ profile: "work", server: "https://a.test", token: undefined });
    expect(loadClientConfig(env, { profile: "ci" }).token).toBe("t2");
  });
});
