import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
