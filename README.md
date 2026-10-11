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
  `history`, `put`, `get`, `push`, `pull`, `delete`, plus `login`
  (browser sign-in with Google, or a pasted token), `logout` and
  `config`, with named profiles.
- Scoped tokens: `storage token create --scope 'acme/pr-*:writer'`, plus
  `token list` and `token revoke`.
- `storage connect github` links a GitHub account to your user, and
  `storage disconnect github` removes it.
- A `storage-server` Docker image and a `docker-compose.yml` with Postgres
  and RustFS.
- `storage mcp`, a local MCP server over stdio with one tool per CLI
  operation.

- Group principals: `google-domain:`, `github-org:` and `github-team:`.
- Lifecycle rules: `storage set-lifecycle storage://acme/pr-482/ --rules
  '[{"prefix":"videos/","delete_after":"7d"},{"prefix":"","keep_versions":5}]'`,
  and `storage lifecycle` to see them and the next scheduled deletion. The
  maintenance worker applies them. `set-lifecycle storage://acme/` sets the
  org's defaults for new collections.
- Bindings: `storage bind storage://acme/pr-482/ github:acme/web#482` links a
  collection to a pull request, and
  `{"prefix":"","delete_after_event":{"event":"binding.closed","after":"7d"}}`
  deletes its objects a week after the PR closes. The state comes from a
  GitHub webhook or polling (see [GitHub pull requests](#github-pull-requests)).

Not built yet: the `gh-pr:` shorthand, renditions, search, and the viewer. The build order, known gaps,
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

# `serve` also runs the maintenance worker (purges old deletions and unused blobs).
# To run it separately, set STORAGE_WORKER=false on `serve` and start:
node packages/server/dist/main.js worker

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

With a sign-in provider configured ([Sign-in](#sign-in)), MCP clients can
sign in with OAuth instead of a pasted token: leave out the header and the
client discovers the server's OAuth endpoints, registers itself and opens a
browser. The consent page shows the name the app gave itself and where it
will send you; check both. The client gets a one-hour access token that only
works at `/mcp`, refreshed for up to 90 days. It shows up in
`storage token list` as `MCP: <app name>`, and `storage token revoke` ends it.

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
Every use is recorded in the audit log. The same operations are MCP tools
(`link_create`, `link_list`, `link_revoke`), on the local and hosted servers.

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
| `STORAGE_DELETE_GRACE_DAYS` | 7. How long a deleted object can be restored with `storage restore`. After that the maintenance worker purges it. `0` disables restore. |
| `STORAGE_WORKER` | `true`. `serve` runs the maintenance worker in-process. Set to `false` when running `storage-server worker` separately. |
| `STORAGE_WORKER_INTERVAL_SECONDS` | 300. Time between maintenance passes. |
| `STORAGE_GITHUB_CLIENT_ID`, `STORAGE_GITHUB_CLIENT_SECRET` | Unset. A GitHub OAuth app for connecting GitHub accounts (see [Sharing with groups](#sharing-with-groups)). They don't enable sign-in, and need Google sign-in. |
| `STORAGE_GITHUB_WEBHOOK_SECRET` | Unset. Enables `POST /v1/github/webhook` for pull request events (see [GitHub pull requests](#github-pull-requests)). At least 16 characters. |
| `STORAGE_GITHUB_POLL_TOKEN` | Unset. A GitHub token that can read the bound repos' pull requests. Enables polling. |
| `STORAGE_GITHUB_POLL_INTERVAL_SECONDS` | 900. How often each bound pull request is polled. |
| `STORAGE_GITHUB_MEMBERSHIP_TTL_SECONDS` | 3600. How long a user's GitHub org and team memberships are cached before they are checked again. |
| `STORAGE_CONSUMER_DOMAINS` | Unset. Comma-separated email domains to refuse as `google-domain:` principals, on top of the built-in list (`gmail.com`, `outlook.com`, `yahoo.com`, …). |
| `STORAGE_GOOGLE_CLIENT_ID`, `STORAGE_GOOGLE_CLIENT_SECRET` | Unset. A Google OAuth client for sign-in (see [Sign-in](#sign-in)). |
| `STORAGE_GOOGLE_ALLOWED_DOMAINS` | Unset. Comma-separated Google Workspace domains. When set, only Workspace accounts whose ID token carries one of them in `hd` can sign in, so Gmail accounts are refused. |

### Sign-in

`storage login` signs in through the browser with the OAuth device flow: it
prints a URL and a code, you open the URL on any device, check the code, and
sign in with Google. The CLI then receives a 90-day token. It works
in headless terminals and over SSH.

Google is the only sign-in provider. Enable it by registering an OAuth client
(Cloud console → Credentials → OAuth client ID, type "Web application") with
this callback URL (`STORAGE_PUBLIC_URL` must be the address browsers reach the
server at): `<STORAGE_PUBLIC_URL>/auth/google/callback`. The account's email
must be verified.

An account can sign in only if Google manages its address: a Gmail address
(`@gmail.com` or `@googlemail.com`), or a Google Workspace account. Other
Google accounts, such as a personal account registered with a non-Gmail
address, are refused. `STORAGE_GOOGLE_ALLOWED_DOMAINS` further limits sign-in
to those Workspace domains.

GitHub isn't a sign-in provider. The GitHub variables are for connecting
GitHub accounts after sign-in (see below).

The first sign-in links to an existing user with the same email, so grants
made with `storage share … user:alice@acme.com` before Alice signed in apply
once she does. Later sign-ins match the Google account, even if its email
changes. If a Google account is deleted and re-registered with the same
email, sign-in is refused until an admin helps. Signing in grants nothing by itself: a new user sees no orgs until
someone shares one with them. Without a provider, `storage login` fails and
points at `--with-token`.

### Sharing with groups

Besides users (`user:alice@acme.com`) and services (`service:bugbot`),
`storage share` takes these principals:

| Principal | Who it covers |
|---|---|
| `google-domain:acme.com` | Users whose Google sign-in carries `hd: acme.com`, the Workspace's primary domain. Never matched from an email address. Consumer domains are refused. |
| `github-user:octocat` | The user who connected that GitHub account. |
| `github-org:acme` | Users whose connected GitHub account is an active member of the org. |
| `github-team:acme/frontend` | Users whose connected GitHub account is on the team. Sharing with a team needs your own connected account to see it. |

GitHub principals are stored by numeric id, so renames don't break grants.
`storage unshare` also takes the id (`github-org:9919`).

- Domain membership is read from the user's last Google sign-in, and lasts
  as long as the tokens from it. When someone leaves, revoke their tokens.
- `storage connect github` links a GitHub account to your user after a
  Google re-check. Register a GitHub OAuth app with the callback
  `<STORAGE_PUBLIC_URL>/connect/github/callback`, and add
  `<STORAGE_PUBLIC_URL>/connect/google/callback` to the Google client.
- Org and team membership needs the connected account's token with the
  `read:org` scope, which the server stores encrypted with a key derived
  from the signing secret. Accounts connected before org support (or whose
  token was revoked) show `org_access: false` in `whoami`; run
  `storage connect github` again to reconnect. Changing the signing secret
  also requires reconnecting.
- Memberships are cached for `STORAGE_GITHUB_MEMBERSHIP_TTL_SECONDS`. When
  the cache expires and GitHub can't be reached, access through GitHub
  groups is denied until a check succeeds; it never fails open.
- Orgs that restrict OAuth app access must approve the app, or their
  members' memberships stay invisible and grants to the org don't apply.
- `storage whoami` lists the groups you act as.

### GitHub pull requests

`storage bind <collection> github:<owner>/<repo>#<number>` binds a
collection to a pull request. Lifecycle rules with `delete_after_event`
count from when it closes (`binding.closed`, merged or not) or merges
(`binding.merged`); a reopen cancels a pending deletion. `storage lifecycle`
shows the binding's state. The server learns the state in one of two ways:

- **Webhook** (recommended): set `STORAGE_GITHUB_WEBHOOK_SECRET`, then add a
  webhook to the repo or org (or a GitHub App) with payload URL
  `<STORAGE_PUBLIC_URL>/v1/github/webhook`, content type
  `application/json`, the same secret, and the "Pull requests" event.
- **Polling**, for servers GitHub can't reach: set
  `STORAGE_GITHUB_POLL_TOKEN` to a token that can read the repos' pull
  requests. The worker checks each open or closed binding every
  `STORAGE_GITHUB_POLL_INTERVAL_SECONDS`. Anyone who can bind a collection
  can see whether a pull request the token can read is open, closed or
  merged, so use a token limited to the repos you bind.

### CLI configuration

`storage login` signs in through the browser ([Sign-in](#sign-in)), and
`storage login --with-token` reads a token from stdin instead (for CI and
scripts). Either way the CLI checks the token with the server and saves it to a
profile. `--server` picks the server (default
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
