import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { S3BlobStore } from "./s3.js";
import { blobKey } from "./store.js";

const endpoint = process.env.STORAGE_TEST_S3_ENDPOINT || undefined;

function testStore(): S3BlobStore {
  return new S3BlobStore({
    bucket: process.env.STORAGE_TEST_S3_BUCKET || "storage-test",
    region: "us-east-1",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.STORAGE_TEST_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.STORAGE_TEST_S3_SECRET_ACCESS_KEY ?? "",
    },
  });
}

function blob(content: string) {
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { content, sha256, key: blobKey(`org_${randomBytes(6).toString("hex")}`, sha256) };
}

const inAMinute = () => new Date(Date.now() + 60_000);

describe.skipIf(endpoint === undefined)("S3BlobStore (live, STORAGE_TEST_S3_ENDPOINT)", () => {
  it("uploads through a presigned PUT, stats, downloads as an attachment, and deletes", async () => {
    const store = testStore();
    await store.ensureBucket();
    const { content, sha256, key } = blob("hello, s3");
    expect(await store.stat(key)).toBeNull();

    const upload = await store.presignUpload(key, {
      size: content.length,
      sha256,
      contentType: "text/plain",
      expiresAt: inAMinute(),
    });
    expect(upload.url).toMatch(/^http:\/\/localhost:\d+\/storage-test\//);
    const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: content });
    expect(put.status).toBe(200);
    expect(await store.stat(key)).toEqual({ size: content.length });

    const download = await store.presignDownload(key, {
      contentType: "text/plain",
      filename: "notes 1.txt",
      expiresAt: inAMinute(),
    });
    const got = await fetch(download.url);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("text/plain");
    expect(got.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''notes%201.txt");
    expect(await got.text()).toBe(content);

    await store.delete(key);
    expect(await store.stat(key)).toBeNull();
  });

  it("makes the bucket reject bytes that don't match the declared size or sha256", async () => {
    const store = testStore();
    await store.ensureBucket();
    const { content, sha256, key } = blob("exact bytes");
    const upload = await store.presignUpload(key, {
      size: content.length,
      sha256,
      contentType: "text/plain",
      expiresAt: inAMinute(),
    });

    const tampered = "EXACT BYTES";
    expect(tampered.length).toBe(content.length);
    const wrongContent = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: tampered });
    expect(wrongContent.status).toBe(400);

    const wrongLength = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: `${content}!` });
    expect(wrongLength.ok).toBe(false);

    const { "x-amz-checksum-sha256": _checksum, ...withoutChecksum } = upload.headers;
    const noChecksum = await fetch(upload.url, { method: "PUT", headers: withoutChecksum, body: content });
    expect(noChecksum.ok).toBe(false);

    expect(await store.stat(key)).toBeNull();
  });

  it("refuses expired download links", async () => {
    const store = testStore();
    await store.ensureBucket();
    const { content, sha256, key } = blob("short-lived");
    const upload = await store.presignUpload(key, {
      size: content.length,
      sha256,
      contentType: "text/plain",
      expiresAt: inAMinute(),
    });
    expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body: content })).status).toBe(200);
    const download = await store.presignDownload(key, {
      contentType: "text/plain",
      filename: "a.txt",
      expiresAt: new Date(Date.now() + 1000),
    });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect((await fetch(download.url)).status).toBe(403);
  });
});
