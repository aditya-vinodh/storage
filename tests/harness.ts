import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { ApiClient, type RunnerContext } from "@storage/client";
import type { Role } from "@storage/core";
import {
  bootstrapAdmin,
  createApp,
  createUserToken,
  type Db,
  FilesystemBlobStore,
  migrateToLatest,
  openDatabase,
  Signer,
} from "@storage/server";

export const SERVER_URL = "http://storage.test";

export interface Harness {
  dir: string;
  db: Db;
  /** A fetch that routes requests to the in-process app instead of the network. */
  fetch: typeof fetch;
  adminToken: string;
  /** Moves the server clock forward. */
  advance(ms: number): void;
  addUser(email: string, role: Role, target?: { collectionSlug?: string }): Promise<string>;
  runner(token?: string): RunnerContext;
  cleanup(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "storage-test-"));
  const db = openDatabase("sqlite::memory:");
  await migrateToLatest(db);
  const signer = new Signer("test-signing-secret-".padEnd(40, "x"));
  const blobs = new FilesystemBlobStore({ root: join(dir, "blobs"), publicUrl: SERVER_URL, signer });
  let offset = 0;
  const now = () => new Date(Date.now() + offset);
  const app = createApp({
    db,
    blobs,
    signer,
    now,
    config: { maxFileSize: 1024 * 1024, uploadTtlSeconds: 3600, downloadTtlSeconds: 300 },
    onError: (error) => {
      throw error;
    },
  });
  const fetchShim = ((input: string | URL | Request, init?: RequestInit) =>
    app.request(input instanceof Request ? input : String(input), init)) as typeof fetch;
  const admin = await bootstrapAdmin(db, { org: "acme", email: "admin@acme.com" });
  const org = await db.selectFrom("orgs").select("id").where("slug", "=", "acme").executeTakeFirstOrThrow();

  return {
    dir,
    db,
    fetch: fetchShim,
    adminToken: admin.token,
    advance(ms) {
      offset += ms;
    },
    async addUser(email, role, target = {}) {
      const userId = `usr_${email.replace(/\W/g, "")}`;
      const principal = `user:${userId}`;
      await db
        .insertInto("users")
        .values({ id: userId, email, name: null, created_at: new Date().toISOString() })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
      const collection = target.collectionSlug
        ? await db
            .selectFrom("collections")
            .select("id")
            .where("org_id", "=", org.id)
            .where("slug", "=", target.collectionSlug)
            .executeTakeFirstOrThrow()
        : null;
      await db
        .insertInto("grants")
        .values({
          id: `grt_${email}_${target.collectionSlug ?? "org"}`,
          principal,
          role,
          org_id: org.id,
          collection_id: collection?.id ?? null,
          created_at: new Date().toISOString(),
        })
        .execute();
      return createUserToken(db, { principal, expiresAt: null });
    },
    runner(token = admin.token) {
      return {
        api: new ApiClient({ server: SERVER_URL, token, fetch: fetchShim }),
        home: join(dir, "home"),
        cwd: dir,
        stdout: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
        fetch: fetchShim,
      };
    },
    async cleanup() {
      await db.destroy();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function captureStream(): { stream: Writable; text(): string } {
  const chunks: Buffer[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}
