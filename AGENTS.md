# Agent notes

Agent-first artifact storage. Read `docs/design.md` for the design and
`docs/roadmap.md` for current status and what to build next. Keep the
roadmap up to date when you land or defer work.

## Commands

Node 22+ and pnpm.

```sh
pnpm install
pnpm build       # tsc -b, emits packages/*/dist
pnpm typecheck   # packages and test files
pnpm lint        # biome; `pnpm format` to fix
pnpm test        # vitest; tests import package sources directly, so no build is needed
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck and test; the test
suite again on Postgres and RustFS; and a docker-compose smoke test.

## How the code fits together

- An operation is defined once in `packages/core/src/operations.ts`. Public
  operations become CLI commands automatically, and will become MCP tools.
  Internal ones are the client-to-server protocol.
- To add an operation:
  1. Define it in `operations.ts` and add it to `OPERATIONS`.
  2. If it runs on the server, add a handler in `packages/server/src/service/`
     and register it in `HANDLERS` (`service/index.ts`).
  3. If it touches local files, add a runner in
     `packages/client/src/runners.ts` instead.
  4. Optionally add a human formatter in `packages/cli/src/format.ts`.
     `--json` output needs nothing extra.
- Server responses are validated against the operation's output schema.
  Handlers must return exactly that shape.
- Database changes go in a new migration in
  `packages/server/src/db/migrations.ts`. Never edit an applied migration.
  Keep the SQL portable to Postgres.
- End-to-end tests live in `tests/` and use `tests/harness.ts`. The harness
  runs an in-process server with in-memory SQLite and a fetch shim, so
  tests make no network calls.

## Cursor Cloud specific instructions

- Docker isn't preinstalled, but it works once installed:
  `sudo apt-get install -y docker.io docker-compose-v2`, then run
  `sudo dockerd` in a tmux session. The VM's legacy iptables `FORWARD` chain
  drops traffic between containers, so also run
  `sudo iptables-legacy -P FORWARD ACCEPT`, or the server can't reach
  Postgres and RustFS inside docker-compose. Use `sudo docker compose …`.
- Without Docker, Postgres comes from `sudo apt-get install -y postgresql`
  (`sudo pg_ctlcluster 16 main start`), and RustFS ships a single binary on
  its GitHub releases page:
  `RUSTFS_ACCESS_KEY=storage RUSTFS_SECRET_KEY=storage-secret rustfs server --address :9100 --console-address :9101 <dir>`.
  Point `STORAGE_TEST_DATABASE_URL` and `STORAGE_TEST_S3_ENDPOINT` (see the
  README) at them to run the suite on those backends. MinIO no longer
  publishes binaries or images.
- For a manual run: `pnpm build`, then
  `node packages/server/dist/main.js bootstrap --org acme --email you@example.com`
  for a token, then `node packages/server/dist/main.js serve` in a tmux
  session. Point the CLI (`node packages/cli/dist/main.js`) at it with
  `STORAGE_SERVER=http://localhost:8787` and `STORAGE_TOKEN`. Set
  `STORAGE_DATA_DIR` and `STORAGE_HOME` to temp directories to keep runs
  isolated.
