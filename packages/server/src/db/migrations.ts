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

const signIn: Migration = {
  // biome-ignore lint/suspicious/noExplicitAny: migrations must not depend on the evolving Database type
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("identities")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("user_id", "text", (c) => c.notNull().references("users.id"))
      .addColumn("provider", "text", (c) => c.notNull())
      .addColumn("subject", "text", (c) => c.notNull())
      .addColumn("email", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("last_sign_in_at", "text", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("identities_provider_subject_unique")
      .on("identities")
      .columns(["provider", "subject"])
      .unique()
      .execute();
    await db.schema.createIndex("identities_user_idx").on("identities").column("user_id").execute();

    await db.schema
      .createTable("device_authorizations")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("device_code_hash", "text", (c) => c.notNull().unique())
      .addColumn("user_code", "text", (c) => c.notNull().unique())
      .addColumn("client_id", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("user_id", "text")
      .addColumn("interval_seconds", "integer", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text", (c) => c.notNull())
      .addColumn("last_polled_at", "text")
      .addColumn("approved_at", "text")
      .addColumn("token_id", "text")
      .execute();

    await db.schema
      .createTable("sign_in_states")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("state_hash", "text", (c) => c.notNull().unique())
      .addColumn("browser_hash", "text", (c) => c.notNull())
      .addColumn("provider", "text", (c) => c.notNull())
      .addColumn("code_verifier", "text", (c) => c.notNull())
      .addColumn("device_authorization_id", "text", (c) => c.notNull().references("device_authorizations.id"))
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text", (c) => c.notNull())
      .addColumn("used_at", "text")
      .execute();
  },
};

const mcpOauth: Migration = {
  // biome-ignore lint/suspicious/noExplicitAny: migrations must not depend on the evolving Database type
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("oauth_clients")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("client_name", "text")
      .addColumn("redirect_uris", "text", (c) => c.notNull())
      .addColumn("grant_types", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("oauth_authorization_requests")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("client_id", "text", (c) => c.notNull().references("oauth_clients.id"))
      .addColumn("redirect_uri", "text", (c) => c.notNull())
      .addColumn("state", "text")
      .addColumn("code_challenge", "text", (c) => c.notNull())
      .addColumn("resource", "text")
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("user_id", "text")
      .addColumn("code_hash", "text", (c) => c.unique())
      .addColumn("code_expires_at", "text")
      .addColumn("approved_at", "text")
      .addColumn("token_id", "text")
      .addColumn("consent_hash", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("oauth_refresh_tokens")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("token_hash", "text", (c) => c.notNull().unique())
      .addColumn("token_id", "text", (c) => c.notNull())
      .addColumn("client_id", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text", (c) => c.notNull())
      .addColumn("used_at", "text")
      .execute();
    await db.schema
      .createIndex("oauth_refresh_tokens_token_idx")
      .on("oauth_refresh_tokens")
      .column("token_id")
      .execute();

    await db.schema.alterTable("tokens").addColumn("client_id", "text").execute();

    // Sign-in states live at most ten minutes, so the table is recreated rather than altered.
    await db.schema.dropTable("sign_in_states").execute();
    await db.schema
      .createTable("sign_in_states")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("state_hash", "text", (c) => c.notNull().unique())
      .addColumn("browser_hash", "text", (c) => c.notNull())
      .addColumn("provider", "text", (c) => c.notNull())
      .addColumn("code_verifier", "text", (c) => c.notNull())
      .addColumn("device_authorization_id", "text", (c) => c.references("device_authorizations.id"))
      .addColumn("authorization_request_id", "text", (c) => c.references("oauth_authorization_requests.id"))
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text", (c) => c.notNull())
      .addColumn("used_at", "text")
      .execute();
  },
};

const CHUNK = 500;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    out.push(items.slice(i, i + CHUNK));
  }
  return out;
}

const googleOnlySignIn: Migration = {
  // biome-ignore lint/suspicious/noExplicitAny: migrations must not depend on the evolving Database type
  async up(db: Kysely<any>) {
    // GitHub identities were linked by email, which isn't trustworthy. Revoke every token the affected users
    // signed in for, and their descendants, then drop the identities.
    const users = (await db.selectFrom("identities").select("user_id").where("provider", "=", "github").execute()).map(
      (row) => row.user_id as string,
    );
    const revoke = new Set<string>();
    for (const table of ["device_authorizations", "oauth_authorization_requests"]) {
      for (const ids of chunks(users)) {
        const rows = await db
          .selectFrom(table)
          .select("token_id")
          .where("user_id", "in", ids)
          .where("token_id", "is not", null)
          .execute();
        for (const row of rows) {
          revoke.add(row.token_id as string);
        }
      }
    }
    let frontier = [...revoke];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const ids of chunks(frontier)) {
        const rows = await db.selectFrom("tokens").select("id").where("parent_id", "in", ids).execute();
        for (const row of rows) {
          if (!revoke.has(row.id as string)) {
            revoke.add(row.id as string);
            next.push(row.id as string);
          }
        }
      }
      frontier = next;
    }
    const revokedAt = new Date().toISOString();
    for (const ids of chunks([...revoke])) {
      await db
        .updateTable("tokens")
        .set({ revoked_at: revokedAt })
        .where("id", "in", ids)
        .where("revoked_at", "is", null)
        .execute();
    }

    await db.deleteFrom("identities").where("provider", "=", "github").execute();
    await db.deleteFrom("sign_in_states").where("provider", "=", "github").execute();
  },
};

const connectedAccounts: Migration = {
  // biome-ignore lint/suspicious/noExplicitAny: migrations must not depend on the evolving Database type
  async up(db: Kysely<any>) {
    await db.schema
      .createTable("connected_accounts")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("user_id", "text", (c) => c.notNull().references("users.id"))
      .addColumn("provider", "text", (c) => c.notNull())
      .addColumn("subject", "text", (c) => c.notNull())
      .addColumn("login", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();
    await db.schema
      .createIndex("connected_accounts_provider_subject_unique")
      .on("connected_accounts")
      .columns(["provider", "subject"])
      .unique()
      .execute();
    await db.schema
      .createIndex("connected_accounts_user_provider_unique")
      .on("connected_accounts")
      .columns(["user_id", "provider"])
      .unique()
      .execute();

    await db.schema
      .createTable("connect_tickets")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("ticket_hash", "text", (c) => c.notNull().unique())
      .addColumn("user_id", "text", (c) => c.notNull().references("users.id"))
      .addColumn("provider", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text", (c) => c.notNull())
      .addColumn("used_at", "text")
      .execute();

    await db.schema
      .createTable("connect_states")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("state_hash", "text", (c) => c.notNull().unique())
      .addColumn("browser_hash", "text", (c) => c.notNull())
      .addColumn("user_id", "text", (c) => c.notNull().references("users.id"))
      .addColumn("provider", "text", (c) => c.notNull())
      .addColumn("step", "text", (c) => c.notNull())
      .addColumn("code_verifier", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("expires_at", "text", (c) => c.notNull())
      .addColumn("used_at", "text")
      .execute();
  },
};

const groupPrincipals: Migration = {
  async up(db) {
    await db.schema.alterTable("identities").addColumn("hd", "text").execute();

    // One column per statement: SQLite's ALTER TABLE can't add several at once.
    for (const column of [
      "access_token",
      "token_scopes",
      "memberships",
      "memberships_expires_at",
      "memberships_retry_at",
    ]) {
      await db.schema.alterTable("connected_accounts").addColumn(column, "text").execute();
    }

    await db.schema
      .createTable("github_principal_names")
      .addColumn("principal", "text", (c) => c.primaryKey())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();
  },
};

/** Indexes for the maintenance worker's purge and garbage collection (docs/specs/purge-and-restore.md). */
const lifecycle: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.createIndex("versions_blob_idx").on("versions").column("blob_sha256").execute();
    await db.schema.createIndex("uploads_org_sha256_idx").on("uploads").columns(["org_id", "sha256"]).execute();
    await db.schema.createIndex("uploads_version_idx").on("uploads").column("version_id").execute();
    await db.schema.createIndex("uploads_expires_idx").on("uploads").column("expires_at").execute();
    await db.schema.createIndex("objects_deleted_idx").on("objects").column("deleted_at").execute();
  },
};

/** Lifecycle rules on collections (docs/specs/lifecycle-rules.md). */
const lifecycleRules: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .alterTable("collections")
      .addColumn("lifecycle_rules", "text", (c) => c.notNull().defaultTo("[]"))
      .execute();
  },
};

/** Bindings to GitHub pull requests, GitHub App installations and org default lifecycle rules (docs/specs/bindings.md). */
const bindings: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("bindings")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
      .addColumn("collection_id", "text", (c) => c.notNull().unique().references("collections.id"))
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("target", "text", (c) => c.notNull())
      .addColumn("owner", "text", (c) => c.notNull())
      .addColumn("repo", "text", (c) => c.notNull())
      .addColumn("number", "integer", (c) => c.notNull())
      .addColumn("state", "text", (c) => c.notNull())
      .addColumn("closed_at", "text")
      .addColumn("merged_at", "text")
      .addColumn("source_updated_at", "text")
      .addColumn("polled_at", "text")
      .addColumn("poll_error", "text")
      .addColumn("installation_id", "text", (c) => c.notNull())
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addUniqueConstraint("bindings_org_target_unique", ["org_id", "target"])
      .execute();
    await db.schema
      .createIndex("bindings_pull_idx")
      .on("bindings")
      .columns(["installation_id", "owner", "repo", "number"])
      .execute();
    await db.schema.createIndex("bindings_poll_idx").on("bindings").columns(["state", "polled_at"]).execute();
    await db.schema
      .createTable("github_installations")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
      .addColumn("installation_id", "text", (c) => c.notNull())
      .addColumn("account_login", "text", (c) => c.notNull())
      .addColumn("account_type", "text", (c) => c.notNull())
      .addColumn("created_by", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addUniqueConstraint("github_installations_org_installation_unique", ["org_id", "installation_id"])
      .execute();
    await db.schema
      .createIndex("github_installations_installation_idx")
      .on("github_installations")
      .column("installation_id")
      .execute();
    // The install flow reuses the connect flow's tables (provider "github-app") with the org it links to.
    await db.schema.alterTable("connect_tickets").addColumn("org_id", "text").execute();
    await db.schema.alterTable("connect_states").addColumn("org_id", "text").execute();
    await db.schema
      .alterTable("orgs")
      .addColumn("default_lifecycle_rules", "text", (c) => c.notNull().defaultTo("[]"))
      .execute();
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
      "0006_sign_in": signIn,
      "0007_mcp_oauth": mcpOauth,
      "0008_google_only_sign_in": googleOnlySignIn,
      "0009_connected_accounts": connectedAccounts,
      "0010_group_principals": groupPrincipals,
      "0011_lifecycle": lifecycle,
      "0012_lifecycle_rules": lifecycleRules,
      "0013_bindings": bindings,
    };
  },
};
