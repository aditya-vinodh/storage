import { recordAudit } from "./audit.js";
import { linkUri, type Principal, requireLinkOperation } from "./auth.js";
import type { Db } from "./db/index.js";

const MAX_AUDITED_URI_LENGTH = 2000;

/**
 * For a share link, records the call in the audit log (design doc §8.6: every use is logged), then throws
 * `forbidden` if links can't call `operation`. Attempts outside the allowlist are logged too. A no-op for tokens.
 */
export async function checkLinkCall(
  db: Db,
  principal: Principal,
  now: Date,
  operation: string,
  input: unknown,
): Promise<void> {
  if (principal.link === null) {
    return;
  }
  const uri = (input as { uri?: unknown } | null)?.uri;
  await recordAudit(db, principal, now, {
    orgId: principal.link.orgId,
    action: "link.use",
    target: linkUri(principal.link),
    detail: { operation, ...(typeof uri === "string" ? { uri: uri.slice(0, MAX_AUDITED_URI_LENGTH) } : {}) },
  });
  requireLinkOperation(principal, operation);
}
