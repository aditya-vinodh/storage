import { randomBytes } from "node:crypto";
import { type Link, ops, parseUriOfKind, StorageError } from "@storage/core";
import { recordAudit } from "../audit.js";
import { hashToken, LINK_SECRET_PREFIX, linkUri } from "../auth.js";
import { newId } from "../ids.js";
import { handle } from "./context.js";
import { collectionUri, resolveCollection } from "./resolve.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const linkCreateHandler = handle(ops.linkCreate, async (input, ctx) => {
  const { linkMaxDays } = ctx.config;
  if (linkMaxDays === 0) {
    throw new StorageError("forbidden", "Share links are disabled on this server.");
  }
  const uri = parseUriOfKind(input.uri, ["collection", "prefix"]);
  if (input.expires_in_days > linkMaxDays) {
    throw new StorageError(
      "invalid_argument",
      `Share links can last at most ${linkMaxDays} days.`,
      `Pass expires_in_days of ${linkMaxDays} or less.`,
    );
  }
  const { org, collection } = await resolveCollection(ctx, uri, "admin");

  const now = ctx.now();
  const secret = `${LINK_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = newId("lnk");
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + input.expires_in_days * DAY_MS).toISOString();
  const name = input.name ?? null;
  const target = linkUri({ orgSlug: org.slug, collectionSlug: collection.slug, prefix: uri.path });
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .insertInto("links")
      .values({
        id,
        token_hash: hashToken(secret),
        org_id: org.id,
        collection_id: collection.id,
        prefix: uri.path,
        name,
        created_by: ctx.principal.id,
        created_at: createdAt,
        expires_at: expiresAt,
        last_used_at: null,
        revoked_at: null,
      })
      .execute();
    await recordAudit(trx, ctx.principal, now, {
      orgId: org.id,
      action: "link.create",
      target,
      detail: { link_id: id, name, expires_at: expiresAt },
    });
  });
  return {
    secret,
    link: {
      id,
      uri: target,
      name,
      created_by: ctx.principal.id,
      created_at: createdAt,
      expires_at: expiresAt,
      last_used_at: null,
      expired: false,
    },
  };
});

export const linkListHandler = handle(ops.linkList, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["collection"]);
  const { org, collection } = await resolveCollection(ctx, uri, "admin");
  const now = ctx.now().toISOString();
  const rows = await ctx.db
    .selectFrom("links")
    .selectAll()
    .where("collection_id", "=", collection.id)
    .where("revoked_at", "is", null)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .execute();
  const links: Link[] = rows.map((row) => ({
    id: row.id,
    uri: linkUri({ orgSlug: org.slug, collectionSlug: collection.slug, prefix: row.prefix }),
    name: row.name,
    created_by: row.created_by,
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    expired: row.expires_at <= now,
  }));
  return { uri: collectionUri(org.slug, collection.slug), links };
});

export const linkRevokeHandler = handle(ops.linkRevoke, async (input, ctx) => {
  const notFound = () => new StorageError("not_found", `Link ${input.id} not found.`);
  const row = await ctx.db
    .selectFrom("links as l")
    .innerJoin("collections as c", "c.id", "l.collection_id")
    .innerJoin("orgs as o", "o.id", "l.org_id")
    .select(["l.id", "l.prefix", "l.revoked_at", "o.id as org_id", "o.slug as org_slug", "c.slug as collection_slug"])
    .where("l.id", "=", input.id)
    .where("c.state", "!=", "deleted")
    .executeTakeFirst();
  if (!row) {
    throw notFound();
  }
  // Link ids reveal nothing to callers who can't administer the collection.
  try {
    await resolveCollection(
      ctx,
      { kind: "collection", org: row.org_slug, collection: row.collection_slug, path: "", version: null },
      "admin",
    );
  } catch (error) {
    if (error instanceof StorageError && (error.code === "not_found" || error.code === "forbidden")) {
      throw notFound();
    }
    throw error;
  }
  const uri = linkUri({ orgSlug: row.org_slug, collectionSlug: row.collection_slug, prefix: row.prefix });
  if (row.revoked_at !== null) {
    return { id: row.id, uri, revoked_at: row.revoked_at };
  }
  const now = ctx.now();
  const revokedAt = now.toISOString();
  // A concurrent revoke may win the guarded update; then report its time and record nothing.
  const winner = await ctx.db.transaction().execute(async (trx) => {
    const result = await trx
      .updateTable("links")
      .set({ revoked_at: revokedAt })
      .where("id", "=", row.id)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      const current = await trx
        .selectFrom("links")
        .select("revoked_at")
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      return current.revoked_at ?? revokedAt;
    }
    await recordAudit(trx, ctx.principal, now, {
      orgId: row.org_id,
      action: "link.revoke",
      target: uri,
      detail: { link_id: row.id },
    });
    return revokedAt;
  });
  return { id: row.id, uri, revoked_at: winner };
});
