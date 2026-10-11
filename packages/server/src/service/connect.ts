import { ops, StorageError } from "@storage/core";
import { recordAudit } from "../audit.js";
import { hashToken, isUnscopedUserToken } from "../auth.js";
import { newId } from "../ids.js";
import { addSeconds, token } from "../signin/shared.js";
import { handle, type ServiceContext } from "./context.js";

export const CONNECT_TTL_SECONDS = 600;

/** The user id behind an unscoped user token; anything else can't connect or disconnect accounts. */
function requireConnectCaller(ctx: ServiceContext): string {
  if (!isUnscopedUserToken(ctx.principal)) {
    throw new StorageError("forbidden", "Connect accounts with the token from storage login.");
  }
  return ctx.principal.id.slice("user:".length);
}

export const connectStartHandler = handle(ops.connectStart, async (input, ctx) => {
  const userId = requireConnectCaller(ctx);
  if (ctx.connect === null) {
    throw new StorageError("unavailable", "GitHub isn't configured on this server.");
  }
  const at = ctx.now();
  const ticket = token();
  const expiresAt = addSeconds(at, CONNECT_TTL_SECONDS).toISOString();
  await ctx.db
    .insertInto("connect_tickets")
    .values({
      id: newId("ctk"),
      ticket_hash: hashToken(ticket),
      user_id: userId,
      provider: input.provider,
      created_at: at.toISOString(),
      expires_at: expiresAt,
      used_at: null,
    })
    .execute();
  return { url: `${ctx.connect.publicUrl}/connect/github/start?ticket=${ticket}`, expires_at: expiresAt };
});

export const disconnectHandler = handle(ops.disconnect, async (input, ctx) => {
  const userId = requireConnectCaller(ctx);
  const at = ctx.now();
  const disconnected = await ctx.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("connected_accounts")
      .select(["id", "subject", "login"])
      .where("user_id", "=", userId)
      .where("provider", "=", input.provider)
      .executeTakeFirst();
    if (!row) {
      return false;
    }
    const deleted = await trx.deleteFrom("connected_accounts").where("id", "=", row.id).executeTakeFirst();
    if (Number(deleted.numDeletedRows) === 0) {
      return false;
    }
    await recordAudit(trx, ctx.principal, at, {
      orgId: null,
      action: "account.disconnect",
      target: `user:${userId}`,
      detail: { provider: input.provider, id: row.subject, login: row.login },
    });
    return true;
  });
  return { provider: input.provider, disconnected };
});
