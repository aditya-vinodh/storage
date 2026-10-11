import { formatUri, ops, parseUriOfKind, ROLES, type Role, StorageError, servicePrincipal } from "@storage/core";
import type { Selectable } from "kysely";
import { recordAudit } from "../audit.js";
import { roleOnOrg } from "../auth.js";
import type { Db } from "../db/index.js";
import type { GrantsTable } from "../db/schema.js";
import { newId } from "../ids.js";
import { handle, type ServiceContext } from "./context.js";
import { collectionUri, findOrg, requireRole, resolveCollection } from "./resolve.js";
import { lockLiveService } from "./services.js";

type GrantRow = Selectable<GrantsTable>;

interface Target {
  orgId: string;
  orgSlug: string;
  /** Null for an org-level target. */
  collectionId: string | null;
  collectionSlug: string | null;
  /** The org or collection URI, as displayed. */
  uri: string;
}

/** Finds the org or collection a URI names and checks the caller's role on it. */
async function resolveTarget(ctx: ServiceContext, input: string, need: Role): Promise<Target> {
  const uri = parseUriOfKind(input, ["org", "collection"]);
  if (uri.collection !== null) {
    const { org, collection } = await resolveCollection(ctx, uri, need);
    return {
      orgId: org.id,
      orgSlug: org.slug,
      collectionId: collection.id,
      collectionSlug: collection.slug,
      uri: collectionUri(org.slug, collection.slug),
    };
  }
  const display = formatUri({ org: uri.org });
  // Scoped tokens never reach org-level grants. This needs no lookup, so it can't reveal whether the org exists.
  if (ctx.principal.token.scopes !== null) {
    throw new StorageError(
      "forbidden",
      "Scoped tokens can't read or change org-level grants.",
      "Use an unscoped token (from storage login).",
    );
  }
  const org = await findOrg(ctx, uri.org);
  const role = org ? await roleOnOrg(ctx.db, ctx.principal, org.id) : null;
  if (!org || role === null) {
    throw new StorageError("not_found", `Org ${display} not found.`);
  }
  requireRole(role, need, display);
  return { orgId: org.id, orgSlug: org.slug, collectionId: null, collectionSlug: null, uri: display };
}

function toGrant(row: GrantRow, email: string | null, target: Target) {
  const level = row.collection_id === null ? ("org" as const) : ("collection" as const);
  return {
    principal: row.principal,
    email,
    github_login: null,
    role: row.role,
    uri: level === "org" ? formatUri({ org: target.orgSlug }) : target.uri,
    level,
    created_at: row.created_at,
  };
}

async function emailsFor(db: Db, principals: string[]): Promise<Map<string, string | null>> {
  const ids = principals.filter((p) => p.startsWith("user:")).map((p) => p.slice("user:".length));
  const emails = new Map<string, string | null>();
  if (ids.length === 0) {
    return emails;
  }
  const users = await db.selectFrom("users").select(["id", "email"]).where("id", "in", ids).execute();
  for (const user of users) {
    emails.set(`user:${user.id}`, user.email);
  }
  return emails;
}

function sortGrants(rows: GrantRow[]): GrantRow[] {
  return [...rows].sort(
    (a, b) =>
      ROLES.indexOf(b.role) - ROLES.indexOf(a.role) ||
      (a.principal < b.principal ? -1 : a.principal > b.principal ? 1 : 0),
  );
}

/** The user id a principal input names, or the lowercased email to look up. */
function parsePrincipalInput(input: string): { id: string } | { email: string } {
  const value = input.slice("user:".length);
  return value.startsWith("usr_") && !value.includes("@") ? { id: value } : { email: value.trim().toLowerCase() };
}

/**
 * Resolves a `service:<name>` or `service:<org>/<name>` input to its principal string in the target's org.
 * `principal` is null if the org has no such live service.
 */
async function findServicePrincipal(
  db: Db,
  target: Target,
  input: string,
): Promise<{ principal: string | null; name: string }> {
  const rest = input.slice("service:".length);
  const slash = rest.indexOf("/");
  const org = slash === -1 ? target.orgSlug : rest.slice(0, slash);
  const name = slash === -1 ? rest : rest.slice(slash + 1);
  if (org !== target.orgSlug) {
    throw new StorageError(
      "invalid_argument",
      `Services can only be granted access in their own org (${formatUri({ org })}).`,
    );
  }
  // share runs this in its transaction, so the lock keeps a concurrent service_delete from missing the grant.
  const live = await lockLiveService(db, org, name);
  return { principal: live ? servicePrincipal(org, name) : null, name };
}

export function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "23505";
}

/** Reruns a transaction once if it lost a race on a unique index; the rerun then sees the winner's row. */
export async function retryOnUniqueViolation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    return run();
  }
}

/**
 * True if the org has an org-level admin grant other than `exceptId`. It first takes the org's row lock with a
 * no-op update (SQLite already serializes writers), so two concurrent demotions can't each count the other.
 */
async function otherOrgAdmins(db: Db, orgId: string, exceptId: string): Promise<boolean> {
  await db
    .updateTable("orgs")
    .set((eb) => ({ name: eb.ref("name") }))
    .where("id", "=", orgId)
    .execute();
  const other = await db
    .selectFrom("grants")
    .select("id")
    .where("org_id", "=", orgId)
    .where("collection_id", "is", null)
    .where("role", "=", "admin")
    .where("id", "!=", exceptId)
    .executeTakeFirst();
  return other !== undefined;
}

function findGrant(db: Db, target: Target, principal: string): Promise<GrantRow | undefined> {
  let query = db.selectFrom("grants").selectAll().where("org_id", "=", target.orgId).where("principal", "=", principal);
  query =
    target.collectionId === null
      ? query.where("collection_id", "is", null)
      : query.where("collection_id", "=", target.collectionId);
  return query.executeTakeFirst();
}

export const grantsHandler = handle(ops.grants, async (input, ctx) => {
  const target = await resolveTarget(ctx, input.uri, "reader");
  const orgRows = await ctx.db
    .selectFrom("grants")
    .selectAll()
    .where("org_id", "=", target.orgId)
    .where("collection_id", "is", null)
    .execute();
  const collectionRows =
    target.collectionId === null
      ? []
      : await ctx.db.selectFrom("grants").selectAll().where("collection_id", "=", target.collectionId).execute();
  const rows = [...sortGrants(orgRows), ...sortGrants(collectionRows)];
  const emails = await emailsFor(
    ctx.db,
    rows.map((row) => row.principal),
  );
  return {
    uri: target.uri,
    grants: rows.map((row) => toGrant(row, emails.get(row.principal) ?? null, target)),
  };
});

/** Placeholder until GitHub principals are implemented. */
function rejectGitHubUser(input: string): void {
  if (input.startsWith("github-user:")) {
    throw new StorageError("invalid_argument", "GitHub isn't configured on this server.");
  }
}

export const shareHandler = handle(ops.share, async (input, ctx) => {
  rejectGitHubUser(input.principal);
  const target = await resolveTarget(ctx, input.uri, "admin");
  const who = parsePrincipalInput(input.principal);
  const orgUri = formatUri({ org: target.orgSlug });

  return retryOnUniqueViolation(() =>
    ctx.db.transaction().execute(async (trx) => {
      const now = ctx.now();
      let principal: string;
      let email: string | null = null;
      if (input.principal.startsWith("service:")) {
        const found = await findServicePrincipal(trx, target, input.principal);
        if (found.principal === null) {
          throw new StorageError(
            "invalid_argument",
            `No service ${found.name} in ${orgUri}.`,
            `Create it with: storage service create ${target.orgSlug} ${found.name}`,
          );
        }
        principal = found.principal;
      } else {
        let user: { id: string; email: string | null } | undefined;
        if ("id" in who) {
          user = await trx.selectFrom("users").select(["id", "email"]).where("id", "=", who.id).executeTakeFirst();
          if (!user) {
            throw new StorageError("invalid_argument", `No user ${who.id}.`);
          }
        } else {
          user = await trx
            .selectFrom("users")
            .select(["id", "email"])
            .where("email", "=", who.email)
            .executeTakeFirst();
          if (!user) {
            user = { id: newId("usr"), email: who.email };
            await trx
              .insertInto("users")
              .values({ id: user.id, email: user.email, name: null, created_at: now.toISOString() })
              .execute();
          }
        }
        principal = `user:${user.id}`;
        email = user.email;
      }

      const existing = await findGrant(trx, target, principal);
      if (existing && existing.role === input.role) {
        return { grant: toGrant(existing, email, target), changed: false, previous_role: existing.role };
      }

      if (existing) {
        if (
          target.collectionId === null &&
          existing.role === "admin" &&
          !(await otherOrgAdmins(trx, target.orgId, existing.id))
        ) {
          throw new StorageError(
            "precondition_failed",
            `Can't demote the last admin of ${orgUri}.`,
            "Grant admin to someone else first.",
          );
        }
        await trx.updateTable("grants").set({ role: input.role }).where("id", "=", existing.id).execute();
        await recordAudit(trx, ctx.principal, now, {
          orgId: target.orgId,
          action: "grant.update",
          target: target.uri,
          detail: { principal, role: input.role, previous_role: existing.role },
        });
        return {
          grant: toGrant({ ...existing, role: input.role }, email, target),
          changed: true,
          previous_role: existing.role,
        };
      }

      const row: GrantRow = {
        id: newId("grt"),
        principal,
        role: input.role,
        org_id: target.orgId,
        collection_id: target.collectionId,
        created_at: now.toISOString(),
      };
      await trx.insertInto("grants").values(row).execute();
      await recordAudit(trx, ctx.principal, now, {
        orgId: target.orgId,
        action: "grant.create",
        target: target.uri,
        detail: { principal, role: input.role },
      });
      return { grant: toGrant(row, email, target), changed: true, previous_role: null };
    }),
  );
});

export const unshareHandler = handle(ops.unshare, async (input, ctx) => {
  rejectGitHubUser(input.principal);
  const target = await resolveTarget(ctx, input.uri, "admin");
  const who = parsePrincipalInput(input.principal);
  const orgUri = formatUri({ org: target.orgSlug });

  const isService = input.principal.startsWith("service:");
  const user = isService
    ? undefined
    : "id" in who
      ? await ctx.db.selectFrom("users").select(["id", "email"]).where("id", "=", who.id).executeTakeFirst()
      : await ctx.db.selectFrom("users").select(["id", "email"]).where("email", "=", who.email).executeTakeFirst();

  const notFound = async (db: Db, principal: string | null): Promise<StorageError> => {
    let hint: string | undefined;
    if (target.collectionId !== null && principal !== null) {
      const orgGrant = await findGrant(db, { ...target, collectionId: null }, principal);
      if (orgGrant) {
        hint = `It has an org-level grant; remove it with: storage unshare ${orgUri} ${input.principal}`;
      }
    }
    return new StorageError("not_found", `${input.principal} has no grant on ${target.uri}.`, hint);
  };

  let principal: string;
  let email: string | null = null;
  if (isService) {
    const found = await findServicePrincipal(ctx.db, target, input.principal);
    if (found.principal === null) {
      throw await notFound(ctx.db, null);
    }
    principal = found.principal;
  } else {
    if (!user) {
      throw await notFound(ctx.db, null);
    }
    principal = `user:${user.id}`;
    email = user.email;
  }

  return ctx.db.transaction().execute(async (trx) => {
    const existing = await findGrant(trx, target, principal);
    if (!existing) {
      throw await notFound(trx, principal);
    }
    if (
      target.collectionId === null &&
      existing.role === "admin" &&
      !(await otherOrgAdmins(trx, target.orgId, existing.id))
    ) {
      throw new StorageError(
        "precondition_failed",
        `Can't remove the last admin of ${orgUri}.`,
        "Grant admin to someone else first.",
      );
    }
    await trx.deleteFrom("grants").where("id", "=", existing.id).execute();
    await recordAudit(trx, ctx.principal, ctx.now(), {
      orgId: target.orgId,
      action: "grant.delete",
      target: target.uri,
      detail: { principal, role: existing.role },
    });
    return { removed: toGrant(existing, email, target) };
  });
});
