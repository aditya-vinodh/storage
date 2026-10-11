#!/usr/bin/env node
import { Command } from "commander";
import { bootstrapAdmin } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { migrateToLatest, openDatabase } from "./db/index.js";
import { createBlobStore, githubAppFor, startServer } from "./server.js";
import { Signer } from "./signing.js";
import { startWorker } from "./worker/maintenance.js";

const program = new Command("storage-server").description("Storage API server").showHelpAfterError();

program
  .command("serve")
  .description("Run the API server")
  .action(async () => {
    const config = loadConfig();
    const server = await startServer(config);
    const blobs = config.blobs.driver === "fs" ? config.blobs.dir : `s3://${config.blobs.bucket}`;
    console.log(
      `storage-server listening on ${server.url} (public URL ${config.publicUrl}, data in ${config.dataDir}, blobs in ${blobs})`,
    );
    const shutdown = async () => {
      await server.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

program
  .command("worker")
  .description("Run the maintenance worker only")
  .action(async () => {
    const config = loadConfig();
    const db = openDatabase(config.databaseUrl);
    await migrateToLatest(db);
    const blobs = await createBlobStore(config, new Signer(config.signingSecret));
    const worker = startWorker(
      { db, blobs, config, githubApp: githubAppFor(config) },
      config.worker.intervalSeconds * 1000,
    );
    console.log(`storage-server worker running every ${config.worker.intervalSeconds}s`);
    const shutdown = async () => {
      await worker.stop();
      await db.destroy();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

program
  .command("migrate")
  .description("Apply database migrations and exit")
  .action(async () => {
    const db = openDatabase(loadConfig().databaseUrl);
    await migrateToLatest(db);
    await db.destroy();
    console.log("Database is up to date.");
  });

program
  .command("bootstrap")
  .description("Create an org and an admin user, and print a personal access token")
  .requiredOption("--org <slug>", "org slug, for example acme")
  .requiredOption("--email <email>", "admin user's email")
  .option("--org-name <name>", "display name for the org")
  .option("--json", "print JSON")
  .action(async (options: { org: string; email: string; orgName?: string; json?: boolean }) => {
    const db = openDatabase(loadConfig().databaseUrl);
    await migrateToLatest(db);
    try {
      const result = await bootstrapAdmin(db, {
        org: options.org,
        email: options.email,
        ...(options.orgName === undefined ? {} : { orgName: options.orgName }),
      });
      if (options.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`Org ${result.org} is ready; ${result.principal} is an admin.`);
        console.log(`Token (shown once, expires ${result.tokenExpiresAt}):`);
        console.log(result.token);
      }
    } finally {
      await db.destroy();
    }
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
