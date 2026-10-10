import { type Kysely, sql } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";

const initial: Migration = {
  // biome-ignore lint/suspicious/noExplicitAny: migrations must not depend on the evolving Database type
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("orgs")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("slug", "text", (c) => c.notNull().unique())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("users")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("email", "text", (c) => c.unique())
      .addColumn("name", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("tokens")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("token_hash", "text", (c) => c.notNull().unique())
      .addColumn("principal", "text", (c) => c.notNull())
      .addColumn("name", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text")
      .addColumn("last_used_at", "text")
      .execute();

    await db.schema
      .createTable("collections")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
      .addColumn("slug", "text", (c) => c.notNull())
      .addColumn("title", "text")
      .addColumn("description", "text")
      .addColumn("tags", "text", (c) => c.notNull().defaultTo("[]"))
      .addColumn("state", "text", (c) => c.notNull().defaultTo("active"))
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .addUniqueConstraint("collections_org_slug_unique", ["org_id", "slug"])
      .execute();

    await db.schema
      .createTable("grants")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("principal", "text", (c) => c.notNull())
      .addColumn("role", "text", (c) => c.notNull())
      .addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
      .addColumn("collection_id", "text", (c) => c.references("collections.id"))
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();
    await db.schema.createIndex("grants_principal_idx").on("grants").columns(["principal", "org_id"]).execute();

    await db.schema
      .createTable("objects")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("collection_id", "text", (c) => c.notNull().references("collections.id"))
      .addColumn("path", "text", (c) => c.notNull())
      .addColumn("current_version", "integer")
      .addColumn("deleted_at", "text")
      .addUniqueConstraint("objects_collection_path_unique", ["collection_id", "path"])
      .execute();

    await db.schema
      .createTable("versions")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("object_id", "text", (c) => c.notNull().references("objects.id"))
      .addColumn("version", "integer", (c) => c.notNull())
      .addColumn("blob_sha256", "text", (c) => c.notNull())
      .addColumn("size", "bigint", (c) => c.notNull())
      .addColumn("content_type", "text", (c) => c.notNull())
      .addColumn("description", "text")
      .addColumn("meta", "text", (c) => c.notNull().defaultTo("{}"))
      .addColumn("uploaded_by", "text", (c) => c.notNull())
      .addColumn("uploaded_at", "text", (c) => c.notNull())
      .addColumn("idempotency_key", "text")
      .addUniqueConstraint("versions_object_version_unique", ["object_id", "version"])
      .addUniqueConstraint("versions_object_idempotency_unique", ["object_id", "idempotency_key"])
      .execute();

    await db.schema
      .createTable("blobs")
      .addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
      .addColumn("sha256", "text", (c) => c.notNull())
      .addColumn("size", "bigint", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("blobs_pk", ["org_id", "sha256"])
      .execute();

    await db.schema
      .createTable("uploads")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
      .addColumn("collection_id", "text", (c) => c.notNull().references("collections.id"))
      .addColumn("path", "text", (c) => c.notNull())
      .addColumn("sha256", "text", (c) => c.notNull())
      .addColumn("size", "bigint", (c) => c.notNull())
      .addColumn("content_type", "text", (c) => c.notNull())
      .addColumn("description", "text")
      .addColumn("meta", "text", (c) => c.notNull().defaultTo("{}"))
      .addColumn("if_match", "text")
      .addColumn("idempotency_key", "text")
      .addColumn("transfer_required", "integer", (c) => c.notNull())
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text", (c) => c.notNull())
      .addColumn("version_id", "text", (c) => c.references("versions.id"))
      .execute();
  },
};

const tokenScopes: Migration = {
  // biome-ignore lint/suspicious/noExplicitAny: migrations must not depend on the evolving Database type
  async up(db: Kysely<any>) {
    await db.schema.alterTable("tokens").addColumn("scopes", "text").execute();
    await db.schema.alterTable("tokens").addColumn("default_delivery", "text").execute();
    await db.schema.alterTable("tokens").addColumn("revoked_at", "text").execute();
    await db.schema.createIndex("tokens_principal_idx").on("tokens").column("principal").execute();
  },
};

const auditAndGrants: Migration = {
  // biome-ignore lint/suspicious/noExplicitAny: migrations must not depend on the evolving Database type
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("audit_events")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("org_id", "text", (c) => c.references("orgs.id"))
      .addColumn("at", "text", (c) => c.notNull())
      .addColumn("actor", "text", (c) => c.notNull())
      .addColumn("token_id", "text")
      .addColumn("action", "text", (c) => c.notNull())
      .addColumn("target", "text", (c) => c.notNull())
      .addColumn("detail", "text", (c) => c.notNull().defaultTo("{}"))
      .execute();
    await db.schema.createIndex("audit_events_org_at_idx").on("audit_events").columns(["org_id", "at", "id"]).execute();

    // NULLs compare as distinct in a unique constraint, so org-level and collection-level grants each get a
    // partial unique index. Both SQLite and Postgres support partial indexes.
    await db.schema
      .createIndex("grants_org_level_unique")
      .on("grants")
      .columns(["principal", "org_id"])
      .unique()
      .where(sql<boolean>`collection_id is null`)
      .execute();
    await db.schema
      .createIndex("grants_collection_level_unique")
      .on("grants")
      .columns(["principal", "collection_id"])
      .unique()
      .where(sql<boolean>`collection_id is not null`)
      .execute();
  },
};

const links: Migration = {
  // biome-ignore lint/suspicious/noExplicitAny: migrations must not depend on the evolving Database type
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("links")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("token_hash", "text", (c) => c.notNull().unique())
      .addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
      .addColumn("collection_id", "text", (c) => c.notNull().references("collections.id"))
      .addColumn("prefix", "text", (c) => c.notNull().defaultTo(""))
      .addColumn("name", "text")
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text", (c) => c.notNull())
      .addColumn("last_used_at", "text")
      .addColumn("revoked_at", "text")
      .execute();
    await db.schema.createIndex("links_collection_idx").on("links").columns(["collection_id", "created_at"]).execute();
  },
};

const serviceTokens: Migration = {
  // biome-ignore lint/suspicious/noExplicitAny: migrations must not depend on the evolving Database type
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("services")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("deleted_at", "text")
      .execute();
    await db.schema
      .createIndex("services_org_name_live_unique")
      .on("services")
      .columns(["org_id", "name"])
      .unique()
      .where(sql<boolean>`deleted_at is null`)
      .execute();
    await db.schema.alterTable("tokens").addColumn("allowed_tools", "text").execute();
    await db.schema.alterTable("tokens").addColumn("parent_id", "text").execute();
    await db.schema.createIndex("tokens_parent_idx").on("tokens").column("parent_id").execute();
  },
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return {
      "0001_initial": initial,
      "0002_token_scopes": tokenScopes,
      "0003_audit_and_grants": auditAndGrants,
      "0004_links": links,
      "0005_service_tokens": serviceTokens,
    };
  },
};
