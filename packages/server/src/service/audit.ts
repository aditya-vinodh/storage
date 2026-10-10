import { type AuditAction, formatUri, ops, parseUriOfKind, StorageError } from "@storage/core";
import { roleOnOrg } from "../auth.js";
import { handle } from "./context.js";
import { decodeCursor, encodeCursor, findOrg, requireRole } from "./resolve.js";

interface AuditCursor {
  at: string;
  id: string;
}

function isAuditCursor(value: unknown): value is AuditCursor {
  const v = value as Partial<AuditCursor> | null;
  return typeof v?.at === "string" && typeof v.id === "string";
}

export const auditHandler = handle(ops.audit, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["org"]);
  if (ctx.principal.token.scopes !== null) {
    throw new StorageError(
      "forbidden",
      "Scoped tokens can't read the audit log.",
      "Use an unscoped token (from storage login).",
    );
  }
  const display = formatUri({ org: uri.org });
  const org = await findOrg(ctx, uri.org);
  const role = org ? await roleOnOrg(ctx.db, ctx.principal, org.id) : null;
  if (!org || role === null) {
    throw new StorageError("not_found", `Org ${display} not found.`);
  }
  requireRole(role, "admin", display);

  let query = ctx.db.selectFrom("audit_events").selectAll().where("org_id", "=", org.id);
  if (input.action !== undefined) {
    query = query.where("action", "=", input.action);
  }
  if (input.since !== undefined) {
    query = query.where("at", ">=", new Date(input.since).toISOString());
  }
  if (input.cursor !== undefined) {
    const after = decodeCursor(input.cursor, isAuditCursor);
    query = query.where((eb) =>
      eb.or([eb("at", "<", after.at), eb.and([eb("at", "=", after.at), eb("id", "<", after.id)])]),
    );
  }
  const rows = await query
    .orderBy("at", "desc")
    .orderBy("id", "desc")
    .limit(input.limit + 1)
    .execute();
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    events: page.map((row) => ({
      id: row.id,
      at: row.at,
      actor: row.actor,
      token_id: row.token_id,
      action: row.action as AuditAction,
      target: row.target,
      detail: JSON.parse(row.detail) as Record<string, unknown>,
    })),
    next_cursor: rows.length > input.limit && last ? encodeCursor({ at: last.at, id: last.id }) : null,
  };
});
