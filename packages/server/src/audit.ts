import type { AuditAction } from "@storage/core";
import type { Principal } from "./auth.js";
import type { Db } from "./db/index.js";
import { newId } from "./ids.js";

export interface AuditEntry {
  /** Null for events outside any org, such as token changes. */
  orgId: string | null;
  action: AuditAction;
  /** A storage URI, or a token id for token events. */
  target: string;
  detail?: Record<string, unknown>;
}

/**
 * Appends an audit event (design doc §15). Pass the transaction that makes the change, when there is one,
 * so the event and the change commit together.
 */
export async function recordAudit(db: Db, principal: Principal, at: Date, entry: AuditEntry): Promise<void> {
  await db
    .insertInto("audit_events")
    .values({
      id: newId("aud"),
      org_id: entry.orgId,
      at: at.toISOString(),
      actor: principal.id,
      token_id: principal.token.id,
      action: entry.action,
      target: entry.target,
      detail: JSON.stringify(entry.detail ?? {}),
    })
    .execute();
}
