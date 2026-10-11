# Spec: group principals

Status: done. Milestone 3, item 5 in the [roadmap](../roadmap.md).
Builds on [`github-connect.md`](github-connect.md).

Built as two parts on one branch. Part A ships `google-domain:` principals
and the plumbing that all group principals share. Part B adds `github-org:`
and `github-team:` principals and the membership cache.

## Why

Sharing one person at a time doesn't scale for a company. Design §8.2
lists three group principals: a Google Workspace domain, a GitHub org and a
GitHub team. A grant to one of these applies to every user who is a member
of the group, checked the way the design says, and never derived from an
email string.

## Shared concepts

- **Group:** `{ principal: string, name: string }`. `principal` is what
  grants store. `name` is for people to read (`acme.com`, `acme`,
  `acme/frontend`, or a GitHub login).
- **`Principal.groups: Group[]`** (`packages/server/src/auth.ts`) holds
  every principal the caller acts as besides itself: the connected
  `github-user:<id>` (name: login), `google-domain:<hd>`, `github-org:<id>`
  and `github-team:<id>`. `memberOf` stays `[id, ...groups.map(principal)]`,
  and every grant query keeps using `memberOf`. Services and links have no
  groups.
- **Token scopes still cap everything.** A group grant only adds to the
  principal's grants; `roleOnCollection` already takes the lower of grant
  and scope.
- **One resolver for memberships.** `createMembershipResolver(options)` in a
  new `packages/server/src/memberships.ts` returns
  `{ forUser(userId: string, now: Date): Promise<Group[]> }`. `authenticate`
  calls it for `user:` principals, and the share link creator check calls it
  for the link's creator (replacing `connectedGitHub` there), so links made
  through a group grant keep working.
- **`authenticate(auth: AuthDeps, authorization, now)`** where
  `AuthDeps = { db: Db; memberships: MembershipResolver }`. `createApp`
  builds one resolver and passes it to `/v1/ops` and `/mcp`.
- **whoami** output gains `groups: Group[]` (the caller's `Principal.groups`,
  empty for services and links).
- **Grant output** gains `name: string | null`: the domain for
  `google-domain:`, the org login or `org/team` for GitHub groups (from
  `github_principal_names`, or the lookup `share`/`unshare` just made), and
  null for users and services and for a GitHub group whose name is unknown.
  `github_login` is unchanged.
- **Principal input** (`principalInputSchema` in
  `packages/core/src/schemas.ts`) accepts, besides today's forms:
  - `google-domain:<domain>`: a hostname, case-insensitive, at least two
    labels, each label 1–63 of `[A-Za-z0-9-]` not starting or ending with a
    hyphen, at most 253 characters. Handlers lowercase it.
  - `github-org:<login>` or `github-org:<digits>` (GitHub login rule as for
    `github-user:`).
  - `github-team:<org login>/<team slug>` (slug: 1–100 of `[A-Za-z0-9_.-]`)
    or `github-team:<digits>`.
  - Update the error message and the description to list the new forms.
  - Like `github-user:`, `share` refuses the all-digit forms ("Share with a
    GitHub org login, for example github-org:acme" / "Share with a GitHub
    team, for example github-team:acme/frontend"); only `unshare` takes ids.
- **Audit**: `grant.create`, `grant.update` and `grant.delete` details add
  `name` for group principals.

## Part A: `google-domain:` principals

### Verification

The `hd` claim of the Google ID token, never the email (§8.2). Google sets
`hd` only for Workspace accounts, and it is the Workspace's primary domain,
so share with the primary domain.

- `ProviderIdentity` gains `hd: string | null`, lowercased. `googleProvider`
  already reads it.
- Migration `0010_group_principals` adds `identities.hd` (text, null).
  `resolveUser` writes it on insert and on every sign-in, so a domain change
  applies at the next sign-in. Existing rows stay null until then.
- The resolver adds `{ principal: "google-domain:<hd>", name: <hd> }` when
  the user's Google identity has a non-null `hd`.
- Domain membership is as fresh as the last Google sign-in; a token from
  that sign-in keeps it until the token ends. That's the same as every other
  grant today: offboarding means revoking the person's tokens. Write this in
  the README section on sign-in.

### Consumer domains

- A built-in list in `packages/server/src/principals.ts`
  (`DEFAULT_CONSUMER_DOMAINS`): `gmail.com`, `googlemail.com`,
  `outlook.com`, `hotmail.com`, `live.com`, `msn.com`, `yahoo.com`,
  `ymail.com`, `icloud.com`, `me.com`, `mac.com`, `aol.com`,
  `protonmail.com`, `proton.me`, `gmx.com`, `gmx.net`, `mail.com`,
  `zoho.com`, `yandex.com`, `qq.com`, `163.com`.
- `STORAGE_CONSUMER_DOMAINS` (comma-separated, lowercased, trimmed) adds to
  the list; it can't remove built-ins.
- `share … google-domain:<d>` with `<d>` on the list: `invalid_argument`
  "<d> is a consumer email domain and can't be shared with as a domain."
- The resolver also skips an `hd` on the list (defense in depth; Google
  never sets `hd` for these).

### share and unshare

- `share … google-domain:<d>` needs Google sign-in configured, else
  `invalid_argument` "Google sign-in isn't configured on this server." No
  lookup otherwise: the grant stores `google-domain:<d>` lowercased.
- `unshare … google-domain:<d>` works whatever the config.

### Config plumbing

- `ServerConfig` gains `consumerDomains: string[]` (extra domains only) and
  `githubMembershipTtlSeconds: number` (Part B; default 3600, from
  `STORAGE_GITHUB_MEMBERSHIP_TTL_SECONDS`). Both join `ServiceConfig`.
- `ServiceContext` gains `googleSignIn: boolean` (a Google provider is
  configured).
- `tests/harness.ts` sets defaults for both new config fields and accepts
  overrides through `HarnessOptions.config`.

## Part B: `github-org:` and `github-team:` principals

### The stored GitHub token

Private org and team membership is only visible with the member's own token
and the `read:org` scope, so connecting now keeps the token.

- The connect flow asks GitHub for `read:user read:org`.
- `GitHubConnector.exchange` returns `GitHubConnection`:
  `{ id, login, accessToken: string, scopes: string[] }`, with `scopes` from
  the token response's `scope` field (comma-separated).
- Migration `0010_group_principals` also adds to `connected_accounts`:
  `access_token` (text, null; sealed, below), `token_scopes` (text, null;
  comma-separated), `memberships` (text, null; JSON `Group[]`),
  `memberships_expires_at` (text, null) and `memberships_retry_at` (text,
  null). And a table `github_principal_names`: `principal` (primary key),
  `name` (not null), `updated_at`.
- **Sealing:** `packages/server/src/secret-box.ts` exports
  `class SecretBox { constructor(key: Buffer); seal(plaintext: string, aad: string): string; open(sealed: string, aad: string): string | null }`.
  AES-256-GCM, a random 12-byte IV, output `v1.<iv>.<ciphertext+tag>` in
  base64url. `open` returns null for anything malformed, tampered or sealed
  under another key or AAD. The AAD is `github:<subject>`, so a sealed token
  can't be moved to another account's row.
- The key: `Signer` gains `deriveKey(info: string): Buffer`
  (`hkdfSync("sha256", secret, "", info, 32)`), and `createApp` builds the
  box from `signer.deriveKey("storage connected account tokens v1")`.
  Rotating the signing secret makes stored tokens unreadable, which fails
  closed: users reconnect.
- **Connect callback** stores the sealed token and scopes on insert, and on
  a reconnect of the same GitHub id updates `login`, `access_token`,
  `token_scopes` and `updated_at`, and clears `memberships`,
  `memberships_expires_at` and `memberships_retry_at`. A token without
  `read:org` still connects (org access just stays off).
- **whoami** `connected[]` entries gain `org_access: boolean`: true when a
  token is stored and its scopes include `read:org`.

### Connector additions (`packages/server/src/signin/github.ts`)

```ts
export class GitHubTokenRevoked extends Error {}

interface GitHubConnector {
  authorizeUrl(...): string;            // scope "read:user read:org"
  exchange(...): Promise<GitHubConnection>;
  lookupUser(login): Promise<GitHubAccount | null>;          // unchanged
  /** GET /orgs/<login>, basic auth (client id:secret). Null on 404; throws on anything else. */
  lookupOrg(login: string): Promise<Group | null>;            // { principal: "github-org:<id>", name: <login> }
  /** GET /orgs/<org>/teams/<slug> with the user's token. Null on 403 or 404; GitHubTokenRevoked on 401; throws on anything else. */
  lookupTeam(accessToken: string, org: string, slug: string): Promise<Group | null>; // "github-team:<id>", "<org login>/<slug>"
  /**
   * GET /user/memberships/orgs?state=active&per_page=100 and GET /user/teams?per_page=100 with the user's token,
   * following Link rel="next" up to 10 pages each. Org entries with state other than "active" are skipped.
   * GitHubTokenRevoked on 401; throws on any other failure.
   */
  memberships(accessToken: string): Promise<Group[]>;
}
```

Names use GitHub's current login and slug. Unit tests for these live in
`packages/server/src/signin/github.test.ts` with a fake `fetch`.

### The membership resolver

`createMembershipResolver({ db, github: GitHubConnector | null, box: SecretBox, ttlSeconds })`.
`forUser(userId, now)`:

1. `google-domain:` from the Google identity (Part A).
2. The connected GitHub row, if any: add `github-user:<subject>` (name:
   login).
3. Org and team groups only when GitHub is configured, `access_token` opens
   and `token_scopes` include `read:org`. Then:
   - `memberships_expires_at > now`: use `memberships`.
   - Else `memberships_retry_at > now`: none (the cache expired and the last
     refresh failed less than 60 seconds ago).
   - Else refresh with `github.memberships(token)`:
     - Success: store `memberships`, `memberships_expires_at = now + ttl`,
       `memberships_retry_at = null`, and upsert each group's name into
       `github_principal_names`. Use them.
     - `GitHubTokenRevoked`: clear `access_token`, `token_scopes`,
       `memberships` and `memberships_expires_at`. None.
     - Any other failure: clear `memberships` and `memberships_expires_at`,
       set `memberships_retry_at = now + 60s`. None.
4. Concurrent refreshes for the same account share one in-flight promise
   (a `Map` inside the resolver).

This is §8.2's rule: access through a GitHub group is denied once the cached
membership expires and can't be re-checked. It never fails open.

### share and unshare

- `github-org:<login>`: needs GitHub configured (`ctx.connect`), else
  `invalid_argument` "GitHub isn't configured on this server."
  `lookupOrg`: null gives `invalid_argument` "No GitHub org <login>."; a
  throw gives `unavailable` "Couldn't reach GitHub to look up <login>."
- `github-team:<org>/<slug>`: needs GitHub configured, and the caller must
  be a user whose connected account has org access (the token opens and has
  `read:org`); otherwise `invalid_argument` "To share with a GitHub team,
  connect a GitHub account that can see it: storage connect github".
  `lookupTeam` with the caller's token: null gives `invalid_argument` "No
  GitHub team <org>/<slug>, or your connected GitHub account can't see it.";
  `GitHubTokenRevoked` or any other throw gives `unavailable` "Couldn't
  reach GitHub to look up <org>/<slug>." (and on revoked, clear the token
  like the resolver does).
- Lookups run before the transaction, like `github-user:`. Successful
  lookups upsert the name into `github_principal_names`.
- `unshare` takes the numeric forms without a lookup, and otherwise looks up
  the same way.

### CLI

`storage connect github` (`packages/cli/src/connect.ts`):

- Not connected: as today.
- Connected and `org_access` false: start anyway, first printing
  `Reconnecting GitHub account <login> to allow org and team access.` Poll
  until the entry has `org_access: true`, then print
  `Connected GitHub account <login>.` as today.
- Connected with `org_access` true: today's refusal.

### Docs

- README: the new principals, `STORAGE_CONSUMER_DOMAINS`,
  `STORAGE_GITHUB_MEMBERSHIP_TTL_SECONDS`, the `read:org` scope and that
  existing connections must reconnect, and that orgs restricting OAuth app
  access must approve the app or their members' memberships stay invisible
  (access denied, not granted).
- design §8.2: GitHub org and team are stored by numeric id.
- roadmap: mark item 5 done with an as-built summary.

## Tests

The lead hands these to `test-writer`.

**Part A (`tests/domains.test.ts`):**

1. A user who signs in with Google and `hd: "acme.com"` can `list` a
   collection shared with `google-domain:acme.com` (reader), and `whoami`
   shows `groups: [{ principal: "google-domain:acme.com", name: "acme.com" }]`.
2. A user with `hd: "other.com"`, or a Gmail user with no `hd`, gets
   `not_found` on that collection. A user whose email is `@acme.com` but
   whose identity has no `hd` gets `not_found` (never from the email).
3. `share … google-domain:ACME.com` stores `google-domain:acme.com` and
   returns `name: "acme.com"`; `grants` shows `name: "acme.com"`.
4. `share … google-domain:gmail.com` and a domain added through
   `consumerDomains` give `invalid_argument`.
5. Without a Google provider, `share … google-domain:acme.com` gives
   `invalid_argument`; `unshare` of an existing domain grant still works.
6. Signing in again with a different `hd` updates membership: access to the
   old domain's grants ends for tokens issued before and after.
7. A token scoped to another collection gets no access through a domain
   grant.
8. A user who is collection admin only through a domain grant can create a
   share link, and the link works; after the domain grant is removed, the
   link stops working (`unauthenticated`).
9. Services and share links have `groups: []` in `whoami`.
10. Schema: `google-domain:acme` (one label), `google-domain:-a.com` and
    `google-domain:a_b.com` give `invalid_argument`.

**Part B (`tests/github-groups.test.ts`), with `fakeGitHub` extended:**
`orgs` (login → id), `teams` (`org/slug` → id), per-account `memberships`
(GitHub id → `Group[]`), a `membershipsError` switch, a call counter,
`exchange` returning `accessToken: "gho_<code>"` and configurable scopes
(default `["read:org", "read:user"]`), and `lookupTeam` that answers only
for tokens whose account is in that org's memberships.

11. A connected user in org `acme` (id 100) can `list` a collection shared
    with `github-org:acme`; `whoami.groups` includes
    `{ principal: "github-org:100", name: "acme" }`, and
    `connected[0].org_access` is true.
12. Team grant: `share … github-team:acme/frontend` by a connected org
    member stores `github-team:<id>` with `name: "acme/frontend"`; a member
    of that team gets access, a member of `acme` outside the team doesn't.
13. `share … github-team:…` by a user with no connected account, or one
    without org access, gives `invalid_argument`; for a team the fake
    doesn't show to the caller, `invalid_argument`.
14. `share … github-org:nobody` gives `invalid_argument`; with lookups
    failing, `unavailable` and no grant.
15. Cache: two requests within the TTL make one membership call. After the
    TTL (advance the clock) a membership change in the fake applies.
16. Fail closed: after the TTL with `membershipsError` set, access through
    the org grant is `not_found`; within 60 seconds there's no second call;
    after 60 seconds it retries, and once the fake recovers, access returns.
17. Revoked token: the fake's memberships throw `GitHubTokenRevoked`; access
    ends, `org_access` becomes false, and no further membership calls are
    made.
18. A connection whose token lacks `read:org` has `org_access: false` and no
    org groups. Reconnecting the same GitHub id with `read:org` turns it on
    and the next request refreshes.
19. A stored token that doesn't open (overwrite `access_token` with junk in
    the database) gives no org groups and makes no membership call.
20. `unshare … github-org:100` and `github-team:<id>` remove grants without
    a lookup.
21. Share link created through a `github-org` grant works, and stops working
    once the creator's cached membership no longer lists the org.
22. Scoped tokens are still capped by scopes for GitHub group grants.
23. CLI (`tests/cli.test.ts`): `storage connect github` with a connection
    lacking org access prints the reconnect line, and finishes once the test
    reconnects with `read:org`.

**Unit tests:** `SecretBox` (round trip; wrong AAD, wrong key, tampered
and malformed input give null) and the connector methods (pagination via
`Link`, skipping non-active orgs, 401 to `GitHubTokenRevoked`, 404 to null,
`scope` parsing from the token response).

## Out of scope

- Per-org settings for which group principals are allowed.
- A webhook to drop memberships early when GitHub removes someone. The TTL
  bounds it.
- Re-checking `hd` without a sign-in.
- Purging `github_principal_names`.

## Verify

`pnpm lint`, `pnpm typecheck`, `pnpm test`, and the suite on Postgres
(`verifier`), since the migration changes SQL.

## As built

Where the code differs from this spec:

- The connector refuses to follow a `Link` next page outside
  `https://api.github.com/`, since that request carries the user's token.
- Writes from a membership refresh (and the token clearing after a 401)
  apply only while the stored token is still the one that was used, so a
  refresh that finishes after a reconnect can't undo it.
- `whoami`'s `org_access` falls back to "a token is stored with `read:org`"
  when GitHub isn't configured, since there's no key to open it then.

