import type { Role } from "@storage/core";

/*
 * Timestamps are ISO-8601 strings and JSON fields are serialized text so the
 * same schema works on SQLite and Postgres. Booleans are stored as 0/1.
 */

export interface OrgsTable {
  id: string;
  slug: string;
  name: string;
  /** JSON array of lifecycle rules copied into new collections (docs/specs/bindings.md). */
  default_lifecycle_rules: string;
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
  /** The OAuth client this token was issued to. Set only for MCP tokens, which work only at /mcp. */
  client_id: string | null;
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
  /** JSON array of lifecycle rules (docs/specs/lifecycle-rules.md). */
  lifecycle_rules: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** A collection's link to a GitHub pull request (docs/specs/bindings.md). At most one per collection. */
export interface BindingsTable {
  id: string;
  org_id: string;
  collection_id: string;
  kind: "github";
  /** Normalized and lowercased, for example `github:acme/web#482`. Unique per org. */
  target: string;
  /** Lowercased. */
  owner: string;
  /** Lowercased. */
  repo: string;
  number: number;
  state: "unknown" | "open" | "closed" | "merged";
  /** When the pull request closed, merged or not. Null while open. */
  closed_at: string | null;
  merged_at: string | null;
  /** The pull request's `updated_at` from the last update applied, to drop out-of-order deliveries. */
  source_updated_at: string | null;
  polled_at: string | null;
  poll_error: string | null;
  /** The GitHub App installation `bind` read the pull request through; polling and webhooks use only it. */
  installation_id: string;
  created_by: string;
  created_at: string;
}

/** A GitHub App installation linked to a storage org (docs/specs/bindings.md). */
export interface GithubInstallationsTable {
  id: string;
  org_id: string;
  /** GitHub's numeric installation id, as a string. */
  installation_id: string;
  /** Lowercased login of the GitHub user or org the app is installed on. */
  account_login: string;
  account_type: "User" | "Organization";
  created_by: string;
  created_at: string;
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

export interface IdentitiesTable {
  id: string;
  user_id: string;
  provider: string;
  /** The account's stable id at the provider. */
  subject: string;
  email: string;
  /** The Google Workspace primary domain from the last sign-in, lowercased. Null for Gmail and other accounts. */
  hd: string | null;
  created_at: string;
  last_sign_in_at: string;
}

/** A CLI sign-in in progress (OAuth device flow, RFC 8628). */
export interface DeviceAuthorizationsTable {
  id: string;
  /** SHA-256 of the device code. The code itself is never stored. */
  device_code_hash: string;
  /** Eight letters, no hyphen. */
  user_code: string;
  client_id: string;
  status: "pending" | "approved" | "denied" | "consumed";
  user_id: string | null;
  interval_seconds: number;
  created_at: string;
  expires_at: string;
  last_polled_at: string | null;
  approved_at: string | null;
  /** The token issued for this authorization. */
  token_id: string | null;
}

/** One redirect to a sign-in provider and back. */
export interface SignInStatesTable {
  id: string;
  /** SHA-256 of the `state` parameter. */
  state_hash: string;
  /** SHA-256 of the nonce in the browser's cookie. */
  browser_hash: string;
  provider: string;
  code_verifier: string;
  /** Exactly one of these two is set. */
  device_authorization_id: string | null;
  authorization_request_id: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

/** An account at another provider (GitHub) that a user has connected. Not a sign-in identity. */
export interface ConnectedAccountsTable {
  id: string;
  user_id: string;
  provider: string;
  /** The account's stable id at the provider: GitHub's numeric user id as a string. */
  subject: string;
  login: string;
  /** The GitHub access token, sealed. Null until stored, and after GitHub revokes it. */
  access_token: string | null;
  /** The token's scopes, comma-separated. */
  token_scopes: string | null;
  /** JSON `Group[]`: the GitHub orgs and teams the account belonged to at the last refresh. */
  memberships: string | null;
  memberships_expires_at: string | null;
  /** After a failed refresh, when to try again. */
  memberships_retry_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The latest known name of a `github-org:` or `github-team:` principal, for display. */
export interface GithubPrincipalNamesTable {
  principal: string;
  name: string;
  updated_at: string;
}

/** A single-use link, made by `connect_start`, that begins connecting an account in a browser. */
export interface ConnectTicketsTable {
  id: string;
  /** SHA-256 of the ticket. The ticket itself is never stored. */
  ticket_hash: string;
  user_id: string;
  provider: string;
  /** The org a `github-app` install links to. Null for connecting accounts. */
  org_id: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

/** One connect flow in the browser: Google re-check, then the provider. */
export interface ConnectStatesTable {
  id: string;
  /** SHA-256 of the `state` parameter. Replaced when the flow advances a step. */
  state_hash: string;
  /** SHA-256 of the nonce in the browser's cookie. */
  browser_hash: string;
  user_id: string;
  /** The provider being connected, or `github-app` for an install. */
  provider: string;
  /** The org a `github-app` install links to. Null for connecting accounts. */
  org_id: string | null;
  step: "google" | "github";
  code_verifier: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

/** A dynamically registered public OAuth client (RFC 7591). */
export interface OauthClientsTable {
  id: string;
  /** Self-reported by the client; shown on the consent page as such. */
  client_name: string | null;
  /** JSON array of exact-match redirect URIs. */
  redirect_uris: string;
  /** JSON array of grant types. */
  grant_types: string;
  created_at: string;
}

/** An MCP client's authorization code request, from the consent page to the code exchange. */
export interface OauthAuthorizationRequestsTable {
  id: string;
  client_id: string;
  redirect_uri: string;
  /** The client's own state, echoed back on redirect. */
  state: string | null;
  /** PKCE S256 challenge. */
  code_challenge: string;
  resource: string | null;
  status: "pending" | "approved" | "denied" | "consumed";
  user_id: string | null;
  /** SHA-256 of the authorization code. The code itself is never stored. */
  code_hash: string | null;
  code_expires_at: string | null;
  approved_at: string | null;
  /** The access token issued for this request. */
  token_id: string | null;
  /** SHA-256 of the nonce in the cookie set with the consent page; /oauth/authorize/start requires it. */
  consent_hash: string | null;
  created_at: string;
  expires_at: string;
}

export interface OauthRefreshTokensTable {
  id: string;
  /** SHA-256 of the refresh token. The token itself is never stored. */
  token_hash: string;
  /** The access token row this refresh token rotates. */
  token_id: string;
  client_id: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export interface Database {
  orgs: OrgsTable;
  users: UsersTable;
  tokens: TokensTable;
  services: ServicesTable;
  grants: GrantsTable;
  links: LinksTable;
  collections: CollectionsTable;
  bindings: BindingsTable;
  github_installations: GithubInstallationsTable;
  objects: ObjectsTable;
  versions: VersionsTable;
  blobs: BlobsTable;
  uploads: UploadsTable;
  audit_events: AuditEventsTable;
  identities: IdentitiesTable;
  device_authorizations: DeviceAuthorizationsTable;
  sign_in_states: SignInStatesTable;
  oauth_clients: OauthClientsTable;
  oauth_authorization_requests: OauthAuthorizationRequestsTable;
  oauth_refresh_tokens: OauthRefreshTokensTable;
  connected_accounts: ConnectedAccountsTable;
  github_principal_names: GithubPrincipalNamesTable;
  connect_tickets: ConnectTicketsTable;
  connect_states: ConnectStatesTable;
}
