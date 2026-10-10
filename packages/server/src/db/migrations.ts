import type { Kysely } from "kysely";
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

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return { "0001_initial": initial };
  },
};
