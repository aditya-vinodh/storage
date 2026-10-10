import { formatUri, ops, type Role, StorageError, servicePrincipal } from "@storage/core";
import type { Selectable } from "kysely";
import { recordAudit } from "../audit.js";
import { isUnscopedUserToken, roleOnOrg } from "../auth.js";
import type { Db } from "../db/index.js";
import type { ServicesTable } from "../db/schema.js";
import { newId } from "../ids.js";
import { handle, type ServiceContext } from "./context.js";
import { retryOnUniqueViolation } from "./grants.js";
import { findOrg, type OrgRow, requireRole } from "./resolve.js";

type ServiceRow = Selectable<ServicesTable>;

/** Throws `forbidden` unless the caller holds an unscoped top-level user token. Needs no lookup. */
export function requireUnscopedUserToken(ctx: ServiceContext, what: string): void {
  if (!isUnscopedUserToken(ctx.principal)) {
    throw new StorageError(
      "forbidden",
      `Only an unscoped user token can ${what}.`,
      "Use the token from storage login.",
    );
  }
}

/** Splits `<org>/<name>`. Callers have validated the shape with the operation's input schema. */
export function splitServiceRef(ref: string): { org: string; name: string } {
  const slash = ref.indexOf("/");
  return { org: ref.slice(0, slash), name: ref.slice(slash + 1) };
}

/** Finds the org and checks the caller's org-level role. An org the caller has no role in is reported as not found. */
export async function requireOrgRole(ctx: ServiceContext, slug: string, need: Role): Promise<OrgRow> {
  const display = formatUri({ org: slug });
  const org = await findOrg(ctx, slug);
  const role = org ? await roleOnOrg(ctx.db, ctx.principal, org.id) : null;
  if (!org || role === null) {
    throw new StorageError("not_found", `Org ${display} not found.`);
  }
  requireRole(role, need, display);
  return org;
}

export function findLiveService(db: Db, orgId: string, name: string): Promise<ServiceRow | undefined> {
  return db
    .selectFrom("services")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("name", "=", name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

/**
 * Takes the live service's row lock with a no-op update and returns whether it is still live. Run it in the
 * transaction that writes a grant or token for the service: a concurrent service_delete then either waits for
 * that write (and revokes or removes it) or has already committed (and this returns false). SQLite already
 * serializes writers.
 */
export async function lockLiveService(db: Db, orgSlug: string, name: string): Promise<boolean> {
  const org = await db.selectFrom("orgs").select("id").where("slug", "=", orgSlug).executeTakeFirst();
  if (!org) {
    return false;
  }
  const result = await db
    .updateTable("services")
    .set((eb) => ({ name: eb.ref("name") }))
    .where("org_id", "=", org.id)
    .where("name", "=", name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export function serviceNotFound(org: string, name: string): StorageError {
  return new StorageError("not_found", `No service ${name} in ${formatUri({ org })}.`);
}

function toService(row: ServiceRow, org: string) {
  return {
    org,
    name: row.name,
    principal: servicePrincipal(org, row.name),
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export const serviceCreateHandler = handle(ops.serviceCreate, async (input, ctx) => {
  requireUnscopedUserToken(ctx, "manage services");
  const org = await requireOrgRole(ctx, input.org, "admin");
  return retryOnUniqueViolation(() =>
    ctx.db.transaction().execute(async (trx) => {
      const existing = await findLiveService(trx, org.id, input.name);
      if (existing) {
        return { service: toService(existing, org.slug), created: false };
      }
      const now = ctx.now();
      const row: ServiceRow = {
        id: newId("svc"),
        org_id: org.id,
        name: input.name,
        created_by: ctx.principal.id,
        created_at: now.toISOString(),
        deleted_at: null,
      };
      await trx.insertInto("services").values(row).execute();
      const service = toService(row, org.slug);
      await recordAudit(trx, ctx.principal, now, {
        orgId: org.id,
        action: "service.create",
        target: service.principal,
      });
      return { service, created: true };
    }),
  );
});

export const serviceListHandler = handle(ops.serviceList, async (input, ctx) => {
  requireUnscopedUserToken(ctx, "manage services");
  const org = await requireOrgRole(ctx, input.org, "reader");
  const rows = await ctx.db
    .selectFrom("services")
    .selectAll()
    .where("org_id", "=", org.id)
    .where("deleted_at", "is", null)
    .orderBy("name")
    .execute();
  return { services: rows.map((row) => toService(row, org.slug)) };
});

export const serviceDeleteHandler = handle(ops.serviceDelete, async (input, ctx) => {
  requireUnscopedUserToken(ctx, "manage services");
  const org = await requireOrgRole(ctx, input.org, "admin");
  return ctx.db.transaction().execute(async (trx) => {
    const row = await findLiveService(trx, org.id, input.name);
    if (!row) {
      throw serviceNotFound(org.slug, input.name);
    }
    const now = ctx.now();
    const at = now.toISOString();
    const principal = servicePrincipal(org.slug, row.name);
    const deleted = await trx
      .updateTable("services")
      .set({ deleted_at: at })
      .where("id", "=", row.id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (Number(deleted.numUpdatedRows) === 0) {
      throw serviceNotFound(org.slug, input.name);
    }
    const revoked = await trx
      .updateTable("tokens")
      .set({ revoked_at: at })
      .where("principal", "=", principal)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    const removed = await trx
      .deleteFrom("grants")
      .where("org_id", "=", org.id)
      .where("principal", "=", principal)
      .executeTakeFirst();
    const revokedTokens = Number(revoked.numUpdatedRows);
    const removedGrants = Number(removed.numDeletedRows);
    await recordAudit(trx, ctx.principal, now, {
      orgId: org.id,
      action: "service.delete",
      target: principal,
      detail: { revoked_tokens: revokedTokens, removed_grants: removedGrants },
    });
    return {
      service: toService({ ...row, deleted_at: at }, org.slug),
      revoked_tokens: revokedTokens,
      removed_grants: removedGrants,
    };
  });
});
