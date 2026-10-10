# Storage (working name)

Open-source, agent-first artifact storage. Coding agents upload screenshots,
recordings, test and eval reports, logs, and anything else into structured,
private-by-default collections. Owners share them with teammates, Google
Workspace domains, GitHub orgs, or review bots, and lifecycle rules (for
example "delete 7 days after the PR merges") clean them up automatically.

- CLI and MCP server with the same operations and output.
- Reads return a reference (local path or short-lived signed URL) by default.
  Content is returned inline only when an agent has no shell.
- Self-hosted first: one container, Postgres or SQLite, any S3-compatible
  bucket. A hosted service is built from the same code.

## Status

Early development, working through the Core milestone of the
[design doc](docs/design.md). What works today:

- SQLite metadata store and a filesystem blob store with signed transfer URLs.
- Collections, versioned objects, content deduplication within an org,
  `if_match` and idempotency keys, soft delete.
- Personal access tokens and org/collection grants (reader, writer, admin).
- The `storage` CLI: `whoami`, `collections`, `create`, `list`, `stat`,
  `history`, `put`, `get`, `delete`.

Not built yet: `login` (device flow), `push`/`pull`, Postgres, the S3 driver,
the MCP server, Google/GitHub sign-in and the `share`/`link` commands,
lifecycle, renditions, search, and the viewer.

## Layout

| Package | Contents |
|---|---|
| `packages/core` | The operation spec (one definition per operation, used to generate CLI commands and, later, MCP tools), URIs, paths, errors. No native dependencies. |
| `packages/server` | Data model and migrations (Kysely), blob stores, token auth, operation handlers, and the HTTP API (Hono). Binary: `storage-server`. |
| `packages/client` | Client-side operation runners shared by the CLI and the future local MCP server. `put` and `get` run here and move bytes directly to and from the blob store. |
| `packages/cli` | The `storage` CLI, generated from the operation spec. |
| `tests` | End-to-end tests that drive the client and CLI against an in-process server. |

## Development

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm build        # tsc -b
pnpm test         # vitest
pnpm lint         # biome
pnpm typecheck    # packages and tests
```

### Run it locally

```sh
pnpm build

# Create an org and an admin, and print a token (data goes to ./.storage-data).
node packages/server/dist/main.js bootstrap --org acme --email you@example.com

# Start the API on http://localhost:8787.
node packages/server/dist/main.js serve

# In another shell:
export STORAGE_SERVER=http://localhost:8787
export STORAGE_TOKEN=storage_pat_...   # from bootstrap
alias storage="node $PWD/packages/cli/dist/main.js"

storage create storage://acme/pr-482/ --title "PR 482"
storage put ./after.png storage://acme/pr-482/screenshots/after.png --meta state=after
storage list storage://acme/pr-482/
storage get storage://acme/pr-482/screenshots/after.png   # prints the local path
```

Every command takes `--json` and prints the same JSON the MCP tools will
return. Errors use the envelope `{"error": {"code", "message", "hint"}}` and
the exit codes in design doc §10.4.

### Server configuration

| Variable | Default |
|---|---|
| `STORAGE_DATA_DIR` | `./.storage-data` |
| `STORAGE_DATABASE_URL` | `sqlite:<data dir>/storage.db` |
| `STORAGE_BLOB_DIR` | `<data dir>/blobs` |
| `STORAGE_PUBLIC_URL` | `http://localhost:<port>` |
| `STORAGE_HOST` / `STORAGE_PORT` | `127.0.0.1` / `8787` |
| `STORAGE_SIGNING_SECRET` | Generated into `<data dir>/signing-secret` on first run |
| `STORAGE_MAX_FILE_SIZE` | 5 GiB |

The CLI reads `STORAGE_SERVER`, `STORAGE_TOKEN`, and `STORAGE_HOME`
(download cache root, default `~/.storage`).
