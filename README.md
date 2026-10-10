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

The Core milestone of the [design doc](docs/design.md) is in place, except
browser sign-in. What works today:

- SQLite or Postgres metadata store. Blobs go to any S3-compatible bucket, or
  to the local filesystem with transfer URLs signed and served by the API.
- Collections, versioned objects, content deduplication within an org,
  `if_match` and idempotency keys, soft delete.
- Personal access tokens and org/collection grants (reader, writer, admin),
  managed with `grants`, `share` and `unshare`.
- An audit log of grant changes, uploads, deletes and downloads, read with
  `storage audit storage://<org>/`.
- The `storage` CLI: `whoami`, `collections`, `create`, `list`, `stat`,
  `history`, `put`, `get`, `push`, `pull`, `delete`, plus `login` with a
  pasted token, `logout` and `config`, with named profiles.
- Scoped tokens: `storage token create --scope 'acme/pr-*:writer'`, plus
  `token list` and `token revoke`.
- A `storage-server` Docker image and a `docker-compose.yml` with Postgres
  and RustFS.
- `storage mcp`, a local MCP server over stdio with one tool per CLI
  operation.

Not built yet: browser sign-in for `login` (device flow),
the hosted MCP server, Google/GitHub sign-in and the `share`/`link` commands,
lifecycle, renditions, search, and the viewer. The build order, known gaps,
and open decisions are in [`docs/roadmap.md`](docs/roadmap.md).

## Layout

| Package | Contents |
|---|---|
| `packages/core` | The operation spec (one definition per operation, used to generate CLI commands and MCP tools), URIs, paths, errors. No native dependencies. |
| `packages/server` | Data model and migrations (Kysely), blob stores, token auth, operation handlers, and the HTTP API (Hono). Binary: `storage-server`. |
| `packages/client` | Client-side operation runners shared by the CLI and the local MCP server. `put` and `get` run here and move bytes directly to and from the blob store. |
| `packages/mcp` | MCP tools generated from the operation spec, independent of where operations run. |
| `packages/cli` | The `storage` CLI, generated from the operation spec, and `storage mcp`. |
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
echo storage_pat_... | node packages/cli/dist/main.js login --with-token   # token from bootstrap
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
alias storage="node $PWD/packages/cli/dist/main.js"
echo storage_pat_... | storage login --with-token   # token from bootstrap

storage create storage://acme/pr-482/ --title "PR 482"
storage put ./after.png storage://acme/pr-482/screenshots/after.png --meta state=after
storage list storage://acme/pr-482/
storage get storage://acme/pr-482/screenshots/after.png   # prints the local path

# Directories: push uploads only files whose content changed; pull mirrors a prefix.
storage push ./artifacts storage://acme/pr-482/ --delete-missing --dry-run
storage push ./artifacts storage://acme/pr-482/ --delete-missing
storage pull storage://acme/pr-482/screenshots/ --to ./review
```

Every command takes `--json` and prints the same JSON the MCP tools
return. Errors use the envelope `{"error": {"code", "message", "hint"}}` and
the exit codes in design doc §10.4.

### Use it from an agent (MCP)

`storage mcp` runs a local MCP server over stdio, with one tool per CLI
command and the same credentials (a saved profile, or `STORAGE_SERVER` and
`STORAGE_TOKEN`). For Claude Code:

```sh
claude mcp add storage -- node $PWD/packages/cli/dist/main.js mcp
```

Tools return the same JSON as `--json`. `get` downloads to a local path by
default. With `delivery: "inline"` it returns text and images (PNG, JPEG, GIF,
WebP) in the tool result, up to 1 MiB, marked as user-uploaded data. Other
types, and anything larger, are downloaded to a path instead, with a `note`
saying why.

### Hosted MCP

The API also serves MCP over Streamable HTTP at `<STORAGE_PUBLIC_URL>/mcp`,
for agents that can't run the CLI. It is stateless and authenticated with the
same bearer tokens. For Claude Code:

```sh
claude mcp add --transport http storage http://localhost:8787/mcp --header "Authorization: Bearer $STORAGE_TOKEN"
```

`push` and `pull` aren't offered. `put` takes base64 `bytes`, up to
`STORAGE_MCP_MAX_UPLOAD_BYTES`. `get` returns a signed URL with `fetch`
commands, or the content with `delivery: "inline"`.

### Share links

A collection admin can hand out read-only access to a collection, or a
prefix of it, without adding a user:

```sh
storage link create storage://acme/pr-482/screenshots/ --expires 7d --name reviewer
storage link list storage://acme/pr-482/
storage link revoke lnk_...
```

The secret (`storage_link_…`) is used like a token: set `STORAGE_TOKEN` to
it and run `list`, `stat`, `history`, `get` or `pull` under that URI, or pass
it as the bearer token to the hosted MCP server. Nothing else works with it.
Every use is recorded in the audit log. Links aren't offered as MCP tools, so
an agent can't mint one.

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
| `STORAGE_DOWNLOAD_TTL_SECONDS` | 300. How long signed download URLs last. |
| `STORAGE_MCP_MAX_UPLOAD_BYTES` | 10 MiB. Largest file the hosted MCP `put` accepts. |
| `STORAGE_INLINE_MAX_BYTES` | 1 MiB. Largest object the hosted MCP `get` returns inline. |
| `STORAGE_LINK_MAX_DAYS` | 30. Longest a share link can last. `0` disables share links. |

### CLI configuration

`storage login --with-token` reads a token from stdin, checks it with the
server, and saves it to a profile. `--server` picks the server (default
`STORAGE_SERVER`, then the profile's server, then `http://localhost:8787`),
and the global `--profile <name>` picks the profile. `storage logout` removes
the saved token, and `storage config` shows the active profile, server and
token source without printing the token.

Profiles live in `~/.config/storage/` (`$XDG_CONFIG_HOME/storage`,
`%APPDATA%\storage` on Windows, or `STORAGE_CONFIG_DIR`):

- `config.toml`: `default_profile` and `[profiles.<name>] server = "…"`.
  It holds no secrets.
- `credentials.toml`, mode `0600`: `[profiles.<name>] token = "…"`.

Environment variables override the profile:

| Variable | Meaning |
|---|---|
| `STORAGE_SERVER` | Server URL. A saved token is only sent to its own profile's server, so pointing this elsewhere leaves you signed out. |
| `STORAGE_TOKEN` | Token. Takes precedence over the saved one. |
| `STORAGE_PROFILE` | Profile name, when `--profile` isn't given. |
| `STORAGE_CONFIG_DIR` | Directory holding `config.toml` and `credentials.toml`. |
| `STORAGE_HOME` | Download cache root, default `~/.storage`. |
