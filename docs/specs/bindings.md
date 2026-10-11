# Spec: bindings and event-based lifecycle rules

Status: in progress. Milestone 4, PR 3 in the [roadmap](../roadmap.md).

## Why

Design §12 promises that a PR's artifacts go away some days after the PR
closes. PR 2 added time-based rules counted from a collection's creation.
This PR links a collection to a GitHub pull request (a **binding**, design
§7.1), learns when the PR closes, merges or reopens, and lets lifecycle
rules count from those events. It also adds org-level default rules, so new
collections start with a policy.

The roadmap listed this as one PR with the `gh-pr:` shorthand. It is split:

- **This PR**: `bind` and `unbind`, `delete_after_event` rules, org default
  rules, and the two event sources (a webhook and polling).
- **Next PR**: the `gh-pr:` shorthand and auto-create on first write,
  including the `@<branch>` form. It needs a decision this PR doesn't: which
  storage org a `gh-pr:acme/web#482` URI lands in.

Out of scope: the GitHub App's installation flow (per-org app installs for
the hosted service), the optional PR comment (PR 4), repo-derived access,
the collection `state` (`expiring`), and `info`.

## Targets

A binding target is `github:<owner>/<repo>#<number>`:

- `owner`: 1-39 characters, letters, digits and inner hyphens.
- `repo`: 1-100 characters, letters, digits, `.`, `_` and `-`, not `.` or
  `..`.
- `number`: a positive integer up to 2^31-1, no leading zeros.

GitHub names are case-insensitive, so the target is stored and shown
lowercased. Anything else is `invalid_argument` with hint
"Targets look like github:acme/web#482." The parser is `parseTarget` in
`packages/core/src/bindings.ts`, shared by the client and server, with
`formatTarget` and `pullRequestUrl` (`https://github.com/<owner>/<repo>/pull/<n>`).

## Storage: migration `0013_bindings`

Table `bindings`:

| column | type | notes |
|---|---|---|
| `id` | text pk | `bnd_…` |
| `org_id` | text not null | |
| `collection_id` | text not null, unique | at most one binding per collection |
| `kind` | text not null | `github` |
| `target` | text not null | normalized, `github:acme/web#482` |
| `owner`, `repo` | text not null | lowercased |
| `number` | integer not null | |
| `state` | text not null | `unknown`, `open`, `closed`, `merged` |
| `closed_at` | text | when the PR closed, merged or not; null while open |
| `merged_at` | text | when it merged |
| `source_updated_at` | text | the PR's `updated_at` from the last update applied |
| `polled_at` | text | last poll attempt |
| `poll_error` | text | last poll failure, for `lifecycle` to show; null after a success |
| `created_by` | text not null | |
| `created_at` | text not null | |

Unique `(org_id, target)`: a PR maps to at most one collection per org, so
the `gh-pr:` shorthand can resolve it later. Index `(owner, repo, number)`
for the webhook, and `(state, polled_at)` for polling.

`orgs.default_lifecycle_rules`: text, not null, default `'[]'`.

## `bind` and `unbind` (public operations)

`bind <uri> <target>`: `access: write`, `role: writer`, all surfaces, added
to `TOOL_NAMES`. Input `{ uri, target }`, `uri` a collection URI.

- Creates the binding with `state: "unknown"`. `bind` doesn't call GitHub;
  the state arrives with the next webhook delivery or poll.
- Binding to the target it already has is a no-op: `changed: false`.
- A collection bound to another target: `conflict`, hint "Run storage unbind
  <uri> first."
- Another collection in the org already bound to the target: `conflict`
  naming that collection.
- Audited as `binding.create`: target the collection URI, detail
  `{ target }`.

`unbind <uri>`: `access: write`, `role: writer`, `destructive: false`.
Removes the binding; `changed: false` if there was none. Audited as
`binding.delete` with `{ target }`. Event rules then wait again (see below).

Both return `{ uri, binding: Binding | null, changed }`, where

```ts
Binding = {
  target: string,             // github:acme/web#482
  url: string,                // https://github.com/acme/web/pull/482
  state: "unknown" | "open" | "closed" | "merged",
  closed_at: string | null,
  merged_at: string | null,
  updated_at: string | null,  // source_updated_at
  poll_error: string | null,
}
```

Share links can call neither.

## Event-based rules

A third rule action, design §12.1:

```json
{ "prefix": "videos/", "delete_after_event": { "event": "binding.closed", "after": "7d" } }
```

- `event`: `binding.closed` (the PR closed, merged or not) or
  `binding.merged`. `binding.reopened` isn't a rule event: a reopen clears
  `closed_at`, which cancels any pending event rule.
- `after`: a duration, as for `delete_after`.
- A rule still needs exactly one action; `delete_after_event` is strict
  (unknown keys are `invalid_argument`).

An event rule is **due** at `closed_at + after` or `merged_at + after`. Until
the event happens (no binding, `state` `unknown` or `open`, or closed but
not merged for a merged rule) it has no due time.

Rule resolution in `packages/server/src/lifecycle.ts` stays as it is, with
event rules joining the delete rules:

- The governing delete rule is still the matching delete rule (either kind)
  with the longest prefix. Among equal prefixes, the one due earliest wins,
  and a rule with no due time counts as due last. So `{ "": delete_after 90d }`
  plus `{ "": closed + 7d }` deletes at whichever comes first, and
  `{ "keep/": closed + 365d }` keeps `keep/` alive past a `""` rule even
  while the PR is open.
- `governingDeleteRule(rules, path, times)` takes
  `times: { createdAt, closedAt, mergedAt }` and returns
  `{ rule, dueAt: Date | null } | null`. `dueAt(rule, times)` likewise.
- `assertNotExpired` refuses writes and restores only when `dueAt` is set
  and past. A reopen therefore makes a prefix writable again.

What's already expired stays deleted after a reopen. It's restorable for the
grace period, like any expired object.

## Org default rules

`set-lifecycle` and `lifecycle` also take an org URI (`storage://acme/`):

- They read and replace `orgs.default_lifecycle_rules`, with the same
  validation. `set-lifecycle` needs an org-level admin grant and an unscoped
  token, like `grants` on an org; `lifecycle` an org-level reader grant and
  an unscoped token. A scoped token gets `forbidden`; without an org-level
  grant the org is `not_found`.
- `create` copies the org's defaults into the new collection's
  `lifecycle_rules` when it inserts the row. Changing the defaults later
  doesn't touch existing collections.
- The output for an org URI has `scheduled: []`, `waiting: []`,
  `next: null` and `binding: null`. `lifecycle.set` is audited with the org
  URI as its target.

## `lifecycle` output changes

- `binding`: the collection's `Binding`, or null.
- `scheduled` entries carry either `delete_after` or `delete_after_event`
  (each optional now), plus `at`, `due` and `objects` as before. Event rules
  appear here once their event has happened.
- `waiting`: event rules whose event hasn't happened yet:
  `{ prefix, event, after, objects }`, in rule order, deduplicated like
  `scheduled`. `objects` counts the live objects it would govern if it were
  due now. Listed even when `objects` is 0.
- `next` is unchanged: the first `scheduled` entry not due with objects.

CLI formatter: event rules print as `videos/  delete 7d after binding.closed`;
a `Bound to github:acme/web#482 (open)` line before `Next:`; waiting rules
as `Waiting: videos/ deletes 7d after binding.closed (3 objects)`.

## Event sources

Both paths call one function, `applyPullRequest(db, match, pr, source, now)`
in `packages/server/src/github/bindings.ts`, where `pr` is
`{ state: "open" | "closed", merged_at, closed_at, updated_at }` as GitHub
reports it and `source` is `webhook` or `poll`. For each binding with that
`owner`, `repo` and `number` (any org), in one transaction:

1. Skip it if `source_updated_at` is set and later than `pr.updated_at`
   (an out-of-order delivery).
2. New state: `merged` if `merged_at` is set, else `closed` if
   `state = closed`, else `open`. Store it with `closed_at`, `merged_at`
   (null when open), and `source_updated_at`.
3. If the state changed, record one audit event, actor `system:github`,
   target the collection URI, detail `{ target, source, at }`:
   `binding.merged` (to merged), `binding.closed` (to closed),
   `binding.reopened` (closed or merged to open). `unknown` to `open` is not
   audited.

### Webhook

`POST /v1/github/webhook`, served only when `STORAGE_GITHUB_WEBHOOK_SECRET`
is set (otherwise `not_found` like any unknown path). It works as a GitHub
App's webhook or a repo or org webhook with content type
`application/json`.

- The body is limited to 5 MB, read raw, and checked against
  `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 with the secret,
  compared in constant time. A missing or wrong signature is 401
  `unauthenticated` and nothing is parsed.
- `X-GitHub-Event: ping` returns 200 `{ ok: true }`.
- `pull_request` with `action` `closed`, `reopened`, `opened`, `edited` or
  `synchronize` calls `applyPullRequest` with
  `repository.owner.login`, `repository.name`, `pull_request.number`, and the
  pull request's `state`, `merged_at`, `closed_at` and `updated_at`.
  Returns 200 `{ ok: true, bindings: <n updated> }`.
- Any other event or action: 200 `{ ok: true, bindings: 0 }`. A malformed
  payload with a valid signature: 400 `invalid_argument`.
- No bearer token is needed or read on this route.

### Polling

When `STORAGE_GITHUB_POLL_TOKEN` is set, a worker job (job 0, before the
lifecycle jobs so a pass expires on fresh state) polls bindings:

- Picks up to 100 bindings with `state` other than `merged` whose
  `polled_at` is null or older than `STORAGE_GITHUB_POLL_INTERVAL_SECONDS`
  (default 900), never-polled first, then oldest. Bindings sharing a target
  across orgs are fetched once.
- `GET https://api.github.com/repos/<owner>/<repo>/pulls/<number>` with the
  token. Success: `applyPullRequest(…, "poll")`, then `polled_at = now`,
  `poll_error = null`.
- 404: `polled_at = now`, `poll_error = "GitHub returned 404 for
  <target>."`; the state is left as it was. 401 and 403: stop the job for
  this pass and log once; set nothing. Network errors: log, set
  `poll_error`, move on.
- `MaintenanceResult` gains `polledBindings`.

The poll client is `githubPulls({ token, fetch })` in
`packages/server/src/github/pulls.ts`, injected through `WorkerDeps.github`
so tests use a fake.

### Config

| variable | default | |
|---|---|---|
| `STORAGE_GITHUB_WEBHOOK_SECRET` | unset | Enables the webhook. At least 16 characters. |
| `STORAGE_GITHUB_POLL_TOKEN` | unset | A GitHub token that can read the bound repos' pull requests. Enables polling. |
| `STORAGE_GITHUB_POLL_INTERVAL_SECONDS` | 900 | |

`ServerConfig.githubAdapter: { webhookSecret: string | null; pollToken: string | null; pollIntervalSeconds: number }`.

### Security notes

- The poll token belongs to the server. Anyone who can `bind` in any org
  learns, through `lifecycle`, whether a PR the token can read is open,
  closed or merged (but nothing else about it). For a self-hosted install
  that's one company's repos. The hosted service should use per-org GitHub
  App installations instead (later work), and leave the poll token unset.
- `bind` never calls GitHub, so it can't be used to probe whether a private
  repo exists.
- The webhook trusts only signed deliveries, and only changes binding state.
  A delivery can't name a collection; it updates whatever is bound to the
  PR it describes.

## Audit actions

`AUDIT_ACTIONS` gains `binding.create`, `binding.delete`, `binding.closed`,
`binding.merged` and `binding.reopened`.

## Behaviors to test

Tests run in `tests/bindings.test.ts`. Webhook deliveries are signed by a
helper and sent through `h.fetch`; polling uses a fake `GitHubPulls` passed
to `h.runMaintenance`.

`bind` and `unbind`:

1. `bind storage://acme/c/ github:Acme/Web#482` stores `github:acme/web#482`,
   returns `state: "unknown"`, url, `changed: true`; `lifecycle` shows the
   binding; `audit` shows `binding.create`.
2. Binding again to the same target (any case) is `changed: false`, no
   second audit event.
3. Binding to a different target: `conflict`. Binding a second collection to
   the same target in the same org: `conflict`. The same target in another
   org works.
4. Invalid targets are `invalid_argument`: `github:acme/web`, `github:acme#1`,
   `gh:acme/web#1`, `github:acme/web#0`, `github:acme/web#01`,
   `github:-acme/web#1`, `github:acme/..#1`.
5. A reader gets `forbidden` on `bind`; a share link can't call it;
   `bind` on an object URI is `invalid_argument`.
6. `unbind` removes it (`binding.delete` audited); again is `changed: false`.

Rules:

7. `set-lifecycle` accepts `delete_after_event` and rejects: an unknown
   event, `binding.reopened`, a bad `after`, an extra key, a rule with both
   `delete_after` and `delete_after_event`.
8. With the PR open, a closed rule is in `waiting` with its object count and
   not in `scheduled`; `next` ignores it; maintenance deletes nothing.

Webhook:

9. A signed `pull_request` `closed` (merged) delivery sets `state: merged`,
   `closed_at`, `merged_at`; `audit` shows `binding.merged` by
   `system:github`. A closed rule moves to `scheduled` at
   `closed_at + after`; a merged rule too.
10. Closed without merge: `binding.closed`; a merged rule stays `waiting`.
11. After `after` passes, maintenance expires the governed objects
    (`object.expire`), and `put` into the prefix is `precondition_failed`.
12. A `reopened` delivery before the due time: `state: open`,
    `binding.reopened`, the rule waits again, and maintenance after the old
    due time deletes nothing. A `reopened` after expiry leaves expired
    objects deleted, and `put` works again.
13. An unsigned or wrongly signed delivery is 401 and changes nothing. With
    no secret configured the route is 404. `ping` is 200.
14. A delivery with an older `updated_at` than the last applied is ignored.
15. One delivery updates bindings to that PR in two orgs.
16. Other events (`push`) and actions (`labeled`) return 200 and change
    nothing.

Polling:

17. With a fake reporting the PR merged, maintenance sets `state: merged`
    (`binding.merged`, `source: poll`) and `polledBindings: 1`; a second
    pass within the interval polls nothing; after the interval it polls
    again unless merged.
18. A 404 sets `poll_error`, shown in `lifecycle`; a later success clears
    it.
19. Without a poll token, maintenance polls nothing.

Org defaults:

20. `set-lifecycle storage://acme/ --rules …` as org admin stores defaults;
    `lifecycle storage://acme/` shows them; `create` copies them into a new
    collection; changing defaults doesn't change that collection; a
    collection that already existed (`create` returns `created: false`) is
    unchanged.
21. An org writer and a scoped token get `forbidden` on org
    `set-lifecycle`; a collection-level admin gets `not_found`, as for
    `grants` on an org.

Rule resolution with event rules:

22. `""` at 90d and `""` closed + 7d: after the PR closes and 8 days pass,
    objects are expired (the earlier wins).
23. `keep/` closed + 365d with `""` at 1d: after 2 days with the PR open,
    `keep/x` is live and `a.txt` is expired.

Unit tests: `parseTarget` (valid and invalid forms, lowercasing),
`governingDeleteRule` with event times (no due time counts as last),
webhook signature verification.
