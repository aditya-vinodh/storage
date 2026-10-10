import { createHash, randomBytes } from "node:crypto";
import { highestRole, type Role, StorageError } from "@storage/core";
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
}

export function hashToken(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export async function createUserToken(
  db: Db,
  options: { principal: string; name?: string; expiresAt: Date | null; now?: Date },
): Promise<string> {
  const secret = `${USER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  await db
    .insertInto("tokens")
    .values({
      id: newId("tok"),
      token_hash: hashToken(secret),
      principal: options.principal,
      name: options.name ?? null,
      created_at: (options.now ?? new Date()).toISOString(),
      expires_at: options.expiresAt?.toISOString() ?? null,
      last_used_at: null,
    })
    .execute();
  return secret;
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
    .select(["id", "principal", "expires_at"])
    .where("token_hash", "=", hashToken(match[1]))
    .executeTakeFirst();
  if (!token) {
    throw new StorageError("unauthenticated", "Invalid token.");
  }
  if (token.expires_at !== null && new Date(token.expires_at) <= now) {
    throw new StorageError("unauthenticated", "Token has expired.", "Create a new token.");
  }
  await db.updateTable("tokens").set({ last_used_at: now.toISOString() }).where("id", "=", token.id).execute();
  return { id: token.principal, memberOf: [token.principal] };
}

/** Effective role on a collection: the highest org-level or collection-level grant (design doc §8.3). */
export async function roleOnCollection(
  db: Db,
  principal: Principal,
  orgId: string,
  collectionId: string,
): Promise<Role | null> {
  const grants = await db
    .selectFrom("grants")
    .select("role")
    .where("principal", "in", principal.memberOf)
    .where("org_id", "=", orgId)
    .where((eb) => eb.or([eb("collection_id", "is", null), eb("collection_id", "=", collectionId)]))
    .execute();
  return highestRole(grants.map((grant) => grant.role));
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
