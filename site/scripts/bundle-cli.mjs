// Bundles the CLI into one file the install script downloads, so installing needs only Node.
// Workspace packages are bundled from source, so this runs without `pnpm build`.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../..", import.meta.url));
const workspace = ["core", "client", "mcp", "cli"];

await build({
  entryPoints: [`${root}packages/cli/src/main.ts`],
  outfile: fileURLToPath(new URL("../dist/cli/storage.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  legalComments: "none",
  alias: Object.fromEntries(workspace.map((name) => [`@storage/${name}`, `${root}packages/${name}/src/index.ts`])),
  // Bundled CommonJS dependencies call require(), which ES modules don't define.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "warning",
});
