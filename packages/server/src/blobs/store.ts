import type { Readable } from "node:stream";

export interface BlobStat {
  size: number;
}

export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}

export interface UploadConstraints {
  size: number;
  sha256: string;
  contentType: string;
  expiresAt: Date;
}

export interface DownloadOptions {
  contentType: string;
  filename: string;
  expiresAt: Date;
}

/**
 * Content-addressed byte storage. Clients move bytes directly to and from the
 * store through presigned URLs, so bytes never pass through the API handlers.
 * `write` and `read` are for the hosted MCP server, which handles small
 * payloads itself (design doc §9.4, §11).
 */
export interface BlobStore {
  stat(key: string): Promise<BlobStat | null>;
  delete(key: string): Promise<void>;
  presignUpload(key: string, constraints: UploadConstraints): Promise<PresignedUpload>;
  presignDownload(key: string, options: DownloadOptions): Promise<PresignedDownload>;
  /** Writes `body` to `key`, rejecting it unless its size and SHA-256 match. */
  write(key: string, body: Readable, expected: { size: number; sha256: string }): Promise<void>;
  /** Streams the blob at `key`. Throws StorageError `not_found` if it doesn't exist. */
  read(key: string): Promise<Readable>;
}

/**
 * A store whose presigned URLs point back at this server (the filesystem
 * driver). The HTTP layer serves those URLs by calling `write` and `read`.
 */
export interface ServerTransferBlobStore extends BlobStore {
  readonly servesTransfers: true;
}

export function servesTransfers(store: BlobStore): store is ServerTransferBlobStore {
  return (store as Partial<ServerTransferBlobStore>).servesTransfers === true;
}

/** Blobs are deduplicated within an org and never across orgs (design doc §7.1). */
export function blobKey(orgId: string, sha256: string): string {
  return `orgs/${orgId}/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}
