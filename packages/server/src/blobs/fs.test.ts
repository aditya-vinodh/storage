import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Signer } from "../signing.js";
import { FilesystemBlobStore, parseTransferToken } from "./fs.js";
import { blobKey } from "./store.js";

const signer = new Signer("s".repeat(32));
const content = "hello, blobs";
const sha256 = createHash("sha256").update(content).digest("hex");
const key = blobKey("org_test", sha256);

let root: string;
let store: FilesystemBlobStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "storage-fs-"));
  store = new FilesystemBlobStore({ root, publicUrl: "http://storage.test/", signer });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("FilesystemBlobStore", () => {
  it("writes, stats, reads, and deletes a blob", async () => {
    expect(await store.stat(key)).toBeNull();
    await store.write(key, Readable.from([content]), { size: content.length, sha256 });
    expect(await store.stat(key)).toEqual({ size: content.length });
    expect(await text(await store.read(key))).toBe(content);
    await store.delete(key);
    expect(await store.stat(key)).toBeNull();
  });

  it("lays blobs out by org and hash", () => {
    expect(key).toBe(`orgs/org_test/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`);
  });

  it("rejects content that doesn't match the declared hash or size, and leaves no files behind", async () => {
    await expect(store.write(key, Readable.from(["tampered!!!!"]), { size: content.length, sha256 })).rejects.toThrow(
      /sha256/,
    );
    await expect(store.write(key, Readable.from([content]), { size: content.length - 1, sha256 })).rejects.toThrow(
      /larger/,
    );
    await expect(store.write(key, Readable.from(["short"]), { size: content.length, sha256 })).rejects.toThrow(/bytes/);
    expect(await store.stat(key)).toBeNull();
    expect(await readdir(join(root, "tmp"))).toEqual([]);
  });

  it("refuses keys that could escape the root", async () => {
    await expect(store.stat("../etc/passwd")).rejects.toThrow(/Invalid blob key/);
    await expect(store.stat("orgs//x")).rejects.toThrow(/Invalid blob key/);
  });

  it("issues signed transfer URLs on this server", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const upload = await store.presignUpload(key, { size: 1, sha256, contentType: "text/plain", expiresAt });
    expect(upload.url.startsWith("http://storage.test/v1/blobs/")).toBe(true);
    const token = upload.url.slice("http://storage.test/v1/blobs/".length);
    expect(parseTransferToken(signer.verify(token))).toEqual({ op: "put", key, size: 1, sha256 });

    const download = await store.presignDownload(key, { contentType: "text/plain", filename: "a.txt", expiresAt });
    const downloadToken = download.url.slice("http://storage.test/v1/blobs/".length);
    expect(parseTransferToken(signer.verify(downloadToken))).toEqual({
      op: "get",
      key,
      content_type: "text/plain",
      filename: "a.txt",
    });
  });
});
