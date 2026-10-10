import {
  type Collection,
  formatUri,
  formatVersion,
  type ParsedUri,
  type Role,
  roleAtLeast,
  StorageError,
  type Version,
} from "@storage/core";
import type { Selectable } from "kysely";
import { requireScope, roleOnCollection, roleOnOrg, scopeRole } from "../auth.js";
import type { CollectionsTable, ObjectsTable, OrgsTable, VersionsTable } from "../db/schema.js";
import type { ServiceContext } from "./context.js";

export type OrgRow = Selectable<OrgsTable>;
export type CollectionRow = Selectable<CollectionsTable>;
export type ObjectRow = Selectable<ObjectsTable>;
export type VersionRow = Selectable<VersionsTable>;

export interface ResolvedCollection {
  org: OrgRow;
  collection: CollectionRow;
  role: Role;
}

export function collectionUri(org: string, slug: string): string {
  return formatUri({ org, collection: slug });
}

export function objectUri(org: string, slug: string, path: string): string {
  return formatUri({ org, collection: slug, path });
}

export function requireRole(have: Role, need: Role, what: string): void {
  if (!roleAtLeast(have, need)) {
    throw new StorageError("forbidden", `You have ${have} access to ${what}; this needs ${need}.`);
  }
}

export async function findOrg(ctx: ServiceContext, slug: string): Promise<OrgRow | undefined> {
  return ctx.db.selectFrom("orgs").selectAll().where("slug", "=", slug).executeTakeFirst();
}

/**
 * Finds a collection and checks the caller's role on it. Collections the caller
 * can't read are reported as not found, so their existence isn't revealed.
 */
export async function resolveCollection(ctx: ServiceContext, uri: ParsedUri, need: Role): Promise<ResolvedCollection> {
  if (uri.collection === null) {
    throw new StorageError("invalid_argument", "Expected a URI that names a collection.");
  }
  const display = collectionUri(uri.org, uri.collection);
  // The scope check comes first: it needs no lookup, so it can't reveal whether the collection exists.
  requireScope(ctx.principal, uri.org, uri.collection, need, display);
  const org = await findOrg(ctx, uri.org);
  const collection = org
    ? await ctx.db
        .selectFrom("collections")
        .selectAll()
        .where("org_id", "=", org.id)
        .where("slug", "=", uri.collection)
        .where("state", "!=", "deleted")
        .executeTakeFirst()
    : undefined;
  const role =
    org && collection
      ? await roleOnCollection(ctx.db, ctx.principal, org.id, collection.id, uri.org, uri.collection)
      : null;
  if (!org || !collection || role === null) {
    const orgRole = org && !collection ? await roleOnOrg(ctx.db, ctx.principal, org.id) : null;
    const scope = scopeRole(ctx.principal, uri.org, uri.collection);
    const canCreate =
      orgRole !== null && roleAtLeast(orgRole, "writer") && scope !== null && roleAtLeast(scope, "writer");
    throw new StorageError(
      "not_found",
      `Collection ${display} not found.`,
      canCreate ? `Create it with: storage create ${display}` : undefined,
    );
  }
  requireRole(role, need, display);
  return { org, collection, role };
}

export interface ResolvedVersion {
  object: ObjectRow;
  version: VersionRow;
}

/** Finds a live object and the version selected by the URI (the current version by default). */
export async function resolveObjectVersion(
  ctx: ServiceContext,
  resolved: ResolvedCollection,
  uri: ParsedUri,
): Promise<ResolvedVersion> {
  const display = objectUri(resolved.org.slug, resolved.collection.slug, uri.path);
  const object = await ctx.db
    .selectFrom("objects")
    .selectAll()
    .where("collection_id", "=", resolved.collection.id)
    .where("path", "=", uri.path)
    .executeTakeFirst();
  if (!object || object.deleted_at !== null || object.current_version === null) {
    throw new StorageError("not_found", `Object ${display} not found.`);
  }

  let query = ctx.db.selectFrom("versions").selectAll().where("object_id", "=", object.id);
  if (uri.version === null) {
    query = query.where("version", "=", object.current_version);
  } else if (uri.version.kind === "number") {
    query = query.where("version", "=", uri.version.version);
  } else {
    query = query.where("blob_sha256", "=", uri.version.sha256).orderBy("version", "desc").limit(1);
  }
  const version = await query.executeTakeFirst();
  if (!version) {
    throw new StorageError(
      "not_found",
      `${display} has no version ${formatVersion(uri.version ?? { kind: "number", version: object.current_version })}.`,
    );
  }
  return { object, version };
}

export function toCollection(row: CollectionRow, orgSlug: string): Collection {
  return {
    uri: collectionUri(orgSlug, row.slug),
    org: orgSlug,
    slug: row.slug,
    title: row.title,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    state: row.state,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toVersion(row: VersionRow, uri: string, path: string): Version {
  return {
    uri,
    path,
    version: row.version,
    sha256: row.blob_sha256,
    size: Number(row.size),
    content_type: row.content_type,
    description: row.description,
    meta: JSON.parse(row.meta) as Record<string, string>,
    uploaded_by: row.uploaded_by,
    uploaded_at: row.uploaded_at,
  };
}

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T>(cursor: string, guard: (value: unknown) => value is T): T {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    value = undefined;
  }
  if (!guard(value)) {
    throw new StorageError(
      "invalid_argument",
      "Invalid cursor.",
      "Pass next_cursor from the previous response unchanged.",
    );
  }
  return value;
}
