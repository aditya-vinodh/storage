import { formatScope, ops, type Scope, StorageError, scopeCovers } from "@storage/core";
import { recordAudit } from "../audit.js";
import { insertToken, isUnscopedUserToken, roleOnOrg } from "../auth.js";
import type { Db } from "../db/index.js";
import { handle, type ServiceContext } from "./context.js";
import { findOrg } from "./resolve.js";
import { findLiveService, lockLiveService, requireOrgRole, serviceNotFound, splitServiceRef } from "./services.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_USER_TOKEN_DAYS = 90;

function scopeOrg(scope: Scope): string {
  return scope.collection.slice(0, scope.collection.indexOf("/"));
}

/** The org and name of a `service:<org>/<name>` principal, or null for any other principal. */
function serviceRef(principal: string): { org: string; name: string } | null {
  return principal.startsWith("service:") ? splitServiceRef(principal.slice("service:".length)) : null;
}

/** The org slug of a `service:<org>/<name>` principal, or null for any other principal. */
function serviceOrgSlug(principal: string): string | null {
  return serviceRef(principal)?.org ?? null;
}

/** The org id audit events for this principal's tokens belong to: the service's org, else none. */
async function auditOrgId(db: Db, principal: string): Promise<string | null> {
  const slug = serviceOrgSlug(principal);
  if (slug === null) {
    return null;
  }
  const org = await db.selectFrom("orgs").select("id").where("slug", "=", slug).executeTakeFirst();
  return org?.id ?? null;
}

function requireServiceOrgScopes(scopes: readonly Scope[], org: string): void {
  if (scopes.some((scope) => scopeOrg(scope) !== org)) {
    throw new StorageError("invalid_argument", `A service token's scopes must be in its own org (${org}).`);
  }
}

/** Every token created from `rootId`, directly or through other children, revoked or not. */
async function descendants(db: Db, rootId: string): Promise<{ id: string; revoked_at: string | null }[]> {
  const found: { id: string; revoked_at: string | null }[] = [];
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  while (frontier.length > 0) {
    const rows = await db
      .selectFrom("tokens")
      .select(["id", "revoked_at"])
      .where("parent_id", "in", frontier)
      .execute();
    frontier = [];
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        found.push(row);
        frontier.push(row.id);
      }
    }
  }
  return found;
}

function userExpiryCapError(): StorageError {
  return new StorageError("invalid_argument", `User tokens expire after at most ${MAX_USER_TOKEN_DAYS} days.`);
}

export const tokenCreateHandler = handle(ops.tokenCreate, async (input, ctx) => {
  const caller = ctx.principal;
  const now = ctx.now();
  const parent = isUnscopedUserToken(caller) ? null : caller.token;
  if (parent !== null && input.service !== undefined) {
    throw new StorageError(
      "forbidden",
      "Only an unscoped user token can create service tokens.",
      "Use the token from storage login.",
    );
  }

  let principal: string;
  let scopes: Scope[] | null;
  let allowedTools: string[] | null = input.allowed_tools ?? null;
  let defaultDelivery = input.default_delivery ?? null;
  let expiresAt: Date | null;
  let orgId: string | null;

  if (parent === null) {
    if (input.service !== undefined) {
      const ref = splitServiceRef(input.service);
      const org = await requireOrgRole(ctx, ref.org, "admin");
      if (!(await findLiveService(ctx.db, org.id, ref.name))) {
        throw serviceNotFound(ref.org, ref.name);
      }
      principal = `service:${ref.org}/${ref.name}`;
      scopes = input.scopes ?? null;
      if (scopes) {
        requireServiceOrgScopes(scopes, ref.org);
      }
      expiresAt = input.expires_in_days === undefined ? null : new Date(now.getTime() + input.expires_in_days * DAY_MS);
      orgId = org.id;
    } else {
      principal = caller.id;
      scopes = await checkedUserScopes(ctx, input.scopes);
      const days = input.expires_in_days ?? MAX_USER_TOKEN_DAYS;
      if (days > MAX_USER_TOKEN_DAYS) {
        throw userExpiryCapError();
      }
      expiresAt = new Date(now.getTime() + days * DAY_MS);
      orgId = null;
    }
  } else {
    principal = caller.id;
    const serviceOrg = serviceOrgSlug(principal);
    if (parent.scopes === null) {
      // Only a service token can be unscoped here: an unscoped user token is a top-level one.
      if (serviceOrg === null) {
        throw new StorageError("invalid_argument", "Pass at least one scope; a user token always has scopes.");
      }
      scopes = input.scopes ?? null;
      if (scopes) {
        requireServiceOrgScopes(scopes, serviceOrg);
      }
    } else if (input.scopes === undefined) {
      scopes = parent.scopes;
    } else {
      const parentScopes = parent.scopes;
      for (const scope of input.scopes) {
        if (!parentScopes.some((candidate) => scopeCovers(candidate, scope))) {
          throw new StorageError("forbidden", `Scope ${formatScope(scope)} isn't within this token's scopes.`);
        }
      }
      scopes = input.scopes;
    }

    if (parent.allowedTools === null) {
      allowedTools = input.allowed_tools ?? null;
    } else if (input.allowed_tools === undefined) {
      allowedTools = parent.allowedTools;
    } else {
      const parentTools = parent.allowedTools;
      const extra = input.allowed_tools.find((tool) => !parentTools.includes(tool));
      if (extra !== undefined) {
        throw new StorageError("forbidden", `This token can't give a child access to ${extra}.`);
      }
    }
    defaultDelivery = input.default_delivery ?? parent.defaultDelivery;

    const parentRow = await ctx.db
      .selectFrom("tokens")
      .select("expires_at")
      .where("id", "=", parent.id)
      .executeTakeFirstOrThrow();
    const requested =
      input.expires_in_days === undefined ? null : new Date(now.getTime() + input.expires_in_days * DAY_MS);
    if (serviceOrg === null && input.expires_in_days !== undefined && input.expires_in_days > MAX_USER_TOKEN_DAYS) {
      throw userExpiryCapError();
    }
    if (parentRow.expires_at === null) {
      expiresAt = requested;
    } else if (requested === null) {
      expiresAt = new Date(parentRow.expires_at);
    } else if (requested > new Date(parentRow.expires_at)) {
      throw new StorageError(
        "invalid_argument",
        `A child token can't outlive its parent (expires ${parentRow.expires_at}).`,
      );
    } else {
      expiresAt = requested;
    }
    orgId = await auditOrgId(ctx.db, principal);
  }

  const parentId = parent?.id ?? null;
  const { id, secret, createdAt } = await ctx.db.transaction().execute(async (trx) => {
    // Lock what the new token hangs off, so a concurrent revoke or service_delete can't miss it: the parent
    // token (revocation cascades to children) and the service (deleting it revokes its tokens).
    if (parentId !== null) {
      const locked = await trx
        .updateTable("tokens")
        .set((eb) => ({ revoked_at: eb.ref("revoked_at") }))
        .where("id", "=", parentId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (Number(locked.numUpdatedRows) === 0) {
        throw new StorageError("unauthenticated", "Token has been revoked.", "Create a new token.");
      }
    }
    const service = serviceRef(principal);
    if (service !== null && !(await lockLiveService(trx, service.org, service.name))) {
      throw serviceNotFound(service.org, service.name);
    }
    const created = await insertToken(trx, {
      principal,
      name: input.name,
      expiresAt,
      now,
      scopes,
      defaultDelivery,
      allowedTools,
      parentId,
    });
    await recordAudit(trx, caller, now, {
      orgId,
      action: "token.create",
      target: created.id,
      detail:
        parent === null && input.service === undefined
          ? { name: input.name, scopes }
          : { name: input.name, scopes, principal, ...(parent === null ? {} : { parent_id: parentId }) },
    });
    return created;
  });
  return {
    token: secret,
    id,
    name: input.name,
    principal,
    scopes,
    allowed_tools: allowedTools,
    default_delivery: defaultDelivery,
    created_at: createdAt,
    expires_at: expiresAt?.toISOString() ?? null,
    parent_id: parentId,
  };
});

/** Requires scopes for a user token and checks the caller has access to every org they name. */
async function checkedUserScopes(ctx: ServiceContext, scopes: Scope[] | undefined): Promise<Scope[]> {
  if (scopes === undefined) {
    throw new StorageError("invalid_argument", "Pass at least one scope; a user token always has scopes.");
  }
  const orgs = [...new Set(scopes.map(scopeOrg))];
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
  return scopes;
}

export const tokenListHandler = handle(ops.tokenList, async (input, ctx) => {
  const caller = ctx.principal;
  const now = ctx.now().toISOString();
  let query = ctx.db
    .selectFrom("tokens")
    .select([
      "id",
      "name",
      "principal",
      "scopes",
      "allowed_tools",
      "parent_id",
      "default_delivery",
      "created_at",
      "expires_at",
      "last_used_at",
    ])
    .where("revoked_at", "is", null);
  if (isUnscopedUserToken(caller)) {
    let principal = caller.id;
    if (input.service !== undefined) {
      const ref = splitServiceRef(input.service);
      const org = await requireOrgRole(ctx, ref.org, "admin");
      if (!(await findLiveService(ctx.db, org.id, ref.name))) {
        throw serviceNotFound(ref.org, ref.name);
      }
      principal = `service:${ref.org}/${ref.name}`;
    }
    query = query.where("principal", "=", principal);
  } else {
    if (input.service !== undefined) {
      throw new StorageError(
        "forbidden",
        "Only an unscoped user token can list a service's tokens.",
        "Use the token from storage login.",
      );
    }
    const ids = [caller.token.id, ...(await descendants(ctx.db, caller.token.id)).map((row) => row.id)];
    query = query.where("id", "in", ids);
  }
  const rows = await query.orderBy("created_at", "desc").orderBy("id", "desc").execute();
  return {
    tokens: rows.map((row) => ({
      id: row.id,
      name: row.name,
      principal: row.principal,
      scopes: row.scopes === null ? null : (JSON.parse(row.scopes) as Scope[]),
      allowed_tools: row.allowed_tools === null ? null : (JSON.parse(row.allowed_tools) as string[]),
      parent_id: row.parent_id,
      default_delivery: row.default_delivery,
      created_at: row.created_at,
      expires_at: row.expires_at,
      last_used_at: row.last_used_at,
      expired: row.expires_at !== null && row.expires_at <= now,
      current: row.id === caller.token.id,
    })),
  };
});

export const tokenRevokeHandler = handle(ops.tokenRevoke, async (input, ctx) => {
  const caller = ctx.principal;
  let row: { id: string; principal: string; revoked_at: string | null } | undefined;
  if (isUnscopedUserToken(caller)) {
    row = await ctx.db
      .selectFrom("tokens")
      .select(["id", "principal", "revoked_at"])
      .where("id", "=", input.id)
      .executeTakeFirst();
    // Own tokens, and the tokens of the services of an org the caller administers. Anything else looks absent.
    let allowed = row !== undefined && row.principal === caller.id;
    const serviceOrg = row ? serviceOrgSlug(row.principal) : null;
    if (row && !allowed && serviceOrg !== null) {
      const org = await findOrg(ctx, serviceOrg);
      const role = org ? await roleOnOrg(ctx.db, caller, org.id) : null;
      allowed = role === "admin";
    }
    if (!row || !allowed) {
      throw new StorageError("not_found", `Token ${input.id} not found.`);
    }
  } else {
    // The same answer for an unrelated token and a missing one, so this reveals nothing about other tokens.
    const own = caller.token.id;
    if (input.id !== own && !(await descendants(ctx.db, own)).some((child) => child.id === input.id)) {
      throw new StorageError("forbidden", "This token can only revoke itself and the tokens created from it.");
    }
    row = await ctx.db
      .selectFrom("tokens")
      .select(["id", "principal", "revoked_at"])
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!row) {
      throw new StorageError("not_found", `Token ${input.id} not found.`);
    }
  }
  const target = row;
  if (target.revoked_at !== null) {
    return { id: target.id, revoked_at: target.revoked_at, also_revoked: [] };
  }
  const orgId = await auditOrgId(ctx.db, target.principal);
  return ctx.db.transaction().execute(async (trx) => {
    const now = ctx.now();
    const revokedAt = now.toISOString();
    // Revoke the target first: that takes its row lock, so a child created concurrently either committed
    // before this (and the walk below finds it) or fails to lock its revoked parent.
    const revoked = await trx
      .updateTable("tokens")
      .set({ revoked_at: revokedAt })
      .where("id", "=", target.id)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (Number(revoked.numUpdatedRows) === 0) {
      const current = await trx
        .selectFrom("tokens")
        .select("revoked_at")
        .where("id", "=", target.id)
        .executeTakeFirstOrThrow();
      return { id: target.id, revoked_at: current.revoked_at ?? revokedAt, also_revoked: [] };
    }
    const alsoRevoked = (await descendants(trx, target.id))
      .filter((child) => child.revoked_at === null)
      .map((c) => c.id);
    if (alsoRevoked.length > 0) {
      await trx
        .updateTable("tokens")
        .set({ revoked_at: revokedAt })
        .where("id", "in", alsoRevoked)
        .where("revoked_at", "is", null)
        .execute();
    }
    await recordAudit(trx, caller, now, {
      orgId,
      action: "token.revoke",
      target: target.id,
      detail: { also_revoked: alsoRevoked },
    });
    return { id: target.id, revoked_at: revokedAt, also_revoked: alsoRevoked };
  });
});
