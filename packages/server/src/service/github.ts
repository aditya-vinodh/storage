import { formatUri, ops, parseUriOfKind, StorageError } from "@storage/core";
import type { Selectable } from "kysely";
import { recordAudit } from "../audit.js";
import { hashToken, isUnscopedUserToken } from "../auth.js";
import type { GithubInstallationsTable } from "../db/schema.js";
import { newId } from "../ids.js";
import { addSeconds, token } from "../signin/shared.js";
import { CONNECT_TTL_SECONDS } from "./connect.js";
import { handle } from "./context.js";
import { requireOrgRole, requireUnscopedUserToken } from "./services.js";

type InstallationRow = Selectable<GithubInstallationsTable>;

function toInstallation(row: InstallationRow) {
  return {
    installation_id: row.installation_id,
    account_login: row.account_login,
    account_type: row.account_type,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export const githubInstallStartHandler = handle(ops.githubInstallStart, async (input, ctx) => {
  if (!isUnscopedUserToken(ctx.principal)) {
    throw new StorageError("forbidden", "Install the GitHub App with the token from storage login.");
  }
  if (ctx.githubApp === null) {
    throw new StorageError("unavailable", "The GitHub App isn't configured on this server.");
  }
  if (!ctx.googleSignIn || ctx.publicUrl === null) {
    throw new StorageError("unavailable", "Installing the GitHub App needs Google sign-in on this server.");
  }
  const org = await requireOrgRole(ctx, parseUriOfKind(input.uri, ["org"]).org, "admin");
  const userId = ctx.principal.id.slice("user:".length);
  const at = ctx.now();
  const ticket = token();
  const expiresAt = addSeconds(at, CONNECT_TTL_SECONDS).toISOString();
  await ctx.db
    .insertInto("connect_tickets")
    .values({
      id: newId("ctk"),
      ticket_hash: hashToken(ticket),
      user_id: userId,
      provider: "github-app",
      org_id: org.id,
      created_at: at.toISOString(),
      expires_at: expiresAt,
      used_at: null,
    })
    .execute();
  return { url: `${ctx.publicUrl}/github/install/start?ticket=${ticket}`, expires_at: expiresAt };
});

export const githubInstallationListHandler = handle(ops.githubInstallationList, async (input, ctx) => {
  requireUnscopedUserToken(ctx, "list GitHub App installations");
  const org = await requireOrgRole(ctx, parseUriOfKind(input.uri, ["org"]).org, "reader");
  const rows = await ctx.db
    .selectFrom("github_installations")
    .selectAll()
    .where("org_id", "=", org.id)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return { uri: formatUri({ org: org.slug }), installations: rows.map(toInstallation) };
});

export const githubInstallationRemoveHandler = handle(ops.githubInstallationRemove, async (input, ctx) => {
  requireUnscopedUserToken(ctx, "remove GitHub App installations");
  const org = await requireOrgRole(ctx, parseUriOfKind(input.uri, ["org"]).org, "admin");
  const uri = formatUri({ org: org.slug });
  const at = ctx.now();
  const removed = await ctx.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("github_installations")
      .selectAll()
      .where("org_id", "=", org.id)
      .where("installation_id", "=", input.installation_id)
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    const deleted = await trx.deleteFrom("github_installations").where("id", "=", row.id).executeTakeFirst();
    if (Number(deleted.numDeletedRows) === 0) {
      return null;
    }
    await recordAudit(trx, ctx.principal, at, {
      orgId: org.id,
      action: "github.uninstall",
      target: uri,
      detail: { installation_id: row.installation_id, account: row.account_login },
    });
    return row;
  });
  if (removed === null) {
    throw new StorageError(
      "not_found",
      `Installation ${input.installation_id} isn't linked to ${uri}.`,
      `Run \`storage github list ${uri}\` to see the linked installations.`,
    );
  }
  return { uri, removed: toInstallation(removed) };
});
