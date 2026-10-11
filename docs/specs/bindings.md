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
  rules, and a GitHub App that orgs install to report pull request state
  (its webhook, with polling as a backstop).
- **Next PR**: the `gh-pr:` shorthand and auto-create on first write,
  including the `@<branch>` form. It needs a decision this PR doesn't: which
  storage org a `gh-pr:acme/web#482` URI lands in.

Out of scope: the optional PR comment (PR 4), repo-derived access,
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
| `installation_id` | text not null | the GitHub App installation `bind` read the PR through |
| `created_by` | text not null | |
| `created_at` | text not null | |

Unique `(org_id, target)`: a PR maps to at most one collection per org, so
the `gh-pr:` shorthand can resolve it later. Index
`(installation_id, owner, repo, number)` for the webhook, and
`(state, polled_at)` for polling.

Table `github_installations`, the GitHub App installations linked to a
storage org:

| column | type | notes |
|---|---|---|
| `id` | text pk | `ghi_…` |
| `org_id` | text not null | |
| `installation_id` | text not null | GitHub's numeric id, as a string |
| `account_login` | text not null | lowercased GitHub user or org the app is installed on |
| `account_type` | text not null | `User` or `Organization` |
| `created_by` | text not null | the user who linked it |
| `created_at` | text not null | |

Unique `(org_id, installation_id)`; index `installation_id`. One storage
org can link several installations (one per GitHub account), and one
installation can be linked to several storage orgs, each by someone who
could see it on GitHub.

`connect_tickets` and `connect_states` gain a nullable `org_id`, so the
install flow reuses them with `provider = "github-app"`.

`orgs.default_lifecycle_rules`: text, not null, default `'[]'`.

## `bind` and `unbind` (public operations)

`bind <uri> <target>`: `access: write`, `role: writer`, all surfaces, added
to `TOOL_NAMES`. Input `{ uri, target }`, `uri` a collection URI.

- Needs the GitHub App configured (else `unavailable`, "The GitHub App
  isn't configured on this server."). Picks the org's installation whose
  `account_login` is the target's owner; none is `precondition_failed`,
  "No GitHub installation in <org> covers <owner>.", hint "Install the app
  with: storage github install storage://<org>/".
- Reads the PR through that installation
  (`GET /repos/<owner>/<repo>/pulls/<n>` with an installation token). A 404
  or 403 is `not_found`, "<target> isn't visible to the GitHub App in
  <org>.", hint "Add the repository to the app's installation on GitHub."
  Any other failure is `unavailable`. On success the binding is created
  with the PR's state and times (no `binding.closed`/`merged` event: the
  state is where it starts), `installation_id`, and `polled_at` set to now,
  so the first poll comes an interval later.
- Because `bind` reads only through installations the org linked itself,
  it can't learn anything about a repo the org hasn't granted.
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

## The GitHub App

One GitHub App per server, registered by whoever runs it (the hosted
service has its own). It needs the repository permission "Pull requests:
read", the "Pull request" and "Installation" webhook events, a webhook URL
of `<public url>/v1/github/webhook`, a callback URL of
`<public url>/github/install/callback`, and "Request user authorization
(OAuth) during installation" turned on. The README walks through it. It is
separate from the OAuth app that connects accounts.

### Config

| variable | |
|---|---|
| `STORAGE_GITHUB_APP_ID` | The App ID. |
| `STORAGE_GITHUB_APP_SLUG` | The app's URL name, for `https://github.com/apps/<slug>/installations/new`. |
| `STORAGE_GITHUB_APP_PRIVATE_KEY` | The PEM private key. `\n` escapes are accepted. Or `STORAGE_GITHUB_APP_PRIVATE_KEY_FILE`. |
| `STORAGE_GITHUB_APP_CLIENT_ID`, `STORAGE_GITHUB_APP_CLIENT_SECRET` | For the user authorization in the install flow. |
| `STORAGE_GITHUB_APP_WEBHOOK_SECRET` | At least 16 characters. |
| `STORAGE_GITHUB_POLL_INTERVAL_SECONDS` | Default 900. |

All of them (but the interval) or none; a partial set fails at startup.
`ServerConfig.githubApp` is `{ appId, slug, privateKey, clientId,
clientSecret, webhookSecret } | null`, and `githubPollIntervalSeconds`.

The client is `GitHubApp` (`packages/server/src/github/app.ts`), injected
through `AppOptions.githubApp` and `WorkerDeps.githubApp` so tests use a
fake:

```ts
interface GitHubApp {
  installUrl(state: string): string;              // https://github.com/apps/<slug>/installations/new?state=…
  exchangeCode(code: string): Promise<string>;     // user access token; SignInError when GitHub refuses the code
  userInstallations(userToken: string): Promise<Installation[]>; // GET /user/installations, all pages up to 10
  pull(installationId: string, owner: string, repo: string, number: number): Promise<PullResult>;
}
type Installation = { id: string; account_login: string; account_type: "User" | "Organization" };
```

`pull` authenticates as the installation: an RS256 JWT (`iss` app id, `iat`
60 seconds back, `exp` 9 minutes ahead) buys an installation token from
`POST /app/installations/<id>/access_tokens`, cached in memory until 5
minutes before it expires. A 401 on the token request throws.

### Linking an installation: `storage github install <org-uri>`

Internal operation `github_install_start`, input `{ uri }` (an org URI).
Needs an unscoped user token (like `connect_start`) and an org-level admin
grant. Returns `{ url, expires_at }`, a single-use link valid for 10
minutes, `<public url>/github/install/start?ticket=…`. The CLI command
`storage github install storage://acme/` opens or prints it and waits,
polling `github_installation_list`, until a new installation appears or
the link expires.

The browser flow mirrors connecting an account (spec: github-connect), with
the cookie path `/github/install/`:

1. `/github/install/start?ticket=…` consumes the ticket and sends the
   browser through Google sign-in to check it's the same Storage user, so
   an org admin can't send the link to someone else and capture their
   installation.
2. `/github/install/google/callback` checks the Google account, advances
   the state, and redirects to `installUrl(state)`.
3. GitHub installs (or reconfigures) the app, authorizes the user, and
   redirects to `/github/install/callback?code=…&installation_id=…&state=…`.
   The server consumes the state, exchanges the code, lists the user's
   installations, and links `installation_id` only if it's in that list
   (else 403, "Your GitHub account can't see that installation."). It
   records `github.install` (target the org URI, detail
   `{ installation_id, account }`) and shows "Linked <account> to
   storage://acme/. You can close this tab." Linking an installation
   that's already linked to the org says so and changes nothing.

Install flows need Google sign-in configured, like connect; without it
`github_install_start` is `unavailable` and the start page says installing
isn't available. The flow's states are only accepted by its own routes
(`provider = "github-app"`), and the connect routes only accept their own.

`github_installation_list` (internal, org-level reader, unscoped token):
`{ uri, installations: [{ installation_id, account_login, account_type,
created_by, created_at }] }`. CLI: `storage github list storage://acme/`.

`github_installation_remove` (internal, org admin, unscoped token), input
`{ uri, installation_id }`: unlinks it (`github.uninstall` audited);
bindings that read through it keep their state but stop updating, and
`lifecycle` shows their `poll_error` after the next poll. `not_found` if
it isn't linked. CLI: `storage github remove storage://acme/ <id>`.

## Event sources

Both paths call `applyPullRequest(db, match, pr, source, now)` in
`packages/server/src/github/bindings.ts`, where `match` is
`{ installationId, owner, repo, number }`, `pr` is
`{ state: "open" | "closed", merged_at, closed_at, updated_at }` as GitHub
reports it, and `source` is `webhook` or `poll`. It updates the bindings
with that `installation_id`, `owner`, `repo` and `number`, each in its own
transaction:

1. Skip it if `source_updated_at` is set and later than `pr.updated_at`
   (an out-of-order delivery).
2. New state: `merged` if `merged_at` is set, else `closed` if
   `state = closed`, else `open`. Store it with `closed_at`, `merged_at`
   (null when open), and `source_updated_at`.
3. If the state changed, record one audit event, actor `system:github`,
   target the collection URI, detail `{ target, source, at }`:
   `binding.merged` (to merged), `binding.closed` (to closed),
   `binding.reopened` (closed or merged to open).

### Webhook

`POST /v1/github/webhook`, served only when the GitHub App is configured
(otherwise `not_found` like any unknown path).

- The body is limited to 5 MB, read raw, and checked against
  `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 with the app's webhook
  secret, compared in constant time. A missing or wrong signature is 401
  `unauthenticated` and nothing is parsed.
- `X-GitHub-Event: ping` returns 200 `{ ok: true }`.
- `pull_request` with `action` `closed`, `reopened`, `opened`, `edited` or
  `synchronize` calls `applyPullRequest` with `installation.id`,
  `repository.owner.login`, `repository.name`, `pull_request.number`, and
  the pull request's `state`, `merged_at`, `closed_at` and `updated_at`.
  Returns 200 `{ ok: true, bindings: <n updated> }`. A delivery only
  reaches bindings made through its own installation.
- `installation` with `action: deleted`: removes every
  `github_installations` row with that id (`github.uninstall` by
  `system:github` for each org). Returns `{ ok: true, bindings: 0 }`.
- Any other event or action: 200 `{ ok: true, bindings: 0 }`. A malformed
  payload with a valid signature: 400 `invalid_argument`.
- No bearer token is needed or read on this route.

### Polling

A backstop for missed deliveries and for servers GitHub can't reach. A
worker job (job 0, before the lifecycle jobs so a pass expires on fresh
state), when the app is configured:

- Picks up to 100 bindings with `state` other than `merged` whose
  `polled_at` is null or older than `STORAGE_GITHUB_POLL_INTERVAL_SECONDS`,
  never-polled first, then oldest. Bindings sharing an installation and
  PR are fetched once.
- If the binding's `installation_id` is no longer linked to its org:
  `polled_at = now`, `poll_error = "The GitHub installation for <target>
  was removed from <org>."`, no request.
- Otherwise `githubApp.pull(installation_id, …)`. Success:
  `applyPullRequest(…, "poll")`, then `polled_at = now`,
  `poll_error = null`. A non-2xx status: `polled_at = now`,
  `poll_error = "GitHub returned <status> for <target>."`, state left as it
  was. A thrown error: log, `poll_error = "Couldn't reach GitHub for
  <target>."`, move on.
- `MaintenanceResult` has `polledBindings`.

### Security notes

- Every GitHub read for an org goes through installations that org linked,
  and linking needs someone who can see the installation on GitHub and who
  passes the Google check as the Storage user who started it. So `bind`,
  polling and webhooks reveal nothing about repos the org hasn't granted
  the app. There is no server-wide GitHub token.
- The app asks only for read access to pull requests.
- The webhook trusts only signed deliveries, and only changes binding
  state. A delivery can't name a collection; it updates what was bound
  through its installation.

## Audit actions

`AUDIT_ACTIONS` gains `binding.create`, `binding.delete`, `binding.closed`,
`binding.merged`, `binding.reopened`, `github.install` and
`github.uninstall`.

## Behaviors to test

Tests run in `tests/bindings.test.ts` and `tests/github-install.test.ts`
with a fake `GitHubApp` passed to the harness. Webhook deliveries are
signed by a helper and sent through `h.fetch`.

`bind` and `unbind`:

Unless a test says otherwise, `acme` has linked installation `1001` on
GitHub account `acme`, and the fake reports `acme/web#482` open.

1. `bind storage://acme/c/ github:Acme/Web#482` stores `github:acme/web#482`,
   returns `state: "open"`, url, `changed: true`; `lifecycle` shows the
   binding; `audit` shows `binding.create` and no `binding.*` state event.
   Binding a PR the fake reports merged starts as `merged` with its times.
2. Binding again to the same target (any case) is `changed: false`, no
   second audit event.
3. Binding to a different target: `conflict`. Binding a second collection to
   the same target in the same org: `conflict`. The same target in another
   org that linked the same installation works.
3a. No installation in the org for the owner: `precondition_failed` with the
   install hint. The fake answering 404 or 403: `not_found`. 500 or a thrown
   error: `unavailable`. The app not configured: `unavailable`. Nothing is
   stored in any of these cases.
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
    no app configured the route is 404. `ping` is 200.
14. A delivery with an older `updated_at` than the last applied is ignored.
15. One delivery updates bindings to that PR in two orgs that bound it
    through the same installation; a delivery naming another installation
    id changes neither.
16. Other events (`push`) and actions (`labeled`) return 200 and change
    nothing.
16a. `installation` `deleted` unlinks it from every org (`github.uninstall`
    by `system:github`); the next poll of its bindings sets the "was
    removed" `poll_error` without calling the fake.

Polling:

17. After the fake starts reporting the PR merged, maintenance sets
    `state: merged` (`binding.merged`, `source: poll`) with
    `polledBindings: 1`, calling the fake with installation `1001`; a second
    pass within the interval polls nothing; after the interval it polls
    again unless merged.
18. A 404 sets `poll_error`, shown in `lifecycle`; a later success clears
    it. A thrown error sets the "Couldn't reach GitHub" error.
19. Without the app configured, maintenance polls nothing.

Installing (`tests/github-install.test.ts`, with the fake Google provider
from `tests/fake-idp.ts`):

24. `github_install_start` as an org admin with an unscoped token returns a
    `/github/install/start?ticket=` URL. A scoped token, an org writer and a
    share link are refused; without the app it's `unavailable`.
25. The full flow (start, Google callback as the same user, GitHub callback
    with an `installation_id` in the fake's `userInstallations`) links it:
    `github_installation_list` shows it, `audit` shows `github.install`.
26. A GitHub callback whose `installation_id` isn't in the user's
    installations is 403 and links nothing.
27. Signing in to Google as a different Storage user stops the flow at the
    Google callback (403), before GitHub.
28. A reused or expired ticket, a missing cookie, and a replayed state are
    each refused (400).
29. Linking an installation that's already linked says so and adds no
    second row or audit event.
30. `github_installation_remove` unlinks it (`github.uninstall`); unknown
    ids are `not_found`; an org writer is `forbidden`.

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
