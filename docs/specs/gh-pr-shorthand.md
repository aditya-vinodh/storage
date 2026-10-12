# Spec: the `gh-pr:` shorthand

Status: done (PR #21). Milestone 4, PR 4 in the [roadmap](../roadmap.md).

## Why

Design §9.1 and §12.2 let agents address a pull request's artifacts by the
PR instead of a collection slug: `storage push ./artifacts gh-pr:acme/web#482/`
should find the collection bound to that PR, or create and bind one on the
first write. PR 3 ([bindings](bindings.md)) added the bindings; this PR adds
the shorthand on top of them.

Out of scope: binding to a branch that has no open PR yet and re-binding
when one opens (design §12.2's pending branch binding; it needs nullable
binding numbers and its own webhook handling, so it's a later PR), the
optional PR comment, and a per-org slug template (the slug is fixed below).

## Which org a `gh-pr:` URI lands in

A storage org can hold a PR's collection only if it linked a GitHub App
installation for the PR's owner (bindings read PRs through that
installation). The shorthand resolves among those orgs:

- **Candidates** are the orgs that linked an installation whose
  `account_login` is the owner, and where the caller has:
  - for a write that may create (`put`, `push`, `upload_initiate`): an
    org-level `writer` grant, or `reader` access to the collection already
    bound to the PR;
  - for anything else: an org-level grant, or `reader` access to the
    collection already bound to the PR.

  Scoped tokens only see orgs and collections their scopes cover.
- An explicit org (the CLI's global `--org <slug>` flag, sent as `org`)
  restricts the candidates to that org.
- Otherwise, when several orgs are candidates and one of them is the
  user's **default org**, that one wins. The default org only breaks ties:
  it never adds an org that isn't a candidate.
- One candidate: that org. None: `not_found`, "No org you can access has
  the GitHub App installed for <owner>." (when an `org` was given:
  "storage://<org>/ has no GitHub installation for <owner> that you can
  use."), hint "Install the app with: storage github install
  storage://<org>/". Several: `invalid_argument`, "gh-pr:<owner>/<repo>…
  matches several orgs: a, b.", hint "Set your default org with: storage
  set-default-org <org>, pass --org, or use a storage:// URI."

GitHub owner names and org slugs don't need to match, and a URI can only
land in an org that granted the app access to that GitHub account.

## Syntax

```
gh-pr:<owner>/<repo>#<number>[/<path>][@<version>]
gh-pr:<owner>/<repo>@<branch>[/<path>][@<version>]
```

- `owner`, `repo` and `number` as in binding targets; owner and repo are
  lowercased.
- `branch` runs to the next `/`. A branch containing `/` is written with
  `%2F` (`gh-pr:acme/web@feature%2Flogin/`); the segment is
  percent-decoded and must be 1-255 characters with no control characters.
- Everything after the `/` that follows the PR is the path and optional
  version, as in a storage URI. No `/` means the collection itself.

The parser is `parseShorthand` in `packages/core/src/bindings.ts`, returning
`{ owner, repo, pr: { number } | { branch }, rest }`, where `rest` is the
text after that `/` (empty for none). Malformed input is `invalid_argument`,
hint "Shorthand URIs look like gh-pr:acme/web#482/ or gh-pr:acme/web@main/."
`isShorthand(input)` is `input.startsWith("gh-pr:")`.

## Which operations take it

`OperationSpec.shorthand?: "resolve" | "create"` marks the operations whose
`uri` may be a `gh-pr:` URI:

- `create`: `put`, `push`, `upload_initiate`.
- `resolve`: `list`, `stat`, `history`, `get`, `pull`, `download_url`,
  `delete`, `restore`, `lifecycle`, `set-lifecycle`, `unbind`, `grants`,
  `share`, `unshare`, `link_create`, `link_list`.

Anything else (for example `create`, `bind`, `audit`) rejects a `gh-pr:`
URI with `parseUri`'s error, "The gh-pr: shorthand can't be used with this
operation."

## `resolve_shorthand` (internal operation)

Input `{ uri, operation, org? }`: `uri` a `gh-pr:` URI, `operation` the name
of the operation it's for, `org` an optional org slug. Output
`{ uri, collection, target, created }`: `uri` the resolved storage URI
(the collection URI plus `rest`), `collection` the collection URI,
`target` the binding target, `created` true when this call created the
collection.

- `operation` must exist and have `shorthand`, else `invalid_argument`. The
  token's `allowed_tools` must allow `operation` (`forbidden` as for a
  direct call); `toolAllowed` lets `resolve_shorthand` through and the
  handler checks the named operation. Share links can't call it.
- Needs the GitHub App configured, else `unavailable`, "The GitHub App
  isn't configured on this server."
- Picks the org as above. For the branch form it first needs an org-level
  grant (the bound collection isn't known yet), then asks GitHub through
  that org's installation for the open PR with that head branch
  (`GitHubApp.openPull`, below). None: `not_found`, "No open pull request
  in <owner>/<repo> has the head branch <branch>." A failure:
  `unavailable`, as in `bind`.
- A binding for the target in that org: returns its collection; `reader`
  on it is needed (otherwise the collection is `not_found` as usual). The
  operation itself then checks its own role when it runs.
- No binding and `shorthand: "resolve"`: `not_found`, "No collection in
  storage://<org>/ is bound to <target>.", hint "Write to it to create one,
  or bind one: storage bind storage://<org>/<collection>/ <target>".
- No binding and `shorthand: "create"`: creates and binds a collection:
  - Needs an org-level `writer` grant and a scope that allows `writer` on
    the new slug.
  - The slug is `<repo>-pr-<number>`: the repo lowercased, each run of
    characters other than `a-z0-9` replaced by one `-`, leading and
    trailing `-` trimmed, and cut so the slug fits 64 characters (then
    trimmed of a trailing `-` again). If nothing is left, `pr-<number>`.
  - Title `<owner>/<repo>#<number>`, lifecycle rules from the org's
    defaults, as `create` does.
  - Reads the PR through the org's installation first, with `bind`'s
    errors (a 404 or 403 is `not_found` "… isn't visible to the GitHub App
    in …").
  - Then one transaction inserts the collection and the binding and audits
    `binding.create` (`create` records no audit event, so neither does this).
  - If the slug is already taken (by any collection, deleted or not),
    `conflict`, "storage://<org>/<slug>/ already exists and isn't bound to
    <target>.", hint "Bind it with: storage bind storage://<org>/<slug>/
    <target>". A lost race on either unique index retries, and the retry
    finds the winner's binding.

Bind and create share helpers with `bindHandler` in
`packages/server/src/service/bindings.ts` (reading the PR, inserting the
binding), so the two can't drift.

## Where URIs are rewritten

- **Client**: `runOperation` (`packages/client/src/runners.ts`) resolves a
  `gh-pr:` `uri` through `resolve_shorthand` before running the local
  runner or forwarding the call, so local runners only see storage URIs.
  `RunnerContext.org` carries the CLI's `--org`.
- **Server**: `runHandler` does the same for every handler whose spec has
  `shorthand`, before the handler runs (no `org`), so the hosted MCP server
  and direct API calls accept the shorthand too. Inputs already rewritten
  by a client pass through unchanged.

Outputs always carry storage URIs.

## The default org: a user setting, not an environment variable

Choosing an org is the user's call, so it lives on the user's account,
where every client and surface (CLI, local and hosted MCP) sees it.
Environment variables are kept for what the server operator configures.

- Migration `0014_user_default_org`: `users.default_org`, a nullable org
  slug.
- `set-default-org [org] [--clear]` (public, all surfaces, in
  `TOOL_NAMES`): input `{ org?, clear? }`, output `{ default_org }`.
  Needs the unscoped token from `storage login` (else `forbidden`; scoped,
  child and service tokens and share links can't change it). `org` must be
  an org where the user has an org-level grant (else `not_found`, "Org
  <org> not found."). `clear` sets it to null. Both or neither is
  `invalid_argument`. Not audited: it's a preference and grants nothing.
- `whoami` returns `default_org` (null for services, links, and when
  unset).
- A default org whose grant was later removed simply stops matching: it's
  only ever compared against the candidates.

## `GitHubApp.openPull`

`openPull(installationId, owner, repo, branch): Promise<OpenPullResult>`,
`GET /repos/<owner>/<repo>/pulls?state=open&head=<owner>:<branch>&per_page=1`
as the installation. Returns `{ ok: true, number: number | null }` (null
when the list is empty) or `{ ok: false, status }`; network failures throw.
The fake takes a `branches` map, `owner/repo@branch` (owner and repo
lowercase) to a number or a failure.

## Audit

No new actions: `binding.create` as `bind` records it, with the caller as
the actor.

## Behaviors to test

`tests/gh-pr.test.ts`, with the fake `GitHubApp`. Unless a test says
otherwise, org `acme` linked installation `1001` for GitHub account `acme`,
the caller is an org-level writer in `acme`, and the fake reports
`acme/web#482` open.

1. `put` a file to `gh-pr:acme/web#482/shots/a.png` creates
   `storage://acme/web-pr-482/`, bound to `github:acme/web#482`, with the
   org's default rules; the object is at
   `storage://acme/web-pr-482/shots/a.png`; `audit` shows
   `binding.create`.
2. A second write reuses the collection (no new audit events); `list
   gh-pr:acme/web#482/` and `stat`/`get` on the object work, and outputs
   carry storage URIs.
3. A collection bound by hand (`bind storage://acme/screens/
   github:acme/web#482`) is where the shorthand lands.
4. `list` on an unbound PR: `not_found` with the bind hint; nothing is
   created.
5. Slug taken by an unbound collection: `conflict` with the bind hint.
6. Repo names are slugged: `Acme/My.Web_App#7` lands in `my-web-app-pr-7`;
   a 70-character repo is cut to fit 64.
7. No org has an installation for the owner: `not_found`. Two orgs with
   installations for `acme` where the caller is a writer: `invalid_argument`
   naming both; `--org` (CLI) or `org` (API) picks one; so does the user's
   default org, which an explicit org overrides. A default org that isn't a
   candidate changes nothing. `set-default-org` round-trips through
   `whoami`, refuses orgs without an org-level grant, and refuses scoped,
   service and link credentials.
8. A reader (org-level) can read through the shorthand but a write that
   would create is refused (`not_found`: no candidate); a reader of only the
   bound collection can read it.
9. A token whose `allowed_tools` is `["list"]` can resolve for `list` but
   not for `put`; a scoped token can't create outside its scope; a share
   link can't use the shorthand.
10. The fake answering 404 for the PR on create: `not_found`, no
    collection left behind.
11. The branch form: the fake maps `acme/web@feature/login` to 482;
    `gh-pr:acme/web@feature%2Flogin/x.txt` lands in `web-pr-482`. No open
    PR: `not_found`.
12. Operations without `shorthand` (`create gh-pr:…`, `bind`) reject it.
13. The hosted MCP `put` tool with a `gh-pr:` URI works (server-side
    rewrite).
14. `parseShorthand` unit tests in `packages/core/src/bindings.test.ts`:
    both forms, versions, `%2F`, case, and malformed inputs.
