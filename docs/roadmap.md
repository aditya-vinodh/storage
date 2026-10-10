# Roadmap and status

Where the implementation stands against the milestones in
[design.md §20](design.md#20-milestones), what to build next and in what
order, and the shortcuts in the current code that later work has to pay
down. Update this file as work lands.

## Milestone 1: Core (in progress)

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

### Next, in order

1. **Postgres.** `openDatabase` in `packages/server/src/db/index.ts` only
   accepts `sqlite:` URLs. Add `pg` with Kysely's `PostgresDialect`.
   - `pg` returns `bigint` columns (`size`) as strings. Install a type parser
     or convert at every read. `toVersion` already wraps sizes in `Number()`,
     but check the other reads too.
   - Version numbers are assigned as `max(version) + 1` inside a transaction,
     guarded by `unique(object_id, version)`. SQLite serializes writers, but
     Postgres won't: lock the object row (`SELECT … FOR UPDATE`) or retry on
     a unique violation.
   - Run the test suite against both databases. Parametrize
     `tests/harness.ts` on an environment variable such as
     `STORAGE_TEST_DATABASE_URL`.
2. **S3-compatible blob driver.** Implement `BlobStore`
   (`packages/server/src/blobs/store.ts`) on top of the AWS SDK.
   - Presigned `PUT` should pin `content-length` and
     `x-amz-checksum-sha256`, so the bucket itself rejects wrong bytes. The
     filesystem driver checks this in `write()`.
   - Presigned `GET` should set `response-content-disposition: attachment`.
   - `stat` maps to `HeadObject`.
   - Choose the driver with config: `STORAGE_BLOB_DRIVER=fs|s3`, plus
     bucket, endpoint, region, credentials and path-style settings.
   - Test against MinIO.
   - Multipart uploads for files over 16 MB (design §11) can be a follow-up.
3. **Dockerfile and `docker-compose.yml`.** Server, Postgres and MinIO.
   Depends on 1 and 2.
4. **`push` and `pull`.** Add them as public operations in
   `packages/core/src/operations.ts`, with runners in
   `packages/client/src/runners.ts`.
   - `push` walks a directory, hashes files, skips unchanged ones (compare
     against `list --recursive`), and supports `delete_missing`.
   - `pull` (a `get` on a prefix) lists recursively and downloads each
     object. It must refuse paths that differ only in case on
     case-insensitive filesystems unless `--rename-conflicts` is passed
     (§9.2).
   - `get` currently accepts object URIs only.
5. **CLI config and `login`.** Profiles in `~/.config/storage/config.toml`
   and credentials in the OS keychain (§17.3). The device-flow `login`
   needs an identity provider (milestone 3). Until then, decide whether
   `storage login --token` should just store a pasted token.

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
- Downloads are served from the API origin with
  `Content-Disposition: attachment`, `nosniff` and `CSP: sandbox`. The
  separate sandbox origin (§16) comes with the viewer.
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
