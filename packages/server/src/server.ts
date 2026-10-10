import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { FilesystemBlobStore } from "./blobs/fs.js";
import type { ServerConfig } from "./config.js";
import { type Db, migrateToLatest, openDatabase } from "./db/index.js";
import { createApp } from "./http/app.js";
import { Signer } from "./signing.js";

export interface RunningServer {
  url: string;
  db: Db;
  close(): Promise<void>;
}

/** Opens the database, applies migrations, and starts listening. */
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const db = openDatabase(config.databaseUrl);
  await migrateToLatest(db);
  const signer = new Signer(config.signingSecret);
  const blobs = new FilesystemBlobStore({ root: config.blobDir, publicUrl: config.publicUrl, signer });
  const app = createApp({ db, blobs, config, signer });

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
    db,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await db.destroy();
    },
  };
}
