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
  tests make no network calls. The `cli()` helper in `tests/cli.test.ts`
  sets `STORAGE_CONFIG_DIR` to the test's temp directory.

## Working with subagents (Claude Code)

The lead agent plans, splits work, reviews diffs and commits. Subagents in
`.claude/agents/` do the bounded work on cheaper models:

| Agent | Model | Use for |
|---|---|---|
| `implementer` | Sonnet | One specified change, then lint, typecheck and tests |
| `test-writer` | Sonnet | Tests from a Given/When/Then behavior list; no product code |
| `verifier` | Haiku | Running checks (SQLite, Postgres, flake loops) and summarizing failures |
| `Explore` (built in) | Haiku | Finding code and answering "where/how is X done" |

- Delegate only work the lead can specify in a brief. Design, security
  decisions and anything touching auth or the upload pipeline's guarantees
  stay with the lead.
- A brief names the goal, the files to read and change, the exact behavior
  (inputs, outputs, error codes), what's out of scope, and how to verify.
  Vague briefs cost more in rework than they save.
- For a feature: the lead writes the behavior list, `test-writer` writes the
  tests, `implementer` makes them pass, and `verifier` runs the full suite
  (on Postgres if SQL changed). The lead reviews the whole diff before
  committing.
- Run independent briefs in parallel only when they touch different files.
- Subagents never commit or push.

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
  `STORAGE_SERVER=http://localhost:8787` and `STORAGE_TOKEN`, or pipe the
  token to `login --with-token`. Set `STORAGE_DATA_DIR`, `STORAGE_HOME` and
  `STORAGE_CONFIG_DIR` to temp directories to keep runs isolated; otherwise
  `login` writes to the real `~/.config/storage`.
