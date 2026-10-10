import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { Migrator } from "kysely/migration";
import { migrationProvider } from "./migrations.js";
import type { Database } from "./schema.js";

export type { Database } from "./schema.js";
export type Db = Kysely<Database>;

/** Opens the metadata database. Only `sqlite:` URLs are supported so far; Postgres comes next. */
export function openDatabase(url: string): Db {
  if (!url.startsWith("sqlite:")) {
    throw new Error(`Unsupported database URL "${url}". Use sqlite:<path> or sqlite::memory:.`);
  }
  const file = url.slice("sqlite:".length);
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }
  const sqlite = new SQLite(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}

export async function migrateToLatest(db: Db): Promise<void> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  const { error, results } = await migrator.migrateToLatest();
  const failed = results?.find((result) => result.status === "Error");
  if (error || failed) {
    throw new Error(`Database migration ${failed?.migrationName ?? ""} failed: ${String(error)}`);
  }
}
