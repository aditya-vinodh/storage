import { isValidSlug, StorageError } from "@storage/core";
import { createUserToken, DEFAULT_USER_TOKEN_TTL_DAYS } from "./auth.js";
import type { Db } from "./db/index.js";
import { newId } from "./ids.js";

export interface BootstrapOptions {
  org: string;
  orgName?: string;
  email: string;
  tokenName?: string;
  tokenTtlDays?: number;
  now?: Date;
}

export interface BootstrapResult {
  org: string;
  principal: string;
  token: string;
  tokenExpiresAt: string;
}

/**
 * Creates (or reuses) an org and a user, makes the user an org admin, and
 * issues a personal access token. Stands in for sign-in until the device flow
 * and identity providers land.
 */
export async function bootstrapAdmin(db: Db, options: BootstrapOptions): Promise<BootstrapResult> {
  if (!isValidSlug(options.org)) {
    throw new StorageError("invalid_argument", `Invalid org slug "${options.org}".`);
  }
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const email = options.email.trim().toLowerCase();

  const principal = await db.transaction().execute(async (trx) => {
    let org = await trx.selectFrom("orgs").select("id").where("slug", "=", options.org).executeTakeFirst();
    if (!org) {
      org = { id: newId("org") };
      await trx
        .insertInto("orgs")
        .values({ id: org.id, slug: options.org, name: options.orgName ?? options.org, created_at: createdAt })
        .execute();
    }

    let user = await trx.selectFrom("users").select("id").where("email", "=", email).executeTakeFirst();
    if (!user) {
      user = { id: newId("usr") };
      await trx.insertInto("users").values({ id: user.id, email, name: null, created_at: createdAt }).execute();
    }

    const principal = `user:${user.id}`;
    const existing = await trx
      .selectFrom("grants")
      .select("id")
      .where("principal", "=", principal)
      .where("org_id", "=", org.id)
      .where("collection_id", "is", null)
      .executeTakeFirst();
    if (existing) {
      await trx.updateTable("grants").set({ role: "admin" }).where("id", "=", existing.id).execute();
    } else {
      await trx
        .insertInto("grants")
        .values({
          id: newId("grt"),
          principal,
          role: "admin",
          org_id: org.id,
          collection_id: null,
          created_at: createdAt,
        })
        .execute();
    }
    return principal;
  });

  const expiresAt = new Date(now.getTime() + (options.tokenTtlDays ?? DEFAULT_USER_TOKEN_TTL_DAYS) * 86_400_000);
  const token = await createUserToken(db, {
    principal,
    name: options.tokenName ?? "bootstrap",
    expiresAt,
    now,
  });
  return { org: options.org, principal, token, tokenExpiresAt: expiresAt.toISOString() };
}
