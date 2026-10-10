import { randomBytes } from "node:crypto";
import {
  type BlobStore,
  type Db,
  FilesystemBlobStore,
  migrateToLatest,
  openDatabase,
  S3BlobStore,
  type Signer,
} from "@storage/server";

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

/** S3-compatible endpoint from STORAGE_TEST_S3_ENDPOINT, or undefined to test on the filesystem driver. */
export const TEST_S3_ENDPOINT = process.env.STORAGE_TEST_S3_ENDPOINT || undefined;

/**
 * The blob store under test. On S3 every harness shares one bucket; blob keys
 * start with a fresh org id, so tests don't see each other's blobs.
 */
export async function openTestBlobStore(options: {
  dir: string;
  publicUrl: string;
  signer: Signer;
}): Promise<BlobStore> {
  if (TEST_S3_ENDPOINT === undefined) {
    return new FilesystemBlobStore({ root: options.dir, publicUrl: options.publicUrl, signer: options.signer });
  }
  const store = new S3BlobStore({
    bucket: process.env.STORAGE_TEST_S3_BUCKET || "storage-test",
    region: "us-east-1",
    endpoint: TEST_S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.STORAGE_TEST_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.STORAGE_TEST_S3_SECRET_ACCESS_KEY ?? "",
    },
  });
  await store.ensureBucket();
  return store;
}
