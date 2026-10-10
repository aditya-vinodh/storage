import { randomBytes } from "node:crypto";
import { type Db, migrateToLatest, openDatabase } from "@storage/server";

export interface TestDatabase {
  db: Db;
  cleanup(): Promise<void>;
}

/** Postgres URL from STORAGE_TEST_DATABASE_URL, or undefined to test on in-memory SQLite. */
export const TEST_DATABASE_URL = process.env.STORAGE_TEST_DATABASE_URL || undefined;

/**
 * Opens a migrated, empty database. On Postgres each call gets its own schema,
 * so tests stay isolated without a database per test.
 */
export async function openTestDatabase(): Promise<TestDatabase> {
  if (TEST_DATABASE_URL === undefined) {
    const db = openDatabase("sqlite::memory:");
    await migrateToLatest(db);
    return { db, cleanup: () => db.destroy() };
  }
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const admin = openDatabase(TEST_DATABASE_URL);
  await admin.schema.createSchema(schema).execute();
  const url = new URL(TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const db = openDatabase(url.toString());
  await migrateToLatest(db);
  return {
    db,
    async cleanup() {
      await db.destroy();
      await admin.schema.dropSchema(schema).cascade().execute();
      await admin.destroy();
    },
  };
}
