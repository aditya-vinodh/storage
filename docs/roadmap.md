# Roadmap and status

Where the implementation stands against the milestones in
[design.md §20](design.md#20-milestones), what to build next and in what
order, and the shortcuts in the current code that later work has to pay
down. Update this file as work lands.

## Milestone 1: Core (done)

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
  still creates the first admin, now that sign-in exists (milestone 3).
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
  - Browser sign-in (the device flow) landed with milestone 3. The OS
    keychain hasn't: credentials stay in the `0600` file.

The items listed under Core in design §20 are in place.

## Milestone 2: MCP (done, except OAuth and the viewer)

Planned as three PRs, in this order:

1. **Local MCP server (done).**
   - `@storage/mcp` (`packages/mcp`) turns `PUBLIC_OPERATIONS` into tools.
     The input and output schemas come from `z.toJSONSchema`, and
     `readOnlyHint` and `destructiveHint` from `access` and `destructive`.
     It takes a `run` callback and doesn't depend on `@storage/client`, so
     the hosted server can reuse it with server-side runners.
   - `storage mcp` (`packages/cli/src/mcp.ts`) serves it over stdio and runs
     each call through `runOperation`. It loads the profile on every call,
     so a later `storage login` applies without a restart. It exits once
     stdin ends and every request has been answered, which the SDK's stdio
     transport doesn't do on its own.
   - Inline `get` hands content to the caller instead of writing to stdout
     when a collector is set (`RunnerContext.inline`). Text and PNG, JPEG,
     GIF and WebP images up to 1 MiB are inlined. Other types, larger files
     and invalid UTF-8 fall back to `ref` with a `note`. MCP text blocks are
     wrapped in an `untrusted-content-<nonce>` tag that the content can't
     close.
   - Inline downloads are checked against the size and sha256, in the CLI
     too.
2. **Token scopes (done).**
   - A token has optional `scopes` (`<org>/<glob>` plus a role),
     `default_delivery` and `revoked_at` (migration `0002_token_scopes`).
     `scopeSchema`, `scopeMatches` and `parseScopeArg` live in
     `packages/core/src/scopes.ts`. `NULL` scopes mean full access, which
     keeps bootstrap tokens working.
   - `packages/server/src/auth.ts` intersects scopes with grants:
     `requireScope` runs before any database lookup, so it can't reveal
     whether a collection exists, and `roleOnCollection` returns the lower
     of the grant and the scope. `collections` filters by scope in SQL.
   - `token_create`, `token_list` and `token_revoke` are internal
     operations (`packages/server/src/service/tokens.ts`). Scoped tokens
     can't create or list tokens, and can only revoke themselves.
   - `storage token create|list|revoke` (`packages/cli/src/token.ts`).
   - `get` uses the token's `default_delivery` when `delivery` isn't given
     (`runGet`, via the `download_url` output).
   - The local MCP server hides write tools when every scope is `reader`
     (`listOperations` in `packages/mcp/src/server.ts`).
3. **Hosted MCP over HTTP (done).**
   - Operations declare `surfaces` (`local`, `hosted`; `push` and `pull`
     are local only) and an optional `hostedInput` and `hostedDescription`
     (`packages/core/src/spec.ts`). `operationsFor(surface)` picks the CLI
     commands and each MCP server's tools, and `createMcpServer` takes a
     surface.
   - `POST /mcp` (`packages/server/src/mcp/http.ts`) is stateless Streamable
     HTTP with JSON responses: one MCP server and transport per request,
     authenticated by bearer token. Missing or bad tokens get `401` with
     `WWW-Authenticate: Bearer`. `GET` and `DELETE` return `405`.
     Unexpected errors reach the server log, and callers only see
     `internal`.
   - The route parses the body itself, after `bodyLimit`, and passes it to
     the transport. The transport's own reader stops at 4 MiB, below a
     full-size `put`. It also rejects JSON-RPC batches: a batch of up to
     100 inline `get` calls would make one small request buffer about 100
     times the inline cap. MCP dropped batching in protocol 2025-06-18.
   - Server-side runners (`packages/server/src/mcp/runners.ts`). Hosted
     `put` takes base64 `bytes` up to `STORAGE_MCP_MAX_UPLOAD_BYTES` (10 MiB)
     and goes through the same initiate and commit handlers. The server
     writes the blob itself, via the new `BlobStore.write`, now on S3 too.
     Hosted `get` with `ref` returns a signed URL, `fetch.command` and
     `fetch.curl` (shell-quoted). `inline` reads the blob via `BlobStore.read`
     and applies the same rules as the local server, up to
     `STORAGE_INLINE_MAX_BYTES`. Hosted results never carry `path`.
   - `/v1/ops` and the hosted runners share `runHandler`
     (`packages/server/src/service/run.ts`).

Deferred out of this milestone:

- **OAuth for hosted MCP** landed with sign-in in milestone 3.
- **`upload_url` for hosted `put` over the cap** (§11). Over-cap uploads
  fail with `too_large` and point at the CLI. Offering an upload URL needs
  the agent to send the size and sha256 up front, plus a commit step,
  which changes `put`'s output, so it needs a design first.

- **The viewer** moves to milestone 3. It needs browser sign-in, and a page
  that takes a pasted token would be thrown away and would train people to
  paste tokens into web pages.
- Inline `range` paging and image resizing (`max_px`). Inline content is
  all-or-nothing up to the cap until then. Resizing comes with renditions
  (milestone 5).

## Milestone 3: Sharing (in progress)

Planned as these PRs, in this order:

1. **Grants and the audit log (done).**
   - `grants`, `share` and `unshare` (`packages/server/src/service/grants.ts`)
     work on an org or a collection URI. Principals are users only for now,
     as `user:<email>` or `user:usr_…`; grants always store the user id.
     Sharing with an email nobody has signed in with creates the user row,
     so the grant waits for that person's first sign-in.
   - `share` on an existing grant changes its role. The last org admin
     can't be demoted or removed. Org-level grants need an unscoped token
     to read or change; collection-level ones follow the token's scopes.
   - Migration `0003_audit_and_grants` adds partial unique indexes on
     grants, one per level. That closes the NULL `collection_id` gap, and
     `share` retries once when a concurrent insert hits the index.
   - `audit_events` (`recordAudit` in `packages/server/src/audit.ts`)
     records grant changes, uploads (`upload_commit`, not its retries),
     deletes, issued download URLs (`download_url` and hosted `get`), and
     hosted inline reads. Grant and upload events commit in the same
     transaction as the change.
   - `audit` lists an org's events, newest first, with `action`, `since`
     and a keyset cursor. It needs org admin and an unscoped token.
   - Token create and revoke events are recorded with no org, so `audit`
     doesn't show them yet. A per-user view comes with sign-in.
2. **Share links (done).**
   - `link_create`, `link_list` and `link_revoke`
     (`packages/server/src/service/links.ts`) are public operations, so they
     are MCP tools on the local and hosted servers. The CLI has hand-written
     `storage link create|list|revoke` (`packages/cli/src/link.ts`), and the
     spec's `customCli` flag stops it also generating `link_create` commands.
     They need admin on the collection; a scoped token with an admin scope on
     it can create links.
   - A link covers a collection URI or a prefix URI (`--prefix` in §8.6 is the
     URI's path instead). Migration `0004_links` stores the secret's hash, the
     collection id and the prefix. A collection recreated with the same slug
     isn't covered by an old link.
   - The secret (`storage_link_…`) is a bearer token. `authenticate` turns it
     into a `link:lnk_…` principal with a `reader` scope on its collection and
     `Principal.link` set (`packages/server/src/auth.ts`). `roleOnCollection`
     gives it `reader` on that collection only, `roleOnOrg` nothing, and
     `resolveCollection` checks the prefix before any lookup
     (`requireLinkPath`).
   - Links can call `whoami`, `list`, `stat`, `history` and `get` (and
     `download_url` behind the CLI's `get` and `pull`), nothing else
     (`LINK_OPERATIONS`). The hosted MCP server lists only those tools.
   - Every call made with a link, allowed or not, is recorded as `link.use`
     with the operation and URI (`packages/server/src/links.ts`), on
     `/v1/ops` and hosted MCP. `link.create` and `link.revoke` are recorded
     too.
   - `STORAGE_LINK_MAX_DAYS` (default 30) caps expiry, and `0` disables
     links. Per-org limits (§8.6: "orgs can lower or disable links") need
     org settings, which don't exist yet, so the limit is server-wide. The
     hosted service's tighter limits (§17.2) wait for plans.
   - A link works only while its creator can still read the collection
     (any org- or collection-level grant), checked on every request. Losing
     admin doesn't break the links someone already shared; losing all access
     does. The check matches the creator's own principal only: when
     `google-domain:` and `github-org:` principals arrive, it has to use the
     creator's memberships too, or links made through a group grant break.
3. **Service tokens (done).**
   - Services belong to one org (migration `0005_service_tokens`, table
     `services`) and act as the principal `service:<org>/<name>`. The
     internal `service_create`, `service_list` and `service_delete`
     operations (`packages/server/src/service/services.ts`) back
     `storage service create|list|delete`. Managing services needs org
     admin and an unscoped user token. Deleting a service revokes its
     tokens and removes its grants in one transaction, so a service
     re-created with the same name starts with nothing.
   - `share` and `unshare` take `service:<name>` (resolved in the target's
     org) or `service:<org>/<name>`. A service can only be granted access in
     its own org.
   - `token create --service <org>/<name>` mints a `storage_svc_` token for
     a service. Its scopes are optional (none means the service's full
     grants) and must stay in the service's org; it never expires unless
     `--expires-in-days` is given (at most 3650). User tokens still need
     scopes and expire within 90 days.
   - `allowed_tools` (`--allowed-tool`) limits a token to named public
     operations. `toolAllowed` in `@storage/core` maps the internal
     upload and download operations to `put`/`push` and `get`/`pull`;
     `whoami` and the token operations stay allowed. `/v1/ops` and hosted
     MCP enforce it (`requireAllowedTool`), and both MCP servers hide the
     other tools.
   - Child tokens: any token other than an unscoped top-level user token
     (a scoped token, a service token, a child) mints children from
     `token_create`. A child has the same principal and a `parent_id`, and
     can't exceed its parent: each scope must be covered by a parent scope
     (`scopeCovers`), `allowed_tools` must be a subset, and it can't
     outlive the parent. Such tokens list and revoke only themselves and
     their descendants. Revoking a token revokes its descendants in the
     same transaction, so authentication never walks the chain.
4. **Sign-in**, as three PRs:
   1. **GitHub and Google sign-in and the CLI device flow (done).**
      - The server is an RFC 8628 device authorization server
        (`packages/server/src/signin/routes.ts`): `POST
        /oauth/device_authorization` and `POST /oauth/token` for the public
        client `storage-cli`, and the browser pages `/device`,
        `/device/start` and `/auth/<provider>/callback`. Migration
        `0006_sign_in` adds `identities`, `device_authorizations` and
        `sign_in_states`.
      - Providers (`signin/providers.ts`) use PKCE. GitHub takes the
        verified primary email from `/user/emails`. Google's ID token comes
        straight from its token endpoint, so the claims are checked but not
        the signature; `STORAGE_GOOGLE_ALLOWED_DOMAINS` checks the `hd`
        claim, never the email.
      - The `state` is bound to the browser with an `HttpOnly` cookie, and
        each state is single-use. Device codes are stored hashed, and an
        approved code is exchanged for a token exactly once. Pages send a
        strict CSP, `frame-ancestors 'none'` and `no-referrer`.
      - A first sign-in links to the user with the same email (so grants
        made by `share` to an email apply), then to the provider account.
        `users.email` never changes after creation.
      - `storage login` runs the flow by default
        (`packages/client/src/device.ts`); `--with-token` stays for CI.
        The token is unscoped and lasts 90 days.
      - `user.sign_in` is audited, with no org, like token events.
      - **Superseded by PRs 3 and 4 below**, together with the GitHub
        sign-in in PR 2's authorization flow. A security review found that
        linking by email across providers lets someone who once verified an
        address on GitHub take over the Google user with that email (GitHub
        never re-checks emails). Decision: Google is the only sign-in, and
        GitHub is connected to a signed-in account by numeric id.
   2. **OAuth for hosted MCP (done).**
      - The server is the authorization server for its own `/mcp`
        (`packages/server/src/signin/oauth.ts`), per the MCP authorization
        spec: protected resource metadata (RFC 9728), authorization server
        metadata (RFC 8414), and `POST /oauth/register` for public clients
        (RFC 7591). Without a sign-in provider the metadata answers 404 and
        `/mcp`'s `WWW-Authenticate` has no `resource_metadata`.
      - Redirect URIs must be https, loopback http, or a private-use scheme,
        with no fragment or userinfo (`signin/redirect-uri.ts`), and
        `/oauth/authorize` matches them exactly. An unknown client or
        redirect URI gets an error page, never a redirect.
      - Authorization code with PKCE (S256 only) and the `iss` response
        parameter. The consent page shows the client's self-chosen name as
        unverified and where it redirects. It sets a `SameSite=Strict`
        cookie that `/oauth/authorize/start` requires, so a link straight to
        `start` can't skip consent. Sign-in then goes through the same
        provider callback as the device flow; `sign_in_states` now points at
        a device authorization or an authorization request (migration
        `0007_mcp_oauth`).
      - Codes live 60 seconds and are single-use; replaying one revokes the
        token it produced. Access tokens last an hour. Refresh tokens rotate
        on use and last 30 days, capped at 90 days from the first sign-in;
        replaying a used one revokes the grant. A refresh rewrites the same
        `tokens` row (new secret, new expiry), so `token list` shows one
        `MCP: <name>` row per grant and `token revoke` on it ends the grant.
      - OAuth tokens carry `tokens.client_id` and work only at `/mcp`;
        `/v1/ops` rejects them, so they can't mint other tokens.
      - Audited as `user.sign_in` (`via: "mcp"`) and `token.create`
        (`via: "oauth"`), with the client id.
   3. **Google-only sign-in.** Done. Spec:
      [`specs/google-only-sign-in.md`](specs/google-only-sign-in.md).
      - Only Gmail and Workspace (`hd`) accounts are trusted; other Google
        accounts are refused.
      - A Google sign-in links to an existing user by email only if that
        user has no Google identity yet.
      - Migration `0008` revokes the sign-in tokens (device flow and MCP
        OAuth) of every user with a GitHub identity, with their
        descendants, and deletes GitHub identities.
   4. **Connecting GitHub accounts and `github-user:` principals.** Spec:
      [`specs/github-connect.md`](specs/github-connect.md).
      - `storage connect github`: a single-use ticket, then a Google
        re-check in the browser, then GitHub OAuth.
      - The account is stored by numeric id in `connected_accounts`, and
        `memberOf` gains `github-user:<id>`.
   5. **Group principals**: `google-domain:`, `github-org:` and
      `github-team:` in `Principal.memberOf` (`packages/server/src/auth.ts`),
      with the membership cache from §8.2 and the share link creator check
      extended to memberships. GitHub memberships come from the connected
      account and need the `read:org` scope, so users reconnect. Every grant
      query already matches against that list.

## Later milestones: notes for when they start

- **Lifecycle (milestone 4).** This needs a worker. Its first jobs also
  cover the garbage collection listed under shortcuts below.

## Shortcuts and gaps in the current code

- An account setting to turn off the link tools on MCP (low priority; do it
  at the end). An agent that can create a link can hand an anonymous,
  expiring read secret to anyone, including through a prompt injected into
  it. Some users will want link creation to stay a human action in the CLI.

- From the security review of the hosted MCP server:
  - There's no rate limiting on `/mcp` or the API, so one token (or share
    link) can send as many requests as it likes. Add per-token limits before a public
    hosted deployment.
  - Only inline content is wrapped as untrusted. An object's `description`
    and `meta` are also written by uploaders and reach agents unmarked in
    `list`, `stat` and `get` results.
  - `/mcp` doesn't check the `Origin` header, which the MCP spec asks for
    against DNS rebinding. Every request needs a bearer token and no
    cookies are used, so a rebinding page has nothing to send. Revisit if
    the viewer adds cookie sign-in on the same origin.

- `list` loads every live object under the prefix into memory, then groups
  and paginates in JavaScript. That's fine for small collections. Large
  ones need delimiter grouping and keyset pagination in SQL.
- Still missing for tokens (§8.5): editing a token's scopes or
  `allowed_tools`. Create a new token instead.
- Service token creation and revocation are recorded in the service's
  org's audit log; user token events still have no org, so `audit`
  doesn't show them.
- Sign-in leaves rows behind: used or expired `sign_in_states` and
  `device_authorizations` are never deleted. The lifecycle worker should
  purge them.
- Gaps in MCP OAuth: no OAuth scopes (every grant is the user's full
  access, so scoped MCP access still needs a pasted scoped token), no
  remembered consent, no revocation endpoint (RFC 7009), no CORS on `/mcp`
  itself (browser-based MCP clients can discover and get tokens but not
  call tools), and no limit on `/oauth/register`, whose clients are never
  purged.
- `/device/start` has no consent binding like `/oauth/authorize/start`'s:
  someone who starts a device flow can send a victim the `start` link
  directly, skipping the code check on `/device`. Google's account chooser
  (`prompt=select_account`) is the only prompt left in that path. Bind it to
  the browser that saw `/device` the same way.
- There's no per-IP limit on `/oauth/*` and `/device`. User codes have
  about 2.5 × 10¹⁰ values and live 10 minutes, so guessing one is
  impractical, but rate limiting belongs here too.
- A user whose Google account was deleted and recreated (a new `sub`
  with the same email) is refused at sign-in. An
  instance admin command to move the user to the new account is needed.
- `STORAGE_ADMIN_EMAILS` and "first user becomes instance admin" (§17.1)
  aren't built; `storage-server bootstrap` still creates the first admin.
- Nothing is ever purged. Soft-deleted objects stay forever, unreferenced
  blobs aren't removed, and expired `uploads` rows aren't cleaned up.
- Missing operations: `info`, `update`, `restore`, `move`, `copy`,
  `search`, `lifecycle`, `bind`, `delete-collection`.
- The audit log has no retention, export, or stdout/webhook stream (§15),
  and `audit` covers one org at a time.
- Filesystem-driver downloads are served from the API origin with
  `Content-Disposition: attachment`, `nosniff` and `CSP: sandbox`. S3
  downloads come straight from the bucket with `attachment` but without
  `nosniff` or CSP, which presigned URLs can't set. The separate sandbox
  origin (§16) comes with the viewer.
- Uploads are a single presigned `PUT`, which S3 caps at 5 GiB (the
  default `STORAGE_MAX_FILE_SIZE`). Resumable multipart uploads for files
  over 16 MB (§11) aren't built.

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
- **Write-only CI tokens.** Design §16 says write-only CI tokens can't
  read, but a writer role includes reader, so a `writer` scope can read.
  Decide whether to add a write-only role or change §16.
