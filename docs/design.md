# Storage: agent-first artifact storage

Design doc, draft v0.1

> **Working name.** "Storage" (CLI `storage`, URIs `storage://…`) is a placeholder.
> When capitalized, "Storage" means this project, not storage in general. Every
> name in this doc can change without affecting the design.

## 1. Summary

Storage is an open-source, self-hostable artifact service built for coding agents
first and people second. Agents upload artifacts (screenshots, recordings, test
reports, eval results, logs, anything else) into **collections** with a
directory-like structure. Owners share collections with teammates, Google
Workspace domains, GitHub organizations, or service tokens for review bots.
Collections can be bound to external resources such as GitHub pull requests,
and lifecycle rules clean them up automatically, for example 7 days after the
PR merges.

The CLI and the MCP server expose the same operations with the same arguments
and output. Reads return a **reference** by default: a local path, or a
short-lived signed URL. Content is returned inline only when an agent
explicitly asks because it has no shell.

The same codebase runs self-hosted (one container, Postgres or SQLite, any
S3-compatible bucket) and as a hosted service for easy onboarding.

## 2. Problem

Coding agents increasingly need to hand artifacts to other people and other
agents:

- before/after screenshots and recordings for UI changes,
- test, coverage, and eval reports,
- logs, traces, and generated files that are too big or too noisy for a PR.

The options today are poor:

- **GitHub attachments** (`gh … --attach`, v2.99+): images and video only, small
  size caps, GitHub.com only, no structure, no querying, no retention, no
  sharing model outside the repo.
- **Agent upload tools** (uploads.sh, proofdrop, gitshot, and others): convenient,
  but files are served from public buckets. "Private" usually means unlisted.
  The PixelLeak research (Sept 2026) found 13,000+ internal images from 300+
  organizations exposed because agents routed screenshots through public
  hosting.
- **Hand-rolled S3, Drive, etc.**: every team rebuilds auth, sharing, cleanup,
  and agent tooling, and agents can't discover or browse the result on their
  own.

What's missing is a storage primitive that is **private by default**, has
**simple but real sharing**, is **structured for agents to browse**, and is
**safe for agents to drive on their own**.

## 3. Goals

1. Private by default. No public bucket and no guessable URLs; every read is
   authorized.
2. Sharing in a few words: with a person, a Google Workspace domain, a GitHub
   org or team, a service token, or an expiring link.
3. Agent-first interfaces: a CLI and an MCP server with identical semantics,
   JSON output, stable addresses, idempotent writes, headless auth.
4. Hierarchical paths inside collections (S3-style prefixes) that agents can
   list, glob, and pull like directories.
5. References over bytes: never push content into an agent's context unless
   it explicitly asks.
6. Lifecycle automation, including rules tied to external events (GitHub PR
   merged/closed is the first adapter).
7. Self-hosted first, with a hosted service built from the same code.
8. A general primitive. Coding-agent artifacts drive the design, but nothing in
   the core is specific to them.

## 4. Non-goals

- **Evidence verification or provenance.** Whether an artifact proves anything is
  a separate problem. Storage records who uploaded what and when, nothing more.
- **Agent session or transcript capture.** Users can upload transcript files like
  any other file. Storage doesn't capture sessions.
- **Running tests or evals.** Storage only keeps their outputs.
- **Inline rendering inside GitHub.** PRs carry links to Storage, and the viewer
  handles authentication.
- **An agent working filesystem.** Storage isn't a scratch disk or a mounted
  filesystem. It's where results get shared.
- **Per-prefix permissions** in v1 (see §8.4).

## 5. Users and core scenarios

| Actor | Example |
|---|---|
| Author agent (local) | Claude Code takes screenshots of a settings page, runs `storage push ./artifacts gh-pr:acme/web#482/`, and puts the collection link in the PR body. |
| Author agent (cloud, no shell) | A cloud agent uploads a report through the hosted MCP `put` tool. |
| Reviewer agent (with shell) | A teammate's Codex runs `storage pull storage://acme/pr-482/screenshots/` and inspects the images locally. |
| Reviewer bot (no shell) | Bugbot or CodeRabbit, connected to the hosted MCP server with a read-only service token, calls `get(…, delivery: "inline")` to view a resized screenshot. |
| Human reviewer | Clicks the link in the PR, signs in with Google or GitHub, and sees the viewer. |
| Team admin | Shares the `acme` org with `google-domain:acme.com` and sets PR collections to delete 14 days after merge. |
| Platform team | Self-hosts Storage on their own bucket and identity setup, and points agent skills at it. |

## 6. Design principles

1. **Private by default, explicit to widen.** Every new collection is visible
   only to its owner and anyone who already has access through an org grant.
2. **References over bytes.** The default read returns where the content is, not
   the content.
3. **One command definition, two transports.** CLI commands and MCP tools are
   generated from a single spec, so they can't drift apart.
4. **Text-first metadata.** Agents can understand a collection from one listing
   call, without downloading anything.
5. **Immutable content, mutable names.** Blobs are content-addressed and never
   change. Paths point to versions.
6. **A small core with adapters.** PR binding, notifications, and identity
   providers are adapters around a generic core.
7. **Same code everywhere.** Hosted mode is configuration plus billing, quotas,
   and abuse controls, not a fork.

## 7. Concepts and data model

```
Org ─┬─ Collection ─┬─ Object (path) ── Version ── Blob (sha256)
     │              │                     └─ Renditions
     │              ├─ Binding (e.g. github PR)
     │              └─ Lifecycle rules (collection or prefix level)
     ├─ Grants (org-level)
     └─ Tokens
Principal ← Grant → (Org | Collection)
```

### 7.1 Entities

**Org**: the tenancy boundary. Every user gets a personal org; teams create
shared ones. Self-hosted installs can have many orgs. Fields: `slug`, `name`,
`settings` (default lifecycle, upload policy, allowed identity providers).

**Collection**: a named container in an org. Fields: `slug` (unique within the
org), `title`, `description` (written for agents), `tags`, `binding?`,
`lifecycle_rules[]`, `created_by`, `created_at`, `state` (`active`,
`expiring`, `deleted`).

**Object**: a path inside a collection that points to its current version.
Fields: `path`, `current_version`, `deleted_at?`.

**Version**: an immutable record. Fields: `version` (an integer that increases
per path), `blob_sha256`, `size`, `content_type`, `description?`,
`meta` (string key/value pairs, for example `route=/settings`, `state=after`),
`uploaded_by` (a principal), `uploaded_at`, `scan` (upload-scan results).

**Blob**: content-addressed bytes in the bucket under `blobs/sha256/ab/cd/<hash>`.
Blobs are deduplicated within an org, never across orgs, so that one tenant
can't learn whether another tenant holds a given file.

**Rendition**: a derived artifact generated after upload (§13), stored as a
blob and linked to its source version.

**Binding**: links a collection to an external resource through an adapter, for
example `github:acme/web#482`. Each collection has at most one binding.

**Principal**: anything that can be granted access (§8.2).

**Grant**: `(principal, role, target)`, where the target is an org or a
collection.

**Token**: a credential for a user or service principal, with scopes (§8.5).

**Share link**: an unguessable, expiring, read-only grant to the holder of the
link, scoped to a collection or a prefix.

### 7.2 Storage layout

- **Metadata**: Postgres (recommended) or SQLite (single node, small
  installs). Both are supported through one data-access layer.
- **Bytes**: any S3-compatible store (AWS S3, R2, GCS with HMAC keys, MinIO,
  Tigris). The bucket must not be public. Storage only issues signed URLs.
- **Local dev**: SQLite plus a filesystem blob driver, or MinIO in
  docker-compose.

## 8. Identity, sharing and authorization

### 8.1 Sign-in

- **Providers**: GitHub (OAuth App or GitHub App user auth) and Google (OIDC).
  More OIDC providers come later.
- **CLI**: OAuth 2.0 device authorization flow (`storage login`). Works in
  headless terminals and on remote VMs.
- **MCP (hosted)**: the MCP authorization spec (OAuth 2.1 with PKCE, dynamic
  client registration). Storage acts as the authorization server and delegates
  sign-in to GitHub or Google.
- **CI and cloud agents**: non-interactive scoped tokens (§8.5), passed as
  `STORAGE_TOKEN`.
- **Self-hosted**: admins configure which providers are enabled and can limit
  sign-in to specific Google domains or GitHub orgs.

### 8.2 Principal types

| Principal | Syntax | How it's verified |
|---|---|---|
| User | `user:<id>` or `user:alice@acme.com` | Signed in through a provider |
| Google Workspace domain | `google-domain:acme.com` | The `hd` claim in the Google ID token. Never derived from the email string. |
| GitHub org | `github-org:acme` | Org membership via the GitHub API at sign-in, re-checked when the membership cache expires (default 1 hour) |
| GitHub team | `github-team:acme/frontend` | Same as above, team membership |
| Service | `service:<name>` | Holds a service token |
| Link | `link:<id>` | Holds the link secret |

Rules:

- Consumer domains (`gmail.com`, `outlook.com`, …) can never be used as
  `google-domain` principals. The blocklist is configurable.
- An email address alone never grants domain access, because emails can be
  added to accounts without proving domain ownership.
- If a GitHub membership check fails (API outage), access is denied after the
  cached membership expires. It never fails open.

### 8.3 Roles

| Role | Can |
|---|---|
| `reader` | List, stat, get, search, history, view grants and lifecycle |
| `writer` | Reader, plus put, push, delete objects, set object metadata |
| `admin` | Writer, plus share/unshare, create links, set lifecycle, bind, delete the collection |

Org-level grants apply to every collection in the org. Collection-level grants
add to them. In v1 there are no deny rules: effective access is the highest
role granted.

### 8.4 Scope of grants

Grants apply to whole orgs or collections in v1. Share links can be scoped to a
prefix, because a link is a narrow, temporary exception. Per-prefix grants can
be added later without changing existing semantics.

### 8.5 Tokens

Tokens are opaque, prefixed (`storage_pat_…`, `storage_svc_…`) so secret scanners
can detect them, stored as hashes, and shown only once.

Fields:

- `principal`: a user or a service.
- `scopes`: a list of `(target, role)`, for example
  `[{collection: "acme/pr-*", role: "writer"}]`. Glob patterns on collection
  slugs are allowed. A token's effective access is the intersection of its
  scopes and its principal's grants.
- `default_delivery`: `ref` or `inline` (§9.4). Lets a token for a
  shell-less bot default to inline.
- `expires_at`: required for user tokens (90 days maximum by default), optional
  for service tokens.
- `allowed_tools`: optional allowlist. A token with only reader scopes exposes
  only read tools on MCP.

Example scopes: a CI job token can only write to `acme/pr-*`; a Bugbot token is
read-only on `acme/*` and defaults to inline.

### 8.6 Share links

- `storage link create <uri> --expires 7d [--prefix screenshots/]`
- Read-only, expiring (30 days maximum by default; orgs can lower or disable
  links), revocable, and every use is logged.
- The hosted service applies tighter limits on links (§17.2).

## 9. Addressing and delivery

### 9.1 URIs

```
storage://<org>/<collection>[/<path>][@<version>]
```

- `storage://acme/pr-482/` is a collection root.
- `storage://acme/pr-482/screenshots/` is a prefix.
- `storage://acme/pr-482/screenshots/settings-after.png` is the current version
  of an object.
- `…/settings-after.png@3` is version 3.
- `…/settings-after.png@sha256:9f2c…` pins exact content.

**Binding shorthand**: `gh-pr:acme/web#482/screenshots/` resolves to the
collection bound to that PR, and can create it on first write (§12.2).

Which server a URI refers to comes from the CLI or MCP configuration
(`STORAGE_SERVER`, or the logged-in profile). An optional host form for
multi-server setups is `storage://storage.acme.internal/acme/pr-482/…`.

**Web URLs** for humans, same structure:
`https://<server>/acme/pr-482/screenshots/settings-after.png`. These open the
viewer, which authenticates first.

### 9.2 Paths

- Paths are UTF-8 and `/`-separated. Leading `/` is optional; trailing `/`
  means a prefix.
- Paths are normalized: no empty segments, no `.` or `..`, no control
  characters. Maximum 1024 bytes and 32 segments.
- Directories are implicit, as in S3: a prefix exists while any object lives
  under it, and there are no empty directories.
- Paths are case-sensitive. `pull` refuses to write two paths that differ only
  in case onto a case-insensitive filesystem unless `--rename-conflicts` is
  passed.

### 9.3 Listing

`list(uri, delimiter="/", recursive=false, glob?, limit, cursor)` returns:

- `prefixes`: the immediate child "directories", with object count and total
  size.
- `objects`: files at this level, with path, size, content type, version,
  description, metadata, updated time, and available renditions.
- `next_cursor` for pagination.

`recursive=true` drops the delimiter. `glob` supports `*`, `**`, `?` and `{a,b}`,
for example `**/*.png`.

### 9.4 Delivery modes

Every operation that returns content takes `delivery`:

| | `ref` (default) | `inline` (last resort) |
|---|---|---|
| CLI | Downloads to a local path and returns the path | Writes content to stdout |
| Local MCP (`storage mcp`, stdio) | Downloads to a local path and returns the path | Content in the tool result |
| Hosted MCP (HTTP) | Short-lived signed URL plus a ready-to-run fetch command | Content in the tool result |

**`ref` details**

- Local download root: `--to <dir>`, otherwise `$STORAGE_HOME/cache/<org>/<collection>/<path>`.
  Downloads are verified against the blob hash and skipped if already present.
- Hosted signed URLs expire after 5 minutes by default. They are issued only
  after an authorization check, and every issue is logged. The response also
  includes `fetch.command` (for example `storage get storage://… --to .`) and
  `fetch.curl` for agents that have a shell but no CLI installed.
- The result has the same shape in all three cases: either `path` or `url`
  is set.

**`inline` details**

- Text is returned as text content, paged with `range` (`lines=1-200` or
  `bytes=0-65535`). Default page: 200 lines or 64 KB.
- Images are returned as MCP image content, resized server-side to
  `max_px` (default 1568 on the long edge), in WebP or PNG.
- Video, PDF and other binaries are never inlined raw. Inline returns
  their renditions instead (key frames, poster, extracted text).
- Hard caps per call: 1 MB total, 8 images (configurable). Anything over the
  cap falls back to `ref` with a `truncated` or `fallback` note. Content is
  never cut silently.
- Tool descriptions say plainly: *"Use `delivery: "inline"` only if you cannot
  run shell commands."*
- A token's `default_delivery` (§8.5) overrides the default for that token, so
  a shell-less bot doesn't have to remember to ask.

**Untrusted content.** Everything returned inline is wrapped with a marker that
says the content is data uploaded by a user, not instructions. Agents reading
artifacts are a prompt-injection target.

## 10. Operations (unified command spec)

Each operation is defined once: name, arguments, output schema, required role,
and read/write class. The CLI (`storage <op>`) and MCP tools (`<op>`) are
generated from that definition. MCP read tools carry `readOnlyHint: true`;
write tools are annotated as such (and `destructiveHint` where relevant), and
are left out of the tool list entirely for read-only tokens.

### 10.1 Read operations

| Op | Args | Returns |
|---|---|---|
| `collections` | `org?`, `tag?`, `bound_to?`, `query?`, `limit`, `cursor` | Collections with summary fields |
| `info` | `uri` (collection) | Collection index: title, description, tags, binding, lifecycle, top-level prefixes, object count and total size, recent uploads. The "understand it in one call" operation. |
| `list` | `uri`, `delimiter`, `recursive`, `glob`, `limit`, `cursor` | §9.3 |
| `stat` | `uri` | Full version record, renditions, scan results |
| `get` | `uri` (object or prefix), `delivery`, `to?`, `range?`, `max_px?`, `rendition?` | Object or prefix contents per §9.4. Prefix `get` with `ref` is a recursive pull. |
| `pull` | Alias for `get` on a prefix with `delivery: ref` | |
| `search` | `query?`, `path_glob?`, `meta?` (key=value), `content_type?`, `org?`, `collection?`, `updated_since?`, `full_text?` | Matching objects across collections the caller can read |
| `history` | `uri` (object) | Versions with uploader, time, size, hash |
| `renditions` | `uri` | Available renditions and their status |
| `grants` | `uri` (org or collection) | Effective grants, including inherited ones |
| `lifecycle` | `uri` | Rules and the next scheduled action ("deletes `videos/` in 6 days") |
| `whoami` | | Principal, org memberships, token scopes, default delivery |

### 10.2 Write operations

| Op | Args | Notes |
|---|---|---|
| `create` | `uri` (collection), `title?`, `description?`, `tags?`, `bind?` | Idempotent on slug |
| `update` | `uri` (collection), fields | |
| `put` | `uri` (object), `file` or `bytes` or `source_url`, `content_type?`, `description?`, `meta?`, `if_match?`, `idempotency_key?` | Creates a new version. `if_match` takes a version or hash for optimistic concurrency. MCP accepts `bytes` (base64) only as a fallback for agents with no shell; it prefers `upload_url` (§11). |
| `push` | local `dir`, target prefix `uri`, `glob?`, `delete_missing?` | CLI and local MCP only. Uploads only changed files, by hash. |
| `delete` | `uri` (object or prefix), `recursive?` | Soft delete; recoverable during the grace period |
| `restore` | `uri`, `version?` | |
| `move` / `copy` | `from`, `to` | Within an org; metadata-only (blobs are shared) |
| `share` / `unshare` | `uri`, `principal`, `role` | |
| `link` | `create` / `list` / `revoke` | §8.6 |
| `set-lifecycle` | `uri`, rules | §12 |
| `bind` / `unbind` | `uri`, `target` (e.g. `github:acme/web#482`) | |
| `delete-collection` | `uri` | Soft delete |

### 10.3 Auth and admin (CLI only, some exposed to the UI)

`login`, `logout`, `token create|list|revoke`, `org create|members|settings`,
`config`, `mcp` (starts the local stdio MCP server).

### 10.4 Output, errors and exit codes

The output of `--json` in the CLI and the structured content of an MCP tool
result are the same JSON. Example `get` with `ref` on the hosted server:

```json
{
  "uri": "storage://acme/pr-482/screenshots/settings-after.png",
  "version": 3,
  "sha256": "9f2c…",
  "size": 182344,
  "content_type": "image/png",
  "description": "Settings page after the change, desktop width",
  "meta": { "route": "/settings", "state": "after" },
  "delivery": "ref",
  "url": "https://storage.example.com/d/…",
  "url_expires_at": "2026-10-10T18:05:00Z",
  "fetch": {
    "command": "storage get storage://acme/pr-482/screenshots/settings-after.png --to .",
    "curl": "curl -fsSL -o settings-after.png 'https://storage.example.com/d/…'"
  },
  "web_url": "https://storage.example.com/acme/pr-482/screenshots/settings-after.png"
}
```

The same call from the CLI or local MCP sets `"path": "/home/me/.storage/cache/acme/pr-482/screenshots/settings-after.png"`
instead of `url` and `fetch`.

Errors use one envelope: `{"error": {"code": "not_found", "message": "…", "hint": "…"}}`.
Codes: `unauthenticated`, `forbidden`, `not_found`, `conflict`,
`precondition_failed`, `too_large`, `quota_exceeded`, `blocked_by_policy`,
`rate_limited`, `invalid_argument`, `unavailable`.

CLI exit codes: `0` success, `1` other error, `2` usage or invalid argument,
`3` auth or permission, `4` network or server unavailable, `5` not found,
`6` conflict or precondition failed, `7` blocked by policy or quota.

## 11. Upload pipeline

1. **Initiate**: the client sends path, size, sha256, content type and an
   optional idempotency key. The server checks role, quota, size limits, and
   content type policy.
   - If a blob with that hash already exists in the org, it skips the upload
     and only creates a version.
   - Otherwise it returns presigned upload URLs (multipart for files over
     16 MB).
2. **Transfer**: the client uploads directly to the bucket. Bytes never pass
   through the API server, and never through the model's context with the CLI
   or local MCP. Multipart uploads are resumable.
3. **Commit**: the server verifies size and hash, creates the version, and
   updates the object pointer (honoring `if_match`).
4. **Post-process** (asynchronous worker):
   - content-type sniffing; a mismatch with the declared type is flagged;
   - EXIF and other image metadata stripped (on by default);
   - secret scanning on text-like content (tokens, keys, private keys). The
     org policy decides: `warn` (default, flagged on the version and in
     `stat`), `block` (version quarantined, readable only by admins), or
     `off`;
   - renditions generated (§13);
   - full-text indexing for text content (§14).

**Hosted MCP uploads for agents with no shell**: `put` with `bytes` up to
10 MB (configurable). Above that, the tool returns an `upload_url` the agent
can `PUT` to if it has any HTTP capability. Above the cap with no HTTP
capability, the upload isn't possible, and the error says so.

**URL ingestion** (`source_url`): the server fetches the URL with SSRF
protection (no private ranges, no redirects into private ranges, size and
time limits). Off by default for self-hosted installs.

**Limits** (self-hosted defaults, all configurable): 5 GB per file, no
storage cap. Content types are allowed by policy. HTML and SVG are stored but
always served as attachments or from the sandbox origin, never rendered on
the main origin (§16).

## 12. Lifecycle

### 12.1 Rules

Rules attach to a collection, a prefix within it, or an org (as a default for
new collections):

```yaml
lifecycle:
  - prefix: ""                 # whole collection
    delete_after: 90d          # since collection creation
  - prefix: "videos/"
    delete_after_event: { event: binding.closed, after: 7d }
  - prefix: "reports/"
    delete_after_event: { event: binding.closed, after: 30d }
  - prefix: ""
    keep_versions: 5           # prune older versions of each object
```

- Event-based rules use the binding's events: `binding.closed`,
  `binding.merged`, `binding.reopened` (which cancels a pending deletion).
- When several rules match, the most specific prefix wins. Among equal
  prefixes, the earliest deletion wins.
- Deletion is soft. Objects stay restorable by admins for a grace period
  (default 7 days), then the blob is removed when nothing else references it.
- `lifecycle` (read op) always shows the next scheduled action, so agents and
  people can see when something will disappear.
- A scheduler in the worker evaluates rules. All actions are audited.

### 12.2 GitHub PR adapter (first adapter)

**Binding target**: `github:<owner>/<repo>#<number>`.

**Auto-create**: a write to `gh-pr:acme/web#482/…` creates the collection if it
doesn't exist, using the org's configured template (default slug
`<repo>-pr-<number>`, lifecycle from org defaults). With `gh-pr:acme/web@<branch>/…`,
the adapter looks up the open PR for that branch; if none exists yet, it binds
to the branch and re-binds when a PR opens.

**Events** come from either:

- a **GitHub App webhook** (`pull_request` closed, merged, reopened), the
  recommended option and the one used by the hosted service;
- **polling** for self-hosted installs that can't receive inbound webhooks: a
  periodic check of bound PRs using a GitHub token. The interval is
  configurable (default 15 minutes).

**Optional PR comment**: when enabled per org, the GitHub App posts or updates a
single comment on the PR with the collection link and a short listing. This is
off by default; agents can also put links in the PR body themselves.

**Access**: the adapter doesn't grant access based on repo permissions in v1.
Grants still come from §8. Repo-derived access is a possible later adapter
feature.

### 12.3 Adapter interface

```
Adapter {
  kind: "github"
  parseTarget(string) -> Target
  resolveShorthand(string) -> Target          // gh-pr:… forms
  describe(Target) -> { title, url, state }
  subscribe(Target) / unsubscribe(Target)     // webhook or poll registration
  events: closed | merged | reopened | …
}
```

Future adapters include GitLab merge requests, Linear issues, and generic
webhooks.

## 13. Renditions

Generated asynchronously after upload, cached as blobs, and listed in `stat` and
`list`:

| Source | Renditions |
|---|---|
| Image | `preview` (1568 px long edge, WebP), `thumb` (320 px) |
| Video | `poster`, `keyframes` (N evenly spaced frames, default 6, plus scene-change frames up to 12), `meta` (duration, resolution) |
| PDF | `text` (extracted), `pages` (first N pages as images) |
| Text, JSON, logs | `head` (first 200 lines), `stats` (line count, size) |
| Archives (zip, tar.gz) | `listing` (file names and sizes, never extracted on the server beyond listing; zip-bomb limits apply) |

Renditions are what make `inline` useful for shell-less agents. A reviewer bot
can "watch" a recording by reading its key frames. Report-specific
renditions (JUnit summaries, coverage summaries, eval result tables) can be
added later as pluggable handlers.

## 14. Search

- **Metadata search** across all collections the caller can read: path glob,
  `meta` key=value, content type, tags, uploader, time range, binding.
- **Full-text search** over text-like objects and text renditions: Postgres
  full-text search, or SQLite FTS5. Results include the path, a snippet, and
  a line number, so agents can follow up with `get --range`.
- Results are always filtered by authorization before being returned. Counts
  never reveal objects the caller can't read.

## 15. Audit log

Every authorization-relevant event is recorded:

- sign-ins and token use (first and last use);
- grant and link changes;
- signed URL issued;
- inline reads;
- uploads, deletes, restores;
- lifecycle actions;
- policy blocks.

Org admins can query the log in the UI and through `storage audit` (an admin
operation). Export to a SIEM is a hosted and enterprise feature. Self-hosted
installs can also stream it to stdout or a webhook.

## 16. Security

| Threat | Mitigation |
|---|---|
| Public exposure (PixelLeak class) | No public bucket. All reads are authorized, then served through short-lived signed URLs. Public links are explicit, expiring, and audited. |
| Leaked token | Scoped, expiring, prefixed tokens that secret scanners can detect. Write-only CI tokens can't read. Revocation takes effect immediately. |
| Leaked share link | Expiry, revocation, scoping to a prefix, logging of every use. Orgs can disable links. |
| Domain spoofing | Domain access comes only from Google's `hd` claim. Consumer domains are blocked. GitHub access uses verified org membership. |
| Stored XSS through uploads | User content is served from a separate sandbox origin (`usercontent.<server>`) with `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`. HTML and SVG are never rendered on the main origin. |
| Prompt injection through artifact content | Inline content is marked as untrusted data. Documentation tells integrators to treat it as data. |
| Path traversal on `pull` | Paths are normalized server-side and re-validated client-side. Writes stay confined to the target directory. Symlinks are never created. |
| Zip bombs, decompression attacks | Renditions are size- and time-limited and sandboxed in the worker. Archives are listed, never extracted. |
| SSRF through `source_url` | Off by default for self-hosted installs. Private address ranges are blocked, redirects re-checked. |
| Secrets inside artifacts | Upload scanning with a warn or block policy, plus quarantine. |
| Cross-tenant inference | Blob deduplication only within an org. |
| Data at rest | Relies on bucket encryption (SSE). Self-hosted installs can use their own keys (SSE-KMS). |

## 17. Deployment

### 17.1 Self-hosted (priority)

- **One container image**, `storage-server`, runs any combination of these roles
  (enabled by flags):
  - `api`: REST API used by the CLI, the UI and adapters;
  - `mcp`: hosted MCP server (Streamable HTTP) at `/mcp`;
  - `worker`: post-processing, renditions, lifecycle scheduler, adapter
    polling;
  - `web`: viewer and UI.
- **Dependencies**: Postgres (or SQLite for a single node) and an S3-compatible
  bucket. Jobs are queued in the database, so there's no extra broker.
- **Configuration** via environment variables or a config file: the server's
  public URL, the sandbox-content origin, database URL, bucket credentials,
  OAuth app credentials for GitHub and/or Google, allowed domains and orgs,
  upload policy, lifecycle defaults.
- **Packaging**: `docker-compose.yml` (server, Postgres, MinIO) for trying it
  out, and a Helm chart later.
- **Bootstrap**: the first user to sign in becomes instance admin, or the admin
  is set explicitly with `STORAGE_ADMIN_EMAILS`.

### 17.2 Hosted

Same image, with hosted-only configuration:

- sign-up with GitHub or Google, a personal org created automatically;
- billing, plans and quotas (storage, file size, members);
- abuse controls: public links disabled on free plans, or capped at 7 days
  and small sizes; rate limits; malware scanning on uploads;
- operational extras: SIEM export, SSO/SAML (enterprise).

Self-hosted features are never artificially restricted. The hosted service
charges for operating it, plus enterprise identity and compliance features.

### 17.3 CLI and local MCP

- One `storage` binary for macOS, Linux and Windows. `storage mcp` starts the
  local stdio MCP server using the same code paths as the CLI, so `ref`
  delivery downloads to disk.
- Configuration: `~/.config/storage/config.toml` with profiles (server URL,
  default org); credentials go in the OS keychain where available, otherwise a
  file with `0600` permissions.
- `storage install` writes MCP configs and agent skill files for Claude Code,
  Codex, Cursor and others, and shows exactly what it changed.
- The agent skill tells agents: prefer the CLI if available, use `ref`
  delivery, put collection links in PR bodies, and use `inline` only without a
  shell.

## 18. UI

**Early (needed from the start)**: a viewer. A person who clicks a link from a
PR signs in and sees a file (image, video, PDF, text with syntax
highlighting, rendered markdown) or a prefix (grid or list view with
thumbnails, metadata, download).

**Last**: the full UI, covering:

- browsing collections and searching;
- managing grants, links, lifecycle, bindings and tokens;
- org settings and members;
- the audit log;
- hosted billing.

## 19. Technology (recommended)

- **TypeScript** throughout: the official MCP SDK is mature, one operation spec
  generates both the CLI and the MCP tools, and the server and web UI share
  types.
- **Server**: Node with Hono or Fastify. Kysely or Drizzle for Postgres and
  SQLite.
- **CLI**: distributed via npm, plus standalone binaries compiled with Bun.
- **Renditions**: `sharp` for images, `ffmpeg` for video, `pdfium` or `pdf.js`
  for PDFs, all in the worker.
- **Web**: Next.js or Vite + React with shadcn/ui.

Go is the main alternative (simpler single binaries for the CLI and server).
The deciding factor is MCP SDK maturity and sharing the operation spec, which
favors TypeScript.

## 20. Milestones

Ordered by dependency, not by time.

1. **Core**:
   - data model, blob store drivers (S3 and filesystem), Postgres and SQLite;
   - API for collections, objects, versions, upload pipeline (without
     post-processing);
   - CLI with `login` (device flow), `create`, `put`, `push`, `list`, `stat`,
     `get`, `pull`, `history`, `delete`;
   - docker-compose for self-hosting.
2. **MCP**: operation spec, then generated tools for local (stdio) and hosted
   (HTTP, OAuth) servers; delivery modes and caps; read-only annotations; the
   viewer.
3. **Sharing**: Google and GitHub principals, grants, scoped service tokens,
   share links, audit log.
4. **GitHub PR adapter and lifecycle**: binding, `gh-pr:` shorthand,
   webhooks and polling, lifecycle rules and scheduler, soft delete with a grace
   period, optional PR comment.
5. **Renditions, scanning and search**: image and video renditions, EXIF
   stripping, secret scanning, metadata and full-text search.
6. **Hosted onboarding**: sign-up, personal orgs, quotas, abuse controls,
   billing, `storage install` for the major agents.
7. **Full UI**.

## 21. Open questions

1. **Name.** "Storage" is a placeholder, and the URI scheme, CLI and package names
   follow from the final choice.
2. **License.** Apache 2.0 (maximizes adoption) or AGPL for the server (protects
   the hosted business). One option is AGPL for the server and Apache for the
   CLI and SDKs.
3. **Collection slugs.** Should slugs be globally meaningful (`pr-482`) or
   generated (`c_8f3k…`) with titles? Readable slugs are friendlier for agents
   but can collide across repos in one org. The PR adapter's
   `<repo>-pr-<number>` template sidesteps this for PRs.
4. **Repo-derived access.** Should the GitHub adapter optionally grant
   `reader` to anyone who can read the bound repo? It's useful for open source
   and large orgs, but needs GitHub permission checks on every read (cached).
5. **Inline caps.** What are the right defaults per MCP client? Context budgets
   differ a lot between clients.
6. **Encryption.** Is bucket-level SSE enough, or do some self-hosters need
   application-level encryption with their own keys?
7. **Delete semantics for bound collections.** If a PR closes and then reopens
   after the grace period, the artifacts are gone. Is that acceptable, or
   should "reopen" restore from a longer cold-retention tier?
