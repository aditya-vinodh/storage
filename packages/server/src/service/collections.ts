import { highestRole, ops, parseUriOfKind, type Role, StorageError, scopeLikePattern } from "@storage/core";
import { linkUri, requireScope, roleOnOrg } from "../auth.js";
import { newId } from "../ids.js";
import { hasOrgScope, openGitHubToken } from "../memberships.js";
import { handle } from "./context.js";
import { collectionUri, decodeCursor, encodeCursor, findOrg, requireRole, toCollection } from "./resolve.js";

export const whoamiHandler = handle(ops.whoami, async (_input, ctx) => {
  const { link } = ctx.principal;
  if (link !== null) {
    const row = await ctx.db
      .selectFrom("links")
      .select(["name", "expires_at"])
      .where("id", "=", link.id)
      .executeTakeFirstOrThrow();
    return {
      principal: ctx.principal.id,
      orgs: [],
      token: {
        id: link.id,
        name: row.name,
        scopes: ctx.principal.token.scopes,
        default_delivery: null,
        expires_at: row.expires_at,
        allowed_tools: null,
        parent_id: null,
      },
      link: { uri: linkUri(link) },
      groups: [],
      connected: [],
    };
  }
  const rows = await ctx.db
    .selectFrom("grants as g")
    .innerJoin("orgs as o", "o.id", "g.org_id")
    .select(["o.slug", "o.name", "g.role"])
    .where("g.principal", "in", ctx.principal.memberOf)
    .where("g.collection_id", "is", null)
    .orderBy("o.slug")
    .execute();
  const byOrg = new Map<string, { slug: string; name: string; roles: Role[] }>();
  for (const row of rows) {
    const entry = byOrg.get(row.slug) ?? { slug: row.slug, name: row.name, roles: [] };
    entry.roles.push(row.role);
    byOrg.set(row.slug, entry);
  }
  const token = await ctx.db
    .selectFrom("tokens")
    .select(["name", "expires_at"])
    .where("id", "=", ctx.principal.token.id)
    .executeTakeFirstOrThrow();
  const connected = ctx.principal.id.startsWith("user:")
    ? await ctx.db
        .selectFrom("connected_accounts")
        .select(["subject", "login", "access_token", "token_scopes"])
        .where("user_id", "=", ctx.principal.id.slice("user:".length))
        .where("provider", "=", "github")
        .execute()
    : [];
  return {
    principal: ctx.principal.id,
    orgs: [...byOrg.values()].map((org) => ({
      slug: org.slug,
      name: org.name,
      role: highestRole(org.roles) ?? "reader",
    })),
    token: {
      id: ctx.principal.token.id,
      name: token.name,
      scopes: ctx.principal.token.scopes,
      default_delivery: ctx.principal.token.defaultDelivery,
      expires_at: token.expires_at,
      allowed_tools: ctx.principal.token.allowedTools,
      parent_id: ctx.principal.token.parentId,
    },
    groups: ctx.principal.groups,
    link: null,
    connected: connected.map((account) => ({
      provider: "github" as const,
      id: account.subject,
      login: account.login,
      // Without GitHub configured there is no box to open the token with, so only the stored fields can be checked.
      org_access: ctx.connect
        ? openGitHubToken(ctx.connect.box, account) !== null
        : account.access_token !== null && hasOrgScope(account.token_scopes),
    })),
  };
});

interface CollectionsCursor {
  created_at: string;
  id: string;
}

function isCollectionsCursor(value: unknown): value is CollectionsCursor {
  const v = value as Partial<CollectionsCursor> | null;
  return typeof v?.created_at === "string" && typeof v.id === "string";
}

export const collectionsHandler = handle(ops.collections, async (input, ctx) => {
  const members = ctx.principal.memberOf;
  let query = ctx.db
    .selectFrom("collections as c")
    .innerJoin("orgs as o", "o.id", "c.org_id")
    .selectAll("c")
    .select("o.slug as org_slug")
    .where("c.state", "!=", "deleted")
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom("grants as g")
            .select("g.id")
            .whereRef("g.org_id", "=", "c.org_id")
            .where("g.collection_id", "is", null)
            .where("g.principal", "in", members),
        ),
        eb.exists(
          eb
            .selectFrom("grants as g")
            .select("g.id")
            .whereRef("g.collection_id", "=", "c.id")
            .where("g.principal", "in", members),
        ),
      ]),
    );
  const { scopes } = ctx.principal.token;
  if (scopes !== null) {
    // Scopes with no match leave an empty `or`, which matches nothing.
    query = query.where((eb) =>
      eb.or(
        scopes.map((scope) => {
          const slash = scope.collection.indexOf("/");
          return eb.and([
            eb("o.slug", "=", scope.collection.slice(0, slash)),
            eb("c.slug", "like", scopeLikePattern(scope.collection.slice(slash + 1))),
          ]);
        }),
      ),
    );
  }
  if (input.org !== undefined) {
    query = query.where("o.slug", "=", input.org);
  }
  if (input.cursor !== undefined) {
    const after = decodeCursor(input.cursor, isCollectionsCursor);
    query = query.where((eb) =>
      eb.or([
        eb("c.created_at", "<", after.created_at),
        eb.and([eb("c.created_at", "=", after.created_at), eb("c.id", "<", after.id)]),
      ]),
    );
  }
  const rows = await query
    .orderBy("c.created_at", "desc")
    .orderBy("c.id", "desc")
    .limit(input.limit + 1)
    .execute();
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    collections: page.map((row) => toCollection(row, row.org_slug)),
    next_cursor: rows.length > input.limit && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null,
  };
});

export const createHandler = handle(ops.create, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["collection"]);
  const slug = uri.collection as string;
  requireScope(ctx.principal, uri.org, slug, "writer", collectionUri(uri.org, slug));
  const org = await findOrg(ctx, uri.org);
  const orgRole = org ? await roleOnOrg(ctx.db, ctx.principal, org.id) : null;
  if (!org || orgRole === null) {
    throw new StorageError("not_found", `Org ${uri.org} not found.`);
  }
  requireRole(orgRole, "writer", `org ${uri.org}`);

  const now = ctx.now().toISOString();
  const id = newId("col");
  await ctx.db
    .insertInto("collections")
    .values({
      id,
      org_id: org.id,
      slug,
      title: input.title ?? null,
      description: input.description ?? null,
      tags: JSON.stringify(input.tags ?? []),
      state: "active",
      lifecycle_rules: org.default_lifecycle_rules,
      created_by: ctx.principal.id,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(["org_id", "slug"]).doNothing())
    .execute();

  const row = await ctx.db
    .selectFrom("collections")
    .selectAll()
    .where("org_id", "=", org.id)
    .where("slug", "=", slug)
    .executeTakeFirstOrThrow();
  if (row.state === "deleted") {
    throw new StorageError("conflict", `The slug ${slug} belongs to a deleted collection in ${uri.org}.`);
  }
  return { ...toCollection(row, org.slug), created: row.id === id };
});
