import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StorageError } from "@storage/core";
import type { Signer } from "../signing.js";
import type {
  BlobStat,
  DownloadOptions,
  PresignedDownload,
  PresignedUpload,
  ServerTransferBlobStore,
  UploadConstraints,
} from "./store.js";

const KEY_PATTERN = /^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*$/;

export interface FilesystemBlobStoreOptions {
  root: string;
  /** Base URL of this server; transfer URLs are `<publicUrl>/v1/blobs/<token>`. */
  publicUrl: string;
  signer: Signer;
}

export type TransferToken =
  | { op: "put"; key: string; size: number; sha256: string }
  | { op: "get"; key: string; content_type: string; filename: string };

export function parseTransferToken(payload: Record<string, unknown> | null): TransferToken | null {
  if (payload === null || typeof payload.key !== "string") {
    return null;
  }
  if (payload.op === "put" && typeof payload.size === "number" && typeof payload.sha256 === "string") {
    return { op: "put", key: payload.key, size: payload.size, sha256: payload.sha256 };
  }
  if (payload.op === "get" && typeof payload.content_type === "string" && typeof payload.filename === "string") {
    return { op: "get", key: payload.key, content_type: payload.content_type, filename: payload.filename };
  }
  return null;
}

/** Stores blobs on local disk. Intended for development and single-node installs. */
export class FilesystemBlobStore implements ServerTransferBlobStore {
  readonly servesTransfers = true as const;
  readonly #root: string;
  readonly #publicUrl: string;
  readonly #signer: Signer;

  constructor(options: FilesystemBlobStoreOptions) {
    this.#root = options.root;
    this.#publicUrl = options.publicUrl.replace(/\/+$/, "");
    this.#signer = options.signer;
  }

  async stat(key: string): Promise<BlobStat | null> {
    try {
      const info = await stat(this.#pathFor(key));
      return info.isFile() ? { size: info.size } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#pathFor(key), { force: true });
  }

  async presignUpload(key: string, constraints: UploadConstraints): Promise<PresignedUpload> {
    const token: TransferToken = { op: "put", key, size: constraints.size, sha256: constraints.sha256 };
    return {
      url: this.#transferUrl(token, constraints.expiresAt),
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      expiresAt: constraints.expiresAt,
    };
  }

  async presignDownload(key: string, options: DownloadOptions): Promise<PresignedDownload> {
    const token: TransferToken = { op: "get", key, content_type: options.contentType, filename: options.filename };
    return { url: this.#transferUrl(token, options.expiresAt), expiresAt: options.expiresAt };
  }

  async write(key: string, body: Readable, expected: { size: number; sha256: string }): Promise<void> {
    const target = this.#pathFor(key);
    const tmpDir = join(this.#root, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, randomBytes(16).toString("hex"));

    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > expected.size) {
          callback(new StorageError("invalid_argument", "Upload is larger than the declared size."));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(body, meter, createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
      if (bytes !== expected.size) {
        throw new StorageError("invalid_argument", `Upload has ${bytes} bytes, expected ${expected.size}.`);
      }
      if (hash.digest("hex") !== expected.sha256) {
        throw new StorageError("invalid_argument", "Upload does not match the declared sha256.");
      }
      await mkdir(dirname(target), { recursive: true });
      await rename(tmp, target);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async read(key: string): Promise<Readable> {
    if ((await this.stat(key)) === null) {
      throw new StorageError("not_found", "Blob not found.");
    }
    return createReadStream(this.#pathFor(key));
  }

  #transferUrl(token: TransferToken, expiresAt: Date): string {
    return `${this.#publicUrl}/v1/blobs/${this.#signer.sign(token, expiresAt)}`;
  }

  #pathFor(key: string): string {
    if (!KEY_PATTERN.test(key)) {
      throw new Error(`Invalid blob key "${key}".`);
    }
    return join(this.#root, ...key.split("/"));
  }
}
