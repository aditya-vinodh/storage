import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@storage/core": src("core"),
      "@storage/client": src("client"),
      "@storage/mcp": src("mcp"),
      "@storage/server": src("server"),
      "@storage/cli": src("cli"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    environment: "node",
    // On Postgres and S3 every end-to-end test creates a schema, runs the migrations and talks to the bucket.
    // In CI that averages 3-4 seconds a test with all workers sharing one database, so the 5-second default
    // fails whichever test is slowest. The timeout catches hangs, not slowness, so give backend runs room.
    ...(process.env.STORAGE_TEST_DATABASE_URL || process.env.STORAGE_TEST_S3_ENDPOINT
      ? { testTimeout: 30_000, hookTimeout: 30_000 }
      : {}),
  },
});
