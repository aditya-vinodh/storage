# Spec: the maintenance worker, purge and restore

Status: done. Milestone 4, PR 1 in the [roadmap](../roadmap.md).

## Why

Nothing is ever purged today. Soft-deleted objects stay forever,
unreferenced blobs are never removed, and expired `uploads` and sign-in rows
pile up. Design §12.1 says deletion is soft, restorable for a grace period
(default 7 days), and that the blob is then removed when nothing else
references it. Lifecycle rules, bindings and the GitHub adapter (the rest of
milestone 4) all end in that same soft delete, so the grace period, the
purge and `restore` come first.

Out of scope, for later PRs: lifecycle rules and `lifecycle`/`set-lifecycle`
(PR 2), bindings and `gh-pr:` (PR 3), `keep_versions`, listing deleted
objects, `delete-collection`, and blobs written to the store whose upload
row is already gone.

## Config

- `STORAGE_DELETE_GRACE_DAYS` (default `7`, `0` allowed): how long a
  soft-deleted object stays restorable. `ServerConfig.deleteGraceDays`, and
  in `ServiceConfig` so `restore` can use it.
- `STORAGE_WORKER` (`true` by default): `serve` runs the worker in-process.
  Set it to `false` when the worker runs separately with
  `storage-server worker`.
- `STORAGE_WORKER_INTERVAL_SECONDS` (default `300`): time between passes.

Several workers may run at once (several `serve` replicas). Every job is
safe to run concurrently with itself and with the API.

## `restore` (public operation)

`restore <uri> [--recursive]`, `access: write`, `role: writer`,
`destructive: false`, all surfaces.

Design §12.1 says "restorable by admins". `restore` needs `writer`, the
same role as `delete`, because a writer could already re-upload what they
deleted. Design §12.1 is updated to match.

Input: `{ uri, recursive: boolean = false }`.
Output: `{ restored: [{ uri, path, version }] }`, sorted by path, where
`version` is the object's current version after the restore.

An object is **restorable** when `deleted_at` is set and
`deleted_at > now - grace`. Objects past the grace period are treated as
gone, even before the worker purges them, so behavior never depends on when
the worker last ran.

- **Object URI, no version**: undeletes a restorable object (`deleted_at`
  back to null; `current_version` unchanged).
  - Live object: `invalid_argument` "<uri> isn't deleted." with hint
    "Pass a version, for example <uri>@<n>, to make an older version current."
  - Missing, or deleted past the grace period: `not_found`.
- **Object URI with a version** (`@3` or `@sha256:…`): makes that version
  current by adding a new version that copies its `blob_sha256`, `size`,
  `content_type`, `description` and `meta`; `uploaded_by` is the caller,
  `idempotency_key` null. Works on a live object and on a restorable one
  (which it also undeletes). If the named version is already the current
  version of a live object, nothing changes and the current version is
  returned.
  - Unknown version: `not_found` "<uri> has no version <v>."
- **Prefix or collection URI**: needs `recursive` (else `invalid_argument`
  "<uri> is a prefix." hint "Pass recursive to restore every deleted object
  under it."). Undeletes every restorable object under it. A version isn't
  allowed with recursive (`invalid_argument`). Restoring nothing returns
  `{ restored: [] }`.
- Version assignment and undelete take the object's row lock exactly like
  `upload_commit` (the no-op `UPDATE`), and re-check that the object is
  still restorable after taking it.
- Audited as `object.restore` in the same transaction: target is the URI
  given (as `delete` does), detail `{ count }`, plus `{ version,
  from_version }` when a version was given.
- Share links can't call it (it isn't in `LINK_OPERATIONS`).
- CLI formatter: `Restored <uri> (version <n>)` per line, or
  `Nothing to restore.` (formatters see only the output).

## The worker

`packages/server/src/worker/`. `runMaintenance(deps)` runs one pass of
every job and returns counts; `startWorker(deps, intervalMs)` runs a pass
right away and then on the interval, never two at once in one process, and
logs (never throws) a failed pass. `deps` is `{ db, blobs, config: {
deleteGraceDays, uploadTtlSeconds }, now }`. Both are exported from
`@storage/server`. `storage-server worker` runs only the worker;
`serve` starts it unless `STORAGE_WORKER=false`.

Each job works in batches of 500 and loops until a batch comes back short.

The worker's audit actor is `system:worker`, with no token.

### Job 1: purge objects past the grace period

For objects with `deleted_at <= now - grace`, per batch, in one transaction:

1. Take the row locks (the no-op `UPDATE` on `objects`, restricted to
   `deleted_at <= cutoff`), then re-select the ids still past the cutoff. A
   concurrent `put` or `restore` that won the lock has cleared
   `deleted_at`, and those objects are skipped.
2. Delete `uploads` rows whose `version_id` points at their versions, then
   the versions, then the objects.
3. Record one `object.purge` event per collection: target the collection
   URI, detail `{ count, paths }` with up to 100 paths.

`upload_commit` re-inserts the object row if it vanished between its
`INSERT … ON CONFLICT DO NOTHING` and its lock (a purge got there first), so
a commit racing a purge creates a fresh object instead of failing.

### Job 2: remove unreferenced blobs

Invariant: **a `blobs` row exists only while its bytes exist.** The worker
deletes bytes only while holding the row's lock, after confirming nothing
references it, and deletes the row in the same transaction. If deleting the
bytes fails, the transaction rolls back.

A blob `(org_id, sha256)` is referenced by any version in a collection of
that org with that `blob_sha256`, or by an upload of that org and sha256
with `expires_at > now - 1 hour` (committed or not; the hour covers a
commit that started just before expiry).

Per candidate (an unreferenced `blobs` row), one transaction: no-op
`UPDATE blobs` on the row (lock), re-check that it's unreferenced, delete
the bytes (`BlobStore.delete`, which must not fail for a missing key), then
delete the row.

`upload_commit` changes so a commit can never reference deleted bytes:

- In its transaction, after inserting the `blobs` row (`ON CONFLICT DO
  NOTHING`), it takes the row's lock with a no-op `UPDATE`.
- If its insert created the row, it `stat`s the bytes inside the
  transaction and fails with `precondition_failed` ("The upload's bytes
  have not been transferred yet.", hint "Start the upload again.") if
  they're missing or the wrong size. If the row already existed, the
  invariant means the bytes are there.
- The `stat` before the transaction stays, for the early error.

### Job 3: bytes from abandoned uploads

An upload with `transfer_required = 1`, `version_id` null and `expires_at
<= now - 1 hour` may have left bytes in the store with no `blobs` row. Per
distinct `(org_id, sha256)`, one transaction:

1. `INSERT` a `blobs` row `ON CONFLICT DO NOTHING`. If nothing was
   inserted, a real row exists: skip (job 2 owns it). If it was inserted,
   the transaction holds the new row, so a concurrent commit's insert
   waits for it.
2. Re-check that it's unreferenced (as in job 2), delete the bytes, delete
   the row.

### Job 4: expired rows

Delete rows whose expiry is more than a day old:

- `uploads` with `expires_at < now - 1 day` (committed or not). A commit
  retried after that gets `not_found`.
- `sign_in_states`, then `device_authorizations` and
  `oauth_authorization_requests` no longer referenced by a
  `sign_in_states` row, then `connect_states` and `connect_tickets`.

`oauth_refresh_tokens` are kept: a replayed used refresh token revokes its
grant, and that check needs the row.

## Migration `0011_lifecycle`

Indexes only: `versions(blob_sha256)`, `uploads(org_id, sha256)`,
`uploads(version_id)`, `uploads(expires_at)`, `objects(deleted_at)`.

## Behaviors to test

Tests run the worker with `h.runMaintenance()` (harness), which calls
`runMaintenance` with the harness's database, blob store and clock.

Restore:

1. Delete an object, restore it: `stat` works again with the same version
   and content; `restored` lists it with that version.
2. Restore a live object without a version: `invalid_argument`.
3. Restore `uri@1` on a live object at version 2: a version 3 with version
   1's sha256, size, content type, description and meta; `get` returns
   version 1's bytes.
4. Restore `uri@2` when 2 is current: no new version; returns version 2.
5. Delete, advance past the grace period (7 days + 1 ms), restore:
   `not_found`, without running the worker.
6. Delete a prefix recursively, restore it without `recursive`:
   `invalid_argument`; with `recursive`: every object is back, and
   objects outside the prefix or deleted past the grace period are not.
7. A reader gets `forbidden`; a share link can't call it.
8. `audit` shows `object.restore` with the count.
9. Restore an unknown version of a deleted object: `not_found`.

Worker:

10. Delete an object, advance 7 days + 1 ms, run maintenance: `history`
    and `restore` give `not_found`; `audit` shows `object.purge` with the
    path; the blob's bytes are gone from the store.
11. Within the grace period, maintenance leaves a deleted object
    restorable.
12. Two objects with the same content; delete one and purge it: the other
    still downloads (the blob is kept).
13. After a purge, `put` to the same path creates version 1 and downloads.
14. A blob kept by an old version of a live object survives maintenance.
15. An upload initiated but never committed: after `uploadTtl + 1 hour`,
    maintenance removes its bytes and the `uploads` row is removed a day
    after expiry.
16. Re-uploading content whose blob was garbage-collected transfers the
    bytes again and downloads correctly.
17. Running maintenance twice in a row, and two passes concurrently, is
    harmless (second pass purges nothing, no errors).
18. Expired sign-in states and device authorizations older than a day are
    deleted; fresh ones are kept.
