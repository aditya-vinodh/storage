# Spec: lifecycle rules

Status: done. Milestone 4, PR 2 in the [roadmap](../roadmap.md).

## Why

Design §12 promises that collections clean themselves up: a PR's artifacts
go away some days after it closes, and long-lived collections keep only the
last few versions of each object. PR 1 built the worker, the grace period
and the purge. This PR adds the rules and the two operations that manage
them, and teaches the worker to apply them. Every rule ends in the soft
delete from PR 1, so anything a rule deletes stays restorable for the grace
period.

Out of scope, for later PRs: event-based rules (`delete_after_event`, PR 3,
with bindings), org-level default rules for new collections (PR 3, with
`gh-pr:` auto-create), the collection `state` (`expiring`), and `info`.

## Rules

A collection has an ordered list of at most 50 rules. Each rule has a
`prefix` and exactly one action:

```json
[
  { "prefix": "", "delete_after": "90d" },
  { "prefix": "videos/", "delete_after": "7d" },
  { "prefix": "", "keep_versions": 5 }
]
```

- `prefix`: `""` for the whole collection, or a path prefix ending in `/`,
  normalized with `normalizePath` (a leading `/` is dropped). A prefix
  without a trailing `/` is `invalid_argument`.
- `delete_after`: a duration, `<n>d` or `<n>h` with `n` from 1 to 36500
  days (876000 hours). Measured from the collection's `created_at`, as in
  design §12.1: the rule is **due** at `created_at + delete_after`.
- `keep_versions`: an integer from 1 to 1000. Each object keeps its newest
  `keep_versions` versions; older ones are pruned.

A rule with both actions, or neither, is `invalid_argument`. Unknown keys
are `invalid_argument` too, so a misspelt `delete-after` can't pass
silently.

### Which rule applies to an object

For an object at `path`, the rules whose `prefix` is a prefix of `path` are
the ones that match. Delete rules and keep rules are resolved separately:

- **Delete**: the governing rule is the matching `delete_after` rule with the
  longest prefix; among rules with that prefix, the one due earliest
  (design §12.1). A longer prefix wins even when it's due later, so
  `{ prefix: "keep/", delete_after: "3650d" }` protects `keep/` from a
  `{ prefix: "", delete_after: "30d" }` rule.
- **Keep**: the matching `keep_versions` rule with the longest prefix; among
  rules with that prefix, the smallest count.

These live in one module, `packages/server/src/lifecycle.ts`, used by the
handlers, the upload and restore checks, and the worker:

- `parseRules(json: string): LifecycleRule[]` reads the stored column.
- `durationMs(value: string): number`.
- `dueAt(rule, collectionCreatedAt: string): Date`.
- `governingDeleteRule(rules, path, createdAt)` → `{ rule, dueAt } | null`.
- `keepVersionsFor(rules, path): number | null`.

## Storage: migration `0012_lifecycle_rules`

`collections.lifecycle_rules`: text, not null, default `'[]'`, a JSON array
of rules in the form `set-lifecycle` stored them (normalized prefixes,
original order). `CollectionsTable` gains the field, and every
`insertInto("collections")` sets it.

## `set-lifecycle` (public operation)

`set-lifecycle <uri> --rules <json>`, `access: write`, `role: admin`,
`destructive: true`, all surfaces. Added to `TOOL_NAMES`.

Input: `{ uri, rules: LifecycleRule[] }`, `uri` a collection URI
(anything else is `invalid_argument`). `rules` replaces the collection's
rules; `[]` removes them all.

Output: the same shape as `lifecycle`, after the change, plus
`changed: boolean` (false when the normalized rules equal the stored ones).

Audited as `lifecycle.set` when changed: target the collection URI, detail
`{ rules, previous }`.

Share links can't call it. A token scoped below admin gets `forbidden`.

CLI: an array input whose items are objects takes JSON. `--rules` accepts
either a JSON array (`--rules '[]'`, `--rules '[{"prefix":"","keep_versions":3}]'`)
or one JSON object per repeat (`--rules '{"prefix":"videos/","delete_after":"7d"}'
--rules '...'`); the values are concatenated. Bad JSON is a usage error.
This lives in the generic `optionFor` in `packages/cli/src/program.ts`.

## `lifecycle` (public operation)

`lifecycle <uri>`, `access: read`, `role: reader`, all surfaces. Added to
`TOOL_NAMES`. Not available to share links.

Input: `{ uri }`, a collection URI.

Output:

```ts
{
  uri: string,                // collection URI
  rules: LifecycleRule[],     // as stored
  scheduled: Array<{
    prefix: string,           // the rule's prefix
    delete_after: string,
    at: string,               // ISO due time
    due: boolean,             // at <= now
    objects: number,          // live objects this rule governs now
  }>,                         // one per delete rule that governs at least one object or isn't due yet, sorted by at, then prefix
  next: { prefix: string, at: string, objects: number } | null,
                              // the first scheduled entry that is not due and governs at least one object
}
```

A due rule with no live objects left is dropped from `scheduled`: it has
already done its work. A rule that governs nothing because a longer prefix
covers everything under it is still listed while it isn't due, with
`objects: 0`, so a rule just set always shows up.

CLI formatter: the rules, one per line (`videos/  delete after 7d`,
`(all)  keep 5 versions`), then `Next: deletes videos/ (3 objects) on
<date>` or `No deletion scheduled.`

## Writes into a due prefix are refused

Once an object's governing delete rule is due, the worker deletes it on its
next pass. So that an agent finds out at write time instead of losing the
file minutes later:

- `upload_initiate` fails with `precondition_failed`: "Lifecycle rule
  <prefix or (all)> deleted <collection uri><prefix> on <date>." hint
  "Change the rules with set-lifecycle to write here." (checked after the
  role check, before anything is written).
- `restore` fails the same way, without changing anything, if the object
  (or, with `recursive`, any object it would restore) is governed by a due
  rule. Restoring a version (`@n`) of a live object is refused the same way.

## The worker

Two new jobs in `runMaintenance`, run before the purge (job 1), so that a
pass prunes and expires first and purges what's past the grace period after.
`MaintenanceResult` gains `expiredObjects` and `prunedVersions`.

Collections with rules are found with `lifecycle_rules <> '[]'`.

### Expire objects governed by a due rule

For each collection with a delete rule that is due, page through its live
objects by path (500 at a time, keyset on path) and pick those whose
governing rule is due. Per batch, in one transaction:

1. Take the row locks (the no-op `UPDATE` on `objects`, restricted to
   `deleted_at is null`), then re-select the ids still live.
2. Set `deleted_at = now` on those.
3. Record one `object.expire` event for the collection: actor
   `system:worker`, target the collection URI, detail `{ count, paths }`
   with up to 100 paths, and `rules` (the distinct governing prefixes).

The rules are read once per collection per pass; a `set-lifecycle` that
lands mid-pass applies from the next pass.

### Prune versions beyond `keep_versions`

For each collection with a keep rule, find objects (live or deleted) with
more versions than the smallest `keep_versions` among its rules, 500 at a
time, and work out each object's own count with `keepVersionsFor`. Per
batch, in one transaction:

1. Take the objects' row locks (no-op `UPDATE`), the way `upload_commit`
   does, so a concurrent commit can't be assigned a version being pruned.
2. Per object, delete versions with `version <= max(version) - keep`. The
   current version is always the highest, so it's never pruned. First
   delete `uploads` rows whose `version_id` points at those versions.
3. Record one `version.prune` event for the collection: target the
   collection URI, detail `{ count, paths }` (count of versions removed,
   up to 100 paths).

Pruning is a hard delete: a pruned version is gone from `history` and
`restore @n` at once, and job 2 removes its bytes if nothing else uses
them. This is the only hard delete a rule can cause, and it's what
`keep_versions` asks for.

Both jobs are safe to run concurrently with themselves and with the API.

## Audit actions

`AUDIT_ACTIONS` gains `lifecycle.set`, `object.expire` and `version.prune`.

## Behaviors to test

Tests set rules through the operations and run the worker with
`h.runMaintenance()`, advancing the clock with `h.advance()`.

`set-lifecycle` and `lifecycle`:

1. Set two delete rules and a keep rule: `lifecycle` returns them as given
   (prefix `/videos/` normalized to `videos/`), `changed: true`.
2. Setting the same rules again: `changed: false`, and no second
   `lifecycle.set` audit event.
3. `--rules '[]'` (empty) clears them; `lifecycle` shows no rules,
   `scheduled: []`, `next: null`.
4. Invalid rules are `invalid_argument`: both actions, neither action,
   unknown key, `delete_after: "7"`, `"0d"`, `keep_versions: 0`, a prefix
   without a trailing `/`, a prefix with `..`, 51 rules.
5. A writer gets `forbidden` on `set-lifecycle`; a reader can call
   `lifecycle`; a share link can call neither.
6. `lifecycle` on an object URI is `invalid_argument`; on a missing
   collection, `not_found`.
7. `scheduled` and `next`: with `""` at 30d and `videos/` at 7d and objects
   in both, `next` is `videos/` at `created_at + 7d` with its object count,
   and the `""` entry counts only objects outside `videos/`.
8. `audit` shows `lifecycle.set` with the rules and previous rules.

Worker, delete rules:

9. A rule not yet due: maintenance deletes nothing.
10. Advance past the due time: maintenance soft-deletes the governed live
    objects; `stat` is `not_found`; `audit` shows `object.expire` with the
    paths, actor `system:worker`. Objects outside the prefix are untouched.
11. Most specific prefix wins: `""` at 1d and `keep/` at 3650d; after 2 days
    `keep/x` is still there and `a.txt` is deleted.
12. Among equal prefixes the earliest wins: `videos/` at 2d and at 10d;
    after 3 days `videos/` objects are deleted.
13. After expiry, objects are restorable only after the rules change:
    `restore` gives `precondition_failed`; after `set-lifecycle` removes the
    rule, `restore` works and the next maintenance leaves the object alone.
14. Past the grace period after expiry, maintenance purges the object
    (`object.purge`), as for a manual delete.
15. `put` into a due prefix gives `precondition_failed`; `put` outside it
    works.
16. Hour durations: a `"1h"` rule is due after an hour.
17. Running maintenance twice records one `object.expire` event.

Worker, keep rules:

18. `keep_versions: 2` with 4 versions: after maintenance `history` shows
    versions 3 and 4; `restore @1` is `not_found`; `audit` shows
    `version.prune` with count 2.
19. A more specific keep rule wins: `""` keeps 1, `docs/` keeps 3.
20. A deleted object's old versions are pruned too, and `restore` (no
    version) still brings it back at its current version.
21. A pruned version's blob is removed when nothing else uses it, and kept
    when another object's version shares it.

Unit tests (`packages/server/src/lifecycle.test.ts`): `durationMs`,
`governingDeleteRule` (longest prefix, earliest among equals, no match),
`keepVersionsFor`.
