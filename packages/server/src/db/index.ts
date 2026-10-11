import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import SQLite from "better-sqlite3";
import { Kysely, PostgresAdapter, PostgresDialect, SqliteDialect, sql } from "kysely";
import { Migrator } from "kysely/migration";
import pg from "pg";
import { migrationProvider } from "./migrations.js";
import type { Database } from "./schema.js";

export type { Database } from "./schema.js";
export type Db = Kysely<Database>;

const PG_INT8_OID = 20;

/**
 * `pg` returns int8 (`bigint`) columns as strings because they can exceed
 * 2^53. Sizes are capped far below that, so read them as numbers instead.
 */
const pgTypes = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === PG_INT8_OID && format !== "binary") {
      return (value: string) => {
        const number = Number(value);
        if (!Number.isSafeInteger(number)) {
          throw new Error(`int8 value ${value} is too large to read as a number.`);
        }
        return number;
      };
    }
    return format === undefined ? pg.types.getTypeParser(oid) : pg.types.getTypeParser(oid, format);
  },
} as pg.CustomTypesConfig;

function openSqlite(file: string): Db {
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }
  const sqlite = new SQLite(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}

function openPostgres(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, types: pgTypes });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/** Opens the metadata database: `sqlite:<path>`, `sqlite::memory:`, or a `postgres://` URL. */
export function openDatabase(url: string): Db {
  if (url.startsWith("sqlite:")) {
    return openSqlite(url.slice("sqlite:".length));
  }
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return openPostgres(url);
  }
  throw new Error(`Unsupported database URL "${url}". Use sqlite:<path>, sqlite::memory:, or postgres://….`);
}

export function isPostgres(db: Db): boolean {
  return db.getExecutor().adapter instanceof PostgresAdapter;
}

export async function createMigrator(db: Db): Promise<Migrator> {
  // Kysely finds its migration tables in any schema unless told which one, so
  // pin them to the connection's schema when several apps share a database.
  const migrationTableSchema = isPostgres(db)
    ? (await sql<{ schema: string }>`select current_schema() as schema`.execute(db)).rows[0]?.schema
    : undefined;
  return new Migrator({
    db,
    provider: migrationProvider,
    ...(migrationTableSchema ? { migrationTableSchema } : {}),
  });
}

export async function migrateToLatest(db: Db): Promise<void> {
  const migrator = await createMigrator(db);
  const { error, results } = await migrator.migrateToLatest();
  const failed = results?.find((result) => result.status === "Error");
  if (error || failed) {
    throw new Error(`Database migration ${failed?.migrationName ?? ""} failed: ${String(error)}`);
  }
}
