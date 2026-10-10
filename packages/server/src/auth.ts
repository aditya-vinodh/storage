import { createHash, randomBytes } from "node:crypto";
import { highestRole, lowestRole, type Role, roleAtLeast, type Scope, StorageError, scopeMatches } from "@storage/core";
import type { Db } from "./db/index.js";
import { newId } from "./ids.js";

/** Prefixed so secret scanners can detect leaked tokens (design doc §8.5). */
export const USER_TOKEN_PREFIX = "storage_pat_";

export const DEFAULT_USER_TOKEN_TTL_DAYS = 90;

export interface Principal {
  /** For example `user:usr_123`. */
  id: string;
  /**
   * Every principal this caller acts as when matching grants. Today that is only
   * the user itself; domain, GitHub org, and team principals join it later.
   */
  memberOf: string[];
  /** The token behind this request. `scopes` is null for an unscoped token (the principal's full access). */
  token: { id: string; scopes: Scope[] | null; defaultDelivery: "ref" | "inline" | null };
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
}

/** Creates a token and returns its id, secret and creation time. The secret is not stored. */
export async function insertToken(
  db: Db,
  options: NewToken,
): Promise<{ id: string; secret: string; createdAt: string }> {
  const secret = `${USER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
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
  const token = await db
    .selectFrom("tokens")
    .select(["id", "principal", "expires_at", "scopes", "default_delivery", "revoked_at"])
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
    },
  };
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
  const grants = await db
    .selectFrom("grants")
    .select("role")
    .where("principal", "in", principal.memberOf)
    .where("org_id", "=", orgId)
    .where("collection_id", "is", null)
    .execute();
  return highestRole(grants.map((grant) => grant.role));
}
