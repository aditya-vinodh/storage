# Roadmap and status

Where the implementation stands against the milestones in
[design.md §20](design.md#20-milestones), what to build next and in what
order, and the shortcuts in the current code that later work has to pay
down. Update this file as work lands.

## Milestone 1: Core (done, except device-flow login)

### Done

- pnpm workspace: `core` (operation spec, URIs, paths, errors), `server`,
  `client`, `cli`. See the README for the layout.
- SQLite metadata store with Kysely migrations. The schema is written to be
  portable to Postgres (ISO-string timestamps, JSON stored as text, booleans
  as 0/1).
- Filesystem blob store with HMAC-signed transfer URLs served by the API.
- Upload pipeline (initiate, transfer, commit) without post-processing:
  per-org deduplication, `if_match`, idempotency keys, retry-safe commit.
- Personal access tokens (`storage_pat_…`, hashed at rest) and org- and
  collection-level grants (reader, writer, admin).
- Operations: `whoami`, `collections`, `create`, `list`, `stat`, `history`,
  `put`, `get`, `delete` (soft). The CLI is generated from the spec.
- `storage-server bootstrap` creates an org admin and prints a token. It
  stands in for sign-in until the device flow exists.
- Postgres (`STORAGE_DATABASE_URL=postgres://…`) alongside SQLite.
  - `pg` parses `int8` as a number through a per-pool type parser, so sizes
    are numbers on both databases.
  - `upload_commit` takes the object's row lock (a no-op `UPDATE`, portable
    to SQLite) before assigning `max(version) + 1`, and re-checks the upload
    and idempotency key after taking it. A test commits eight uploads to one
    path concurrently, each twice.
  - Kysely's migration tables are pinned to `current_schema()`, so several
    schemas in one database don't confuse the migrator.
  - `STORAGE_TEST_DATABASE_URL` runs the suite on Postgres with one schema
    per test.
- S3-compatible blob driver (`STORAGE_BLOB_DRIVER=s3`,
  `packages/server/src/blobs/s3.ts`).
  - Presigned `PUT` signs `content-length`, `content-type` and
    `x-amz-checksum-sha256`, so the bucket rejects any other bytes.
  - Presigned `GET` sets `response-content-disposition: attachment`,
    the version's content type, and `cache-control: private, no-store`.
  - `STORAGE_S3_PUBLIC_ENDPOINT` signs URLs for the address clients use
    when the server reaches the store at another one (docker-compose).
  - `STORAGE_S3_CREATE_BUCKET=true` creates the bucket on startup.
  - Tested against RustFS and MinIO. MinIO no longer publishes binaries or
    Docker images, so CI and docker-compose use RustFS
    (`rustfs/rustfs:1.0.1`). `STORAGE_TEST_S3_ENDPOINT` runs the suite on
    S3 and enables the driver tests.
- CI runs the suite twice: on SQLite with the filesystem driver, and on
  Postgres with RustFS.
- `Dockerfile` (the `storage-server` image) and `docker-compose.yml` with
  Postgres and RustFS. The compose file creates the bucket on startup and
  signs URLs for `localhost:9000`. A CI job builds the image, starts the
  stack, and uploads and downloads a file with the CLI.
- `push` and `pull` (`packages/client/src/sync.ts`). `list` objects now
  carry `sha256`, which is how `push` finds unchanged files.
  - `push` skips symlinks, checks every path before uploading anything,
    and supports `glob`, `meta`, `delete_missing` (soft delete, limited to
    the glob) and `dry_run`. Re-running a failed push resumes it.
  - `pull` pins each download to the version it listed, skips files
    already present, and plans every local path first. It refuses paths
    that collide on a case-insensitive filesystem (found by probing the
    target) and file/directory clashes, unless `rename_conflicts` adds a
    `~2` suffix. Writes never follow symlinks out of the target.
  - Transfers run four at a time. After a failure, nothing new starts and
    the error is reported once in-flight transfers settle.
  - `get` stays object-only and points at `pull` for prefixes, instead of
    acting as a recursive pull as design §10.1 says. A prefix result has a
    different shape, and one op with a fixed output schema suits MCP better.
- CLI profiles and `login` (`packages/client/src/config.ts`,
  `packages/cli/src/auth.ts`).
  - `storage login --with-token` reads a token from stdin (or `--token`),
    checks it with `whoami`, and saves the profile. `logout` removes the
    token. `config` shows the active profile and where each setting comes
    from, and never prints the token.
  - Profiles live in `config.toml`; tokens live in `credentials.toml` with
    mode `0600`. `STORAGE_CONFIG_DIR`, `$XDG_CONFIG_HOME/storage`, or
    `%APPDATA%\storage` picks the directory.
  - `STORAGE_SERVER` and `STORAGE_TOKEN` override the profile. A saved
    token is sent only to its own profile's server.
  - Browser sign-in (the device flow in design §10 and §17.3) needs an
    identity provider, so it waits for milestone 3. The OS keychain is the
    same: credentials stay in the `0600` file until then.

The items listed under Core in design §20 are in place, apart from that
device flow. Next is milestone 2.

## Later milestones: notes for when they start

- **MCP (milestone 2).** Generate the tools from `PUBLIC_OPERATIONS`:
  - Input schema comes from `z.toJSONSchema(spec.input, { io: "input" })`,
    the same call the CLI uses in `packages/cli/src/program.ts`.
  - `readOnlyHint` comes from `access === "read"` and `destructiveHint`
    from `destructive`.
  - The local stdio server can call `runOperation` from `packages/client`
    as it is.
  - The hosted server needs server-side runners: `get` returns a signed URL
    plus fetch commands, or inline content with caps and renditions, and
    `put` accepts `bytes` or returns an `upload_url` (§9.4, §11).
- **Sharing (milestone 3).** Domain, GitHub org and team principals belong
  in `Principal.memberOf` (`packages/server/src/auth.ts`). Every grant
  query already matches against that list.
- **Lifecycle (milestone 4).** This needs a worker. Its first jobs also
  cover the garbage collection listed under shortcuts below.

## Shortcuts and gaps in the current code

- `list` loads every live object under the prefix into memory, then groups
  and paginates in JavaScript. That's fine for small collections. Large
  ones need delimiter grouping and keyset pagination in SQL.
- Token scopes, `default_delivery` and `allowed_tools` (§8.5) aren't
  implemented: a token has its principal's full access. There are no
  service tokens and no `token create|list|revoke` commands, only
  `bootstrap`.
- Nothing is ever purged. Soft-deleted objects stay forever, unreferenced
  blobs aren't removed, and expired `uploads` rows aren't cleaned up.
- Missing operations: `info`, `update`, `restore`, `move`, `copy`,
  `search`, `grants`, `lifecycle`, `share`, `link`, `bind`,
  `delete-collection`.
- `get --delivery inline` streams to stdout without checking the hash.
  `ref` downloads are checked.
- There's no audit log (§15).
- Filesystem-driver downloads are served from the API origin with
  `Content-Disposition: attachment`, `nosniff` and `CSP: sandbox`. S3
  downloads come straight from the bucket with `attachment` but without
  `nosniff` or CSP, which presigned URLs can't set. The separate sandbox
  origin (§16) comes with the viewer.
- Uploads are a single presigned `PUT`, which S3 caps at 5 GiB (the
  default `STORAGE_MAX_FILE_SIZE`). Resumable multipart uploads for files
  over 16 MB (§11) aren't built.
- Org-level grants have `collection_id = NULL`, which a unique constraint
  doesn't cover, because NULLs compare as distinct. `bootstrapAdmin` checks
  for an existing grant before inserting, and a future `share` must do the
  same, or add a partial unique index.

## Open decisions

- **Collection slugs** (design §21, question 3). The code uses readable
  slugs (`SLUG_PATTERN` in `packages/core/src/uri.ts`). Settle this before
  real installs hold data.
- **License** (question 2). Needs an answer before publishing packages.
- **Name** (question 1). `@storage/*`, the `storage` binary and the
  `storage://` scheme are placeholders.
- **`put` to a missing collection** fails with a hint to run `create`
  instead of creating the collection. Revisit if agents find that
  friction.
- **Metadata on new versions.** A new version doesn't inherit
  `description` or `meta` from the previous one. Decide whether it should.
