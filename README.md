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

- SQLite or Postgres metadata store. Blobs go to any S3-compatible bucket, or
  to the local filesystem with transfer URLs signed and served by the API.
- Collections, versioned objects, content deduplication within an org,
  `if_match` and idempotency keys, soft delete.
- Personal access tokens and org/collection grants (reader, writer, admin).
- The `storage` CLI: `whoami`, `collections`, `create`, `list`, `stat`,
  `history`, `put`, `get`, `push`, `pull`, `delete`.
- A `storage-server` Docker image and a `docker-compose.yml` with Postgres
  and RustFS.

Not built yet: `login` (device flow),
the MCP server, Google/GitHub sign-in and the `share`/`link` commands,
lifecycle, renditions, search, and the viewer. The build order, known gaps,
and open decisions are in [`docs/roadmap.md`](docs/roadmap.md).

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

# Run the end-to-end tests against Postgres instead of in-memory SQLite.
# Each test gets its own schema, which is dropped afterwards.
STORAGE_TEST_DATABASE_URL=postgres://storage:storage@localhost:5432/storage_test pnpm test

# Run them against an S3-compatible store instead of the filesystem driver.
# This also enables the S3 driver tests. The bucket (default storage-test)
# is created if missing.
STORAGE_TEST_S3_ENDPOINT=http://localhost:9000 \
STORAGE_TEST_S3_ACCESS_KEY_ID=storage STORAGE_TEST_S3_SECRET_ACCESS_KEY=storage-secret \
  pnpm test
```

### Run it with docker-compose

`docker-compose.yml` runs the server with Postgres and
[RustFS](https://github.com/rustfs/rustfs), an S3-compatible store. Its
credentials are development defaults.

```sh
docker compose up --detach --build --wait
docker compose exec server node dist/main.js bootstrap --org acme --email you@example.com

pnpm install && pnpm build
export STORAGE_SERVER=http://localhost:8787
export STORAGE_TOKEN=storage_pat_...   # from bootstrap
node packages/cli/dist/main.js whoami
```

The image alone is `docker build -t storage-server .`. It listens on 8787,
keeps local state in the `/data` volume, and is configured with the
variables listed under [Server configuration](#server-configuration).

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

# Directories: push uploads only files whose content changed; pull mirrors a prefix.
storage push ./artifacts storage://acme/pr-482/ --delete-missing --dry-run
storage push ./artifacts storage://acme/pr-482/ --delete-missing
storage pull storage://acme/pr-482/screenshots/ --to ./review
```

Every command takes `--json` and prints the same JSON the MCP tools will
return. Errors use the envelope `{"error": {"code", "message", "hint"}}` and
the exit codes in design doc §10.4.

### Server configuration

| Variable | Default |
|---|---|
| `STORAGE_DATA_DIR` | `./.storage-data` |
| `STORAGE_DATABASE_URL` | `sqlite:<data dir>/storage.db`. Also accepts `postgres://user:password@host:5432/db`. |
| `STORAGE_BLOB_DRIVER` | `fs`, or `s3` for any S3-compatible bucket |
| `STORAGE_BLOB_DIR` | `<data dir>/blobs` (`fs` driver) |
| `STORAGE_S3_BUCKET` | Required for `s3`. The bucket must not be public. |
| `STORAGE_S3_REGION` | `AWS_REGION`, else `us-east-1` |
| `STORAGE_S3_ENDPOINT` | Unset for AWS S3. Set for RustFS, MinIO, R2 and others. |
| `STORAGE_S3_PUBLIC_ENDPOINT` | `STORAGE_S3_ENDPOINT`. The address clients use in presigned URLs, when it differs from the server's. |
| `STORAGE_S3_FORCE_PATH_STYLE` | `true` when an endpoint is set, else `false` |
| `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY` | Unset to use the AWS SDK's default credential chain |
| `STORAGE_S3_CREATE_BUCKET` | `false`. Set to `true` to create the bucket on startup. |
| `STORAGE_PUBLIC_URL` | `http://localhost:<port>` |
| `STORAGE_HOST` / `STORAGE_PORT` | `127.0.0.1` / `8787` |
| `STORAGE_SIGNING_SECRET` | Generated into `<data dir>/signing-secret` on first run |
| `STORAGE_MAX_FILE_SIZE` | 5 GiB |

The CLI reads `STORAGE_SERVER`, `STORAGE_TOKEN`, and `STORAGE_HOME`
(download cache root, default `~/.storage`).
