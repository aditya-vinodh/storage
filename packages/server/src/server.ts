import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { FilesystemBlobStore } from "./blobs/fs.js";
import { S3BlobStore } from "./blobs/s3.js";
import type { BlobStore } from "./blobs/store.js";
import type { ServerConfig } from "./config.js";
import { type Db, migrateToLatest, openDatabase } from "./db/index.js";
import { createApp } from "./http/app.js";
import { githubConnector } from "./signin/github.js";
import { providersFromConfig } from "./signin/providers.js";
import { Signer } from "./signing.js";
import { type RunningWorker, startWorker } from "./worker/maintenance.js";

export interface RunningServer {
  url: string;
  db: Db;
  close(): Promise<void>;
}

/** Builds the configured blob store, creating the S3 bucket first if configured to. */
export async function createBlobStore(config: ServerConfig, signer: Signer): Promise<BlobStore> {
  if (config.blobs.driver === "fs") {
    return new FilesystemBlobStore({ root: config.blobs.dir, publicUrl: config.publicUrl, signer });
  }
  const { driver: _driver, createBucket, ...options } = config.blobs;
  const store = new S3BlobStore(options);
  if (createBucket) {
    await store.ensureBucket();
  }
  return store;
}

/** Opens the database, applies migrations, and starts listening. */
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const db = openDatabase(config.databaseUrl);
  await migrateToLatest(db);
  const signer = new Signer(config.signingSecret);
  const blobs = await createBlobStore(config, signer);
  const app = createApp({
    db,
    blobs,
    config,
    signer,
    signIn: {
      publicUrl: config.publicUrl,
      providers: providersFromConfig(config.signIn),
      github: config.signIn.github ? githubConnector(config.signIn.github) : undefined,
    },
  });

  const worker: RunningWorker | null = config.worker.enabled
    ? startWorker({ db, blobs, config }, config.worker.intervalSeconds * 1000)
    : null;

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
    db,
    async close() {
      await worker?.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await db.destroy();
    },
  };
}
