import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { StorageError } from "@storage/core";
import type {
  BlobStat,
  BlobStore,
  DownloadOptions,
  PresignedDownload,
  PresignedUpload,
  UploadConstraints,
} from "./store.js";

/** SigV4 presigned URLs can't outlive seven days. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 3600;

export interface S3BlobStoreOptions {
  bucket: string;
  region: string;
  /** API endpoint for S3-compatible stores. Omit for AWS S3. */
  endpoint?: string | undefined;
  /**
   * Endpoint written into presigned URLs, when clients reach the store at a
   * different address than the server does (for example inside docker-compose).
   * Defaults to `endpoint`.
   */
  publicEndpoint?: string | undefined;
  forcePathStyle: boolean;
  /** Static credentials. Omit to use the AWS SDK's default provider chain. */
  credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "NotFound" || e.name === "NoSuchKey" || e.name === "NoSuchBucket" || e.$metadata?.httpStatusCode === 404
  );
}

function expiresInSeconds(expiresAt: Date): number {
  return Math.min(MAX_PRESIGN_SECONDS, Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000)));
}

/**
 * Stores blobs in an S3-compatible bucket. Clients transfer bytes directly to
 * the bucket through presigned URLs; the bucket itself must not be public.
 */
export class S3BlobStore implements BlobStore {
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #presigner: S3Client;

  constructor(options: S3BlobStoreOptions) {
    const base: S3ClientConfig = {
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      // Otherwise the SDK adds CRC32 checksums of an empty body to presigned URLs.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      ...(options.credentials ? { credentials: options.credentials } : {}),
    };
    this.#bucket = options.bucket;
    this.#client = new S3Client({ ...base, ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
    const publicEndpoint = options.publicEndpoint ?? options.endpoint;
    this.#presigner =
      publicEndpoint === options.endpoint
        ? this.#client
        : new S3Client({ ...base, ...(publicEndpoint ? { endpoint: publicEndpoint } : {}) });
  }

  /** Creates the bucket if it doesn't exist. */
  async ensureBucket(): Promise<void> {
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      await this.#client.send(new CreateBucketCommand({ Bucket: this.#bucket }));
    }
  }

  async stat(key: string): Promise<BlobStat | null> {
    try {
      const head = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      return { size: head.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  async write(key: string, body: Readable, expected: { size: number; sha256: string }): Promise<void> {
    // Buffering in memory is fine because callers cap the payload size.
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > expected.size) {
        body.destroy();
        throw new StorageError("invalid_argument", "Upload is larger than the declared size.");
      }
      hash.update(buffer);
      chunks.push(buffer);
    }
    if (bytes !== expected.size) {
      throw new StorageError("invalid_argument", `Upload has ${bytes} bytes, expected ${expected.size}.`);
    }
    if (hash.digest("hex") !== expected.sha256) {
      throw new StorageError("invalid_argument", "Upload does not match the declared sha256.");
    }
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: Buffer.concat(chunks),
        ContentLength: expected.size,
        ChecksumSHA256: Buffer.from(expected.sha256, "hex").toString("base64"),
      }),
    );
  }

  async read(key: string): Promise<Readable> {
    try {
      const object = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      if (!(object.Body instanceof Readable)) {
        throw new Error("Unexpected S3 response body.");
      }
      return object.Body;
    } catch (error) {
      if (isNotFound(error)) {
        throw new StorageError("not_found", "Blob not found.");
      }
      throw error;
    }
  }

  async presignUpload(key: string, constraints: UploadConstraints): Promise<PresignedUpload> {
    const checksum = Buffer.from(constraints.sha256, "hex").toString("base64");
    // Blobs are shared by every version with the same content, so they carry no
    // content type of their own; downloads set it per version.
    const contentType = "application/octet-stream";
    const command = new PutObjectCommand({
      Bucket: this.#bucket,
      Key: key,
      ContentLength: constraints.size,
      ContentType: contentType,
      ChecksumSHA256: checksum,
    });
    // Signing the length and checksum headers makes the bucket reject any
    // other bytes, so a commit only has to check that the object exists.
    const url = await getSignedUrl(this.#presigner, command, {
      expiresIn: expiresInSeconds(constraints.expiresAt),
      signableHeaders: new Set(["content-length", "content-type", "x-amz-checksum-sha256"]),
      unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
    });
    return {
      url,
      method: "PUT",
      headers: { "content-type": contentType, "x-amz-checksum-sha256": checksum },
      expiresAt: constraints.expiresAt,
    };
  }

  async presignDownload(key: string, options: DownloadOptions): Promise<PresignedDownload> {
    const command = new GetObjectCommand({
      Bucket: this.#bucket,
      Key: key,
      ResponseContentType: options.contentType,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(options.filename)}`,
      ResponseCacheControl: "private, no-store",
    });
    const url = await getSignedUrl(this.#presigner, command, { expiresIn: expiresInSeconds(options.expiresAt) });
    return { url, expiresAt: options.expiresAt };
  }
}
