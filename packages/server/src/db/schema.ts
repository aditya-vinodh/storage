import type { Role } from "@storage/core";

/*
 * Timestamps are ISO-8601 strings and JSON fields are serialized text so the
 * same schema works on SQLite and Postgres. Booleans are stored as 0/1.
 */

export interface OrgsTable {
  id: string;
  slug: string;
  name: string;
  created_at: string;
}

export interface UsersTable {
  id: string;
  email: string | null;
  name: string | null;
  created_at: string;
}

export interface TokensTable {
  id: string;
  /** SHA-256 of the token secret. The secret itself is never stored. */
  token_hash: string;
  principal: string;
  name: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  /** JSON array of scopes. Null means unscoped: the principal's full access. */
  scopes: string | null;
  default_delivery: "ref" | "inline" | null;
  /** Set when revoked. Revoked rows are kept. */
  revoked_at: string | null;
  /** JSON array of public operation names. Null means no restriction. */
  allowed_tools: string | null;
  /** The token this one was created from. Null for top-level tokens. */
  parent_id: string | null;
}

/** A non-human principal that belongs to one org (design doc §8.5). Deleted rows are kept. */
export interface ServicesTable {
  id: string;
  org_id: string;
  name: string;
  /** The principal that created the service. */
  created_by: string;
  created_at: string;
  /** Set when deleted; null while live. */
  deleted_at: string | null;
}

/** Share links (design doc §8.6). Revoked rows are kept. */
export interface LinksTable {
  id: string;
  /** SHA-256 of the link secret. The secret itself is never stored. */
  token_hash: string;
  org_id: string;
  collection_id: string;
  /** Empty for the whole collection, else a path prefix ending with `/`. */
  prefix: string;
  name: string | null;
  /** The principal that created the link. */
  created_by: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface GrantsTable {
  id: string;
  principal: string;
  role: Role;
  org_id: string;
  /** Null for org-level grants. */
  collection_id: string | null;
  created_at: string;
}

export interface CollectionsTable {
  id: string;
  org_id: string;
  slug: string;
  title: string | null;
  description: string | null;
  /** JSON array of strings. */
  tags: string;
  state: "active" | "expiring" | "deleted";
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ObjectsTable {
  id: string;
  collection_id: string;
  path: string;
  current_version: number | null;
  deleted_at: string | null;
}

export interface VersionsTable {
  id: string;
  object_id: string;
  version: number;
  blob_sha256: string;
  size: number;
  content_type: string;
  description: string | null;
  /** JSON object of string values. */
  meta: string;
  uploaded_by: string;
  uploaded_at: string;
  idempotency_key: string | null;
}

export interface BlobsTable {
  org_id: string;
  sha256: string;
  size: number;
  created_at: string;
}

export interface UploadsTable {
  id: string;
  org_id: string;
  collection_id: string;
  path: string;
  sha256: string;
  size: number;
  content_type: string;
  description: string | null;
  meta: string;
  if_match: string | null;
  idempotency_key: string | null;
  /** 1 if the client had to send bytes, 0 if the org already had the blob. */
  transfer_required: number;
  created_by: string;
  created_at: string;
  expires_at: string;
  /** Set once committed, so a retried commit returns the same version. */
  version_id: string | null;
}

export interface AuditEventsTable {
  id: string;
  /** Null for events outside any org, such as token changes. */
  org_id: string | null;
  at: string;
  /** The principal that acted, for example `user:usr_123`. */
  actor: string;
  token_id: string | null;
  /** One of AUDIT_ACTIONS in `packages/core/src/schemas.ts`. */
  action: string;
  /** A storage URI, or a token id for token events. */
  target: string;
  /** JSON object with action-specific fields. */
  detail: string;
}

export interface Database {
  orgs: OrgsTable;
  users: UsersTable;
  tokens: TokensTable;
  services: ServicesTable;
  grants: GrantsTable;
  links: LinksTable;
  collections: CollectionsTable;
  objects: ObjectsTable;
  versions: VersionsTable;
  blobs: BlobsTable;
  uploads: UploadsTable;
  audit_events: AuditEventsTable;
}
