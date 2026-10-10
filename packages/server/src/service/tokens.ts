import { ops, type Scope, StorageError } from "@storage/core";
import { insertToken } from "../auth.js";
import { handle, type ServiceContext } from "./context.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function scopedTokenError(): StorageError {
  return new StorageError(
    "forbidden",
    "Scoped tokens can't manage tokens.",
    "Use an unscoped token (from storage login).",
  );
}

function requireUnscoped(ctx: ServiceContext): void {
  if (ctx.principal.token.scopes !== null) {
    throw scopedTokenError();
  }
}

export const tokenCreateHandler = handle(ops.tokenCreate, async (input, ctx) => {
  requireUnscoped(ctx);
  const orgs = [...new Set(input.scopes.map((scope) => scope.collection.slice(0, scope.collection.indexOf("/"))))];
  const granted = await ctx.db
    .selectFrom("grants as g")
    .innerJoin("orgs as o", "o.id", "g.org_id")
    .select("o.slug")
    .distinct()
    .where("g.principal", "in", ctx.principal.memberOf)
    .where("o.slug", "in", orgs)
    .execute();
  const grantedSlugs = new Set(granted.map((row) => row.slug));
  for (const org of orgs) {
    if (!grantedSlugs.has(org)) {
      throw new StorageError("invalid_argument", `You have no access to org ${org}.`);
    }
  }

  const now = ctx.now();
  const expiresAt = new Date(now.getTime() + input.expires_in_days * DAY_MS);
  const scopes: Scope[] = input.scopes;
  const { id, secret, createdAt } = await insertToken(ctx.db, {
    principal: ctx.principal.id,
    name: input.name,
    expiresAt,
    now,
    scopes,
    defaultDelivery: input.default_delivery ?? null,
  });
  return {
    token: secret,
    id,
    name: input.name,
    scopes,
    default_delivery: input.default_delivery ?? null,
    created_at: createdAt,
    expires_at: expiresAt.toISOString(),
  };
});

export const tokenListHandler = handle(ops.tokenList, async (_input, ctx) => {
  requireUnscoped(ctx);
  const now = ctx.now().toISOString();
  const rows = await ctx.db
    .selectFrom("tokens")
    .select(["id", "name", "scopes", "default_delivery", "created_at", "expires_at", "last_used_at"])
    .where("principal", "=", ctx.principal.id)
    .where("revoked_at", "is", null)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .execute();
  return {
    tokens: rows.map((row) => ({
      id: row.id,
      name: row.name,
      scopes: row.scopes === null ? null : (JSON.parse(row.scopes) as Scope[]),
      default_delivery: row.default_delivery,
      created_at: row.created_at,
      expires_at: row.expires_at,
      last_used_at: row.last_used_at,
      expired: row.expires_at !== null && row.expires_at <= now,
      current: row.id === ctx.principal.token.id,
    })),
  };
});

export const tokenRevokeHandler = handle(ops.tokenRevoke, async (input, ctx) => {
  if (ctx.principal.token.scopes !== null && input.id !== ctx.principal.token.id) {
    throw scopedTokenError();
  }
  const row = await ctx.db
    .selectFrom("tokens")
    .select(["id", "revoked_at"])
    .where("id", "=", input.id)
    .where("principal", "=", ctx.principal.id)
    .executeTakeFirst();
  if (!row) {
    throw new StorageError("not_found", `Token ${input.id} not found.`);
  }
  if (row.revoked_at !== null) {
    return { id: row.id, revoked_at: row.revoked_at };
  }
  const revokedAt = ctx.now().toISOString();
  await ctx.db
    .updateTable("tokens")
    .set({ revoked_at: revokedAt })
    .where("id", "=", row.id)
    .where("revoked_at", "is", null)
    .execute();
  return { id: row.id, revoked_at: revokedAt };
});
