import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_INLINE_MAX_BYTES } from "@storage/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "storage-config-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const load = (env: Record<string, string>) =>
  loadConfig({ STORAGE_DATA_DIR: dataDir, STORAGE_SIGNING_SECRET: "s".repeat(32), ...env });

describe("loadConfig blob driver", () => {
  it("defaults to the filesystem driver under the data directory", () => {
    expect(load({}).blobs).toEqual({ driver: "fs", dir: join(dataDir, "blobs") });
  });

  it("reads S3 settings and defaults to path-style addressing when an endpoint is set", () => {
    expect(
      load({
        STORAGE_BLOB_DRIVER: "s3",
        STORAGE_S3_BUCKET: "artifacts",
        STORAGE_S3_ENDPOINT: "http://rustfs:9000",
        STORAGE_S3_PUBLIC_ENDPOINT: "http://localhost:9000",
        STORAGE_S3_ACCESS_KEY_ID: "key",
        STORAGE_S3_SECRET_ACCESS_KEY: "secret",
        STORAGE_S3_CREATE_BUCKET: "true",
      }).blobs,
    ).toEqual({
      driver: "s3",
      bucket: "artifacts",
      region: "us-east-1",
      endpoint: "http://rustfs:9000",
      publicEndpoint: "http://localhost:9000",
      forcePathStyle: true,
      credentials: { accessKeyId: "key", secretAccessKey: "secret" },
      createBucket: true,
    });
  });

  it("uses virtual-hosted addressing and the default credential chain for AWS S3", () => {
    expect(load({ STORAGE_BLOB_DRIVER: "s3", STORAGE_S3_BUCKET: "artifacts", AWS_REGION: "eu-west-1" }).blobs).toEqual({
      driver: "s3",
      bucket: "artifacts",
      region: "eu-west-1",
      endpoint: undefined,
      publicEndpoint: undefined,
      forcePathStyle: false,
      credentials: undefined,
      createBucket: false,
    });
  });

  it("rejects incomplete or invalid settings", () => {
    expect(() => load({ STORAGE_BLOB_DRIVER: "gcs" })).toThrow(/fs or s3/);
    expect(() => load({ STORAGE_BLOB_DRIVER: "s3" })).toThrow(/STORAGE_S3_BUCKET/);
    expect(() =>
      load({ STORAGE_BLOB_DRIVER: "s3", STORAGE_S3_BUCKET: "b", STORAGE_S3_ACCESS_KEY_ID: "only-key" }),
    ).toThrow(/both/);
    expect(() =>
      load({ STORAGE_BLOB_DRIVER: "s3", STORAGE_S3_BUCKET: "b", STORAGE_S3_CREATE_BUCKET: "maybe" }),
    ).toThrow(/true or false/);
  });
});

describe("loadConfig share link limit", () => {
  it("defaults to 30 days", () => {
    expect(load({}).linkMaxDays).toBe(30);
  });

  it("accepts 0 to disable links and rejects negative or non-numeric values", () => {
    expect(load({ STORAGE_LINK_MAX_DAYS: "0" }).linkMaxDays).toBe(0);
    expect(load({ STORAGE_LINK_MAX_DAYS: "7" }).linkMaxDays).toBe(7);
    expect(() => load({ STORAGE_LINK_MAX_DAYS: "-1" })).toThrow(/STORAGE_LINK_MAX_DAYS/);
    expect(() => load({ STORAGE_LINK_MAX_DAYS: "abc" })).toThrow(/STORAGE_LINK_MAX_DAYS/);
  });
});

describe("loadConfig sign-in", () => {
  it("defaults to no providers", () => {
    expect(load({}).signIn).toEqual({ github: null, google: null });
  });

  it("requires both or neither of a provider's client id and secret", () => {
    expect(() => load({ STORAGE_GITHUB_CLIENT_ID: "id" })).toThrow(/STORAGE_GITHUB_CLIENT_ID/);
    expect(() => load({ STORAGE_GITHUB_CLIENT_SECRET: "secret" })).toThrow(/STORAGE_GITHUB_CLIENT_ID/);
    const google = { STORAGE_GOOGLE_CLIENT_ID: "gid", STORAGE_GOOGLE_CLIENT_SECRET: "gsecret" };
    expect(
      load({ ...google, STORAGE_GITHUB_CLIENT_ID: "id", STORAGE_GITHUB_CLIENT_SECRET: "secret" }).signIn.github,
    ).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("rejects GitHub without Google", () => {
    expect(() => load({ STORAGE_GITHUB_CLIENT_ID: "id", STORAGE_GITHUB_CLIENT_SECRET: "secret" })).toThrow(
      "STORAGE_GITHUB_CLIENT_ID needs Google sign-in (STORAGE_GOOGLE_CLIENT_ID).",
    );
  });

  it("trims and lowercases Google allowed domains", () => {
    const config = load({
      STORAGE_GOOGLE_CLIENT_ID: "id",
      STORAGE_GOOGLE_CLIENT_SECRET: "secret",
      STORAGE_GOOGLE_ALLOWED_DOMAINS: " Acme.com , ,Example.ORG",
    });
    expect(config.signIn.google).toEqual({
      clientId: "id",
      clientSecret: "secret",
      allowedDomains: ["acme.com", "example.org"],
    });
  });

  it("rejects allowed domains without Google configured", () => {
    expect(() => load({ STORAGE_GOOGLE_ALLOWED_DOMAINS: "acme.com" })).toThrow(/STORAGE_GOOGLE_ALLOWED_DOMAINS/);
  });
});

describe("loadConfig hosted MCP limits", () => {
  it("defaults to a 10 MiB upload cap and the core inline cap", () => {
    const config = load({});
    expect(config.mcpMaxUploadBytes).toBe(10 * 1024 * 1024);
    expect(config.inlineMaxBytes).toBe(DEFAULT_INLINE_MAX_BYTES);
  });

  it("reads both limits from the environment", () => {
    const config = load({ STORAGE_MCP_MAX_UPLOAD_BYTES: "4096", STORAGE_INLINE_MAX_BYTES: "1024" });
    expect(config.mcpMaxUploadBytes).toBe(4096);
    expect(config.inlineMaxBytes).toBe(1024);
    expect(() => load({ STORAGE_MCP_MAX_UPLOAD_BYTES: "0" })).toThrow(/STORAGE_MCP_MAX_UPLOAD_BYTES/);
  });
});
