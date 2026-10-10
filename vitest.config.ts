import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@storage/core": src("core"),
      "@storage/client": src("client"),
      "@storage/server": src("server"),
      "@storage/cli": src("cli"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    environment: "node",
  },
});
