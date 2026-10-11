import { createHash, randomBytes } from "node:crypto";
import {
  formatUri,
  highestRole,
  lowestRole,
  type Role,
  roleAtLeast,
  type Scope,
  StorageError,
  scopeMatches,
  toolAllowed,
} from "@storage/core";
import type { Db } from "./db/index.js";
import { newId } from "./ids.js";

/** Prefixed so secret scanners can detect leaked tokens (design doc §8.5). */
export const USER_TOKEN_PREFIX = "storage_pat_";

/** Service tokens, including children of service tokens. */
export const SERVICE_TOKEN_PREFIX = "storage_svc_";

/** Share link secrets (design doc §8.6), prefixed like tokens so secret scanners can detect them. */
export const LINK_SECRET_PREFIX = "storage_link_";

export const DEFAULT_USER_TOKEN_TTL_DAYS = 90;

/**
 * The operations a share link may call, by operation name: server operations on /v1/ops and tools on the hosted
 * MCP server. The client-side `get` and `pull` reach the server through `list` and `download_url`.
 */
export const LINK_OPERATIONS: ReadonlySet<string> = new Set([
  "whoami",
  "list",
  "stat",
  "history",
  "get",
  "download_url",
]);

export interface LinkGrant {
  id: string;
  orgId: string;
  collectionId: string;
  /** The org and collection slugs at the time the link was resolved. */
  orgSlug: string;
  collectionSlug: string;
  /** Paths the link can read start with this. Empty for the whole collection, else ends with `/`. */
  prefix: string;
}

export interface Principal {
  /** For example `user:usr_123`. */
  id: string;
  /**
   * Every principal this caller acts as when matching grants. Today that is only
   * the user itself; domain, GitHub org, and team principals join it later.
   */
  memberOf: string[];
  /**
   * The token behind this request. `scopes` is null for an unscoped token (the principal's full access). For a
   * share link, this is the link: its id, and a reader scope on its collection.
   */
  token: {
    id: string;
    scopes: Scope[] | null;
    defaultDelivery: "ref" | "inline" | null;
    /** Public operation names the token is limited to. Null means no limit. */
    allowedTools: string[] | null;
    /** The token this one was created from. Null for top-level tokens and links. */
    parentId: string | null;
    /** The OAuth client the token was issued to. Such tokens work only at /mcp. Null for links and all other tokens. */
    clientId: string | null;
  };
  /** Set when the caller holds a share link instead of a token. */
  link: LinkGrant | null;
}

/** The URI a link can read: its collection, or the prefix within it. */
export function linkUri(link: Pick<LinkGrant, "orgSlug" | "collectionSlug" | "prefix">): string {
  return formatUri({ org: link.orgSlug, collection: link.collectionSlug, path: link.prefix });
}

export function hashToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export interface NewToken {
  principal: string;
  name?: string;
  expiresAt: Date | null;
  now?: Date;
  /** Null or absent means unscoped. */
  scopes?: Scope[] | null;
  defaultDelivery?: "ref" | "inline" | null;
  allowedTools?: string[] | null;
  parentId?: string | null;
  /** Marks a token issued to an OAuth client. */
  clientId?: string | null;
}

/** Creates a token and returns its id, secret and creation time. The secret is not stored. */
export async function insertToken(
  db: Db,
  options: NewToken,
): Promise<{ id: string; secret: string; createdAt: string }> {
  const prefix = options.principal.startsWith("service:") ? SERVICE_TOKEN_PREFIX : USER_TOKEN_PREFIX;
  const secret = `${prefix}${randomBytes(32).toString("base64url")}`;
  const id = newId("tok");
  const createdAt = (options.now ?? new Date()).toISOString();
  await db
    .insertInto("tokens")
    .values({
      id,
      token_hash: hashToken(secret),
      principal: options.principal,
      name: options.name ?? null,
      created_at: createdAt,
      expires_at: options.expiresAt?.toISOString() ?? null,
      last_used_at: null,
      scopes: options.scopes ? JSON.stringify(options.scopes) : null,
      default_delivery: options.defaultDelivery ?? null,
      revoked_at: null,
      allowed_tools: options.allowedTools ? JSON.stringify(options.allowedTools) : null,
      parent_id: options.parentId ?? null,
      client_id: options.clientId ?? null,
    })
    .execute();
  return { id, secret, createdAt };
}

export async function createUserToken(db: Db, options: NewToken): Promise<string> {
  return (await insertToken(db, options)).secret;
}

export async function authenticate(db: Db, authorization: string | undefined, now: Date): Promise<Principal> {
  const match = authorization ? /^Bearer\s+(\S+)$/i.exec(authorization) : null;
  if (!match?.[1]) {
    throw new StorageError(
      "unauthenticated",
      "Missing credentials.",
      "Set STORAGE_TOKEN, or pass Authorization: Bearer <token>.",
    );
  }
  if (match[1].startsWith(LINK_SECRET_PREFIX)) {
    return authenticateLink(db, match[1], now);
  }
  const token = await db
    .selectFrom("tokens")
    .select([
      "id",
      "principal",
      "expires_at",
      "scopes",
      "default_delivery",
      "revoked_at",
      "allowed_tools",
      "parent_id",
      "client_id",
    ])
    .where("token_hash", "=", hashToken(match[1]))
    .executeTakeFirst();
  if (!token) {
    throw new StorageError("unauthenticated", "Invalid token.");
  }
  if (token.revoked_at !== null) {
    throw new StorageError("unauthenticated", "Token has been revoked.", "Create a new token.");
  }
  if (token.expires_at !== null && new Date(token.expires_at) <= now) {
    throw new StorageError("unauthenticated", "Token has expired.", "Create a new token.");
  }
  await db.updateTable("tokens").set({ last_used_at: now.toISOString() }).where("id", "=", token.id).execute();
  return {
    id: token.principal,
    memberOf: [token.principal],
    token: {
      id: token.id,
      scopes: token.scopes === null ? null : (JSON.parse(token.scopes) as Scope[]),
      defaultDelivery: token.default_delivery,
      allowedTools: token.allowed_tools === null ? null : (JSON.parse(token.allowed_tools) as string[]),
      parentId: token.parent_id,
      clientId: token.client_id,
    },
    link: null,
  };
}

async function authenticateLink(db: Db, secret: string, now: Date): Promise<Principal> {
  const link = await db
    .selectFrom("links as l")
    .innerJoin("collections as c", "c.id", "l.collection_id")
    .innerJoin("orgs as o", "o.id", "l.org_id")
    .select([
      "l.id",
      "l.org_id",
      "l.collection_id",
      "l.prefix",
      "l.created_by",
      "l.expires_at",
      "l.revoked_at",
      "o.slug as org_slug",
    ])
    .select("c.slug as collection_slug")
    .where("l.token_hash", "=", hashToken(secret))
    .executeTakeFirst();
  if (!link) {
    throw new StorageError("unauthenticated", "Invalid share link.");
  }
  if (link.revoked_at !== null) {
    throw new StorageError("unauthenticated", "This share link has been revoked.", "Ask its owner for a new link.");
  }
  if (new Date(link.expires_at) <= now) {
    throw new StorageError("unauthenticated", "This share link has expired.", "Ask its owner for a new link.");
  }
  // A link never gives more than its creator can read now, like a token never outlives its principal's grants.
  const creatorGrant = await db
    .selectFrom("grants")
    .select("id")
    .where("principal", "=", link.created_by)
    .where("org_id", "=", link.org_id)
    .where((eb) => eb.or([eb("collection_id", "is", null), eb("collection_id", "=", link.collection_id)]))
    .executeTakeFirst();
  if (!creatorGrant) {
    throw new StorageError(
      "unauthenticated",
      "This share link no longer works: the person who created it can't read this collection any more.",
      "Ask a collection admin for a new link.",
    );
  }
  await db.updateTable("links").set({ last_used_at: now.toISOString() }).where("id", "=", link.id).execute();
  const principal = `link:${link.id}`;
  return {
    id: principal,
    // Nothing can grant to a link principal, so this matches no grant; roleOnCollection handles links instead.
    memberOf: [principal],
    token: {
      id: link.id,
      scopes: [{ collection: `${link.org_slug}/${link.collection_slug}`, role: "reader" }],
      defaultDelivery: null,
      allowedTools: null,
      parentId: null,
      clientId: null,
    },
    link: {
      id: link.id,
      orgId: link.org_id,
      collectionId: link.collection_id,
      orgSlug: link.org_slug,
      collectionSlug: link.collection_slug,
      prefix: link.prefix,
    },
  };
}

/** Throws `forbidden` if a share link calls an operation outside LINK_OPERATIONS. */
export function requireLinkOperation(principal: Principal, operation: string): void {
  if (principal.link !== null && !LINK_OPERATIONS.has(operation)) {
    throw new StorageError(
      "forbidden",
      `Share links can't call ${operation}.`,
      `A share link can only read ${linkUri(principal.link)} with list, stat, history and get.`,
    );
  }
}

/** Throws `forbidden` if the token's `allowed_tools` rules out `operation`. */
export function requireAllowedTool(principal: Principal, operation: string): void {
  const { allowedTools } = principal.token;
  if (!toolAllowed(allowedTools, operation)) {
    throw new StorageError(
      "forbidden",
      `This token can't call ${operation}.`,
      `It is limited to: ${(allowedTools ?? []).join(", ")}.`,
    );
  }
}

/**
 * True for a top-level user token with no scopes: the credentials from `storage login`. Only these manage
 * services, create service tokens and list or revoke other tokens. Links never qualify.
 */
export function isUnscopedUserToken(principal: Principal): boolean {
  return (
    principal.link === null &&
    principal.id.startsWith("user:") &&
    principal.token.scopes === null &&
    principal.token.parentId === null
  );
}

/**
 * Throws `forbidden` unless a share link covers `path`. Like requireScope, this needs no lookup, so it can't
 * reveal whether anything exists outside the link's prefix.
 */
export function requireLinkPath(principal: Principal, path: string, display: string): void {
  const { link } = principal;
  if (link !== null && !path.startsWith(link.prefix)) {
    throw new StorageError(
      "forbidden",
      `This share link doesn't cover ${display}.`,
      `It can only read under ${linkUri(link)}.`,
    );
  }
}

/** The role the token's scopes allow on a collection: admin if unscoped, else the highest matching scope's role. */
export function scopeRole(principal: Principal, org: string, slug: string): Role | null {
  const { scopes } = principal.token;
  if (scopes === null) {
    return "admin";
  }
  return highestRole(scopes.filter((scope) => scopeMatches(scope.collection, org, slug)).map((scope) => scope.role));
}

/**
 * Throws `forbidden` unless the token's scopes allow at least `need` on the collection. This depends only on
 * the token and the URI, so run it before any database lookup: it can't reveal whether a collection exists.
 */
export function requireScope(principal: Principal, org: string, slug: string, need: Role, display: string): void {
  const have = scopeRole(principal, org, slug);
  if (have === null) {
    throw new StorageError(
      "forbidden",
      `This token's scopes don't cover ${display}.`,
      `Use a token with a scope for ${org}/${slug}, or create one with: storage token create --name <name> --scope '${org}/${slug}:${need}'`,
    );
  }
  if (!roleAtLeast(have, need)) {
    throw new StorageError("forbidden", `This token's scopes allow ${have} access to ${display}; this needs ${need}.`);
  }
}

/**
 * Effective role on a collection: the highest org-level or collection-level grant (design doc §8.3),
 * capped by the token's scopes.
 */
export async function roleOnCollection(
  db: Db,
  principal: Principal,
  orgId: string,
  collectionId: string,
  orgSlug: string,
  collectionSlug: string,
): Promise<Role | null> {
  if (principal.link !== null) {
    // A link reads its own collection: the one it was created on, not a later one that reuses the slug.
    return principal.link.collectionId === collectionId ? "reader" : null;
  }
  const grants = await db
    .selectFrom("grants")
    .select("role")
    .where("principal", "in", principal.memberOf)
    .where("org_id", "=", orgId)
    .where((eb) => eb.or([eb("collection_id", "is", null), eb("collection_id", "=", collectionId)]))
    .execute();
  const grant = highestRole(grants.map((row) => row.role));
  const scope = scopeRole(principal, orgSlug, collectionSlug);
  return grant === null || scope === null ? null : lowestRole(grant, scope);
}

export async function roleOnOrg(db: Db, principal: Principal, orgId: string): Promise<Role | null> {
  if (principal.link !== null) {
    return null;
  }
  const grants = await db
    .selectFrom("grants")
    .select("role")
    .where("principal", "in", principal.memberOf)
    .where("org_id", "=", orgId)
    .where("collection_id", "is", null)
    .execute();
  return highestRole(grants.map((grant) => grant.role));
}
