# Spec: connecting a GitHub account

Status: done. Second of two PRs, after
[`google-only-sign-in.md`](google-only-sign-in.md).

## Why

After the first PR, Google is the only sign-in. GitHub becomes something a
signed-in user connects to their account, so that others can share with them
as a GitHub user. GitHub org and team principals come later and reuse the
connection (the group principals PR).

A connection is never matched by email: GitHub email verification is
one-time, which is the weakness the first PR removes.

## Concepts

- **Connected account:** a row in the new table `connected_accounts`. It
  links a Storage user to a GitHub account by GitHub's numeric user id, which
  survives renames. It is not a sign-in identity: you can't sign in with
  it, and `identities` stays Google-only.
- **`github-user:<id>` principal:** grants to a GitHub account, stored with
  the numeric id. People type `github-user:<login>`, and `share` resolves the
  login to the id when the grant is made. A user's `Principal.memberOf`
  includes `github-user:<id>` for their connected account, so grants to it
  apply. A grant can exist before the GitHub user has connected, the same
  way email grants work today.

## Config

- The GitHub variables `STORAGE_GITHUB_CLIENT_ID` and
  `STORAGE_GITHUB_CLIENT_SECRET` enable connecting accounts and
  `github-user:` principals. The GitHub OAuth App's callback URL becomes
  `<STORAGE_PUBLIC_URL>/connect/github/callback`.
- Google sign-in must also be configured, because the flow re-checks the
  user's Google account (see below). If GitHub is set without Google, the
  server fails at startup with
  `STORAGE_GITHUB_CLIENT_ID needs Google sign-in (STORAGE_GOOGLE_CLIENT_ID).`
- Without GitHub configured, connecting answers `unavailable`, and
  `share … github-user:` answers `invalid_argument` with "GitHub isn't
  configured on this server."

## Flow

The person in the browser must prove they are the Storage user, not just
hold a link. Otherwise Alice could send Bob a connect link, and Bob opening
it would attach Bob's GitHub account to Alice's user, giving Alice
everything shared with Bob on GitHub. So the browser signs in with Google as
the same user before going to GitHub.

1. **`storage connect github`** (CLI only) calls the internal operation
   `connect_start` with `{ provider: "github" }`.
   - It requires an unscoped top-level user token, the same rule as
     `token create`. Scoped tokens, children, services and links get
     `forbidden`: "Connect accounts with the token from storage login."
   - The server stores a ticket: 32 random bytes, kept hashed, bound to the
     user, single-use, valid 10 minutes.
   - It returns `{ url, expires_at }`, where the URL is
     `<public>/connect/github/start?ticket=<ticket>`.
   - The CLI prints the URL, then polls `whoami` every 3 seconds until
     `connected` lists a GitHub account (success: it prints
     `Connected GitHub account <login>.`) or the ticket expires (it exits
     with `unauthenticated`: "The connect link expired. Run `storage connect
     github` again.").
   - The CLI never opens or runs the URL.
2. **`GET /connect/github/start?ticket=…`**
   - Atomically mark the ticket used. An unknown, used or expired ticket
     gets a `400` page: "This connect link is invalid or has expired."
   - Create a connect state (`connect_states` row: state hash, browser
     nonce hash, user id, step `google`, PKCE verifier, expiry). Set the
     `HttpOnly` cookie `storage_connect` with path `/connect/`, `SameSite`
     `Lax`, and `Secure` when the public URL is HTTPS.
   - Redirect to Google with `prompt=select_account` and PKCE. The redirect
     URI is `<public>/connect/google/callback`, which must be added to the
     Google OAuth client.
3. **`GET /connect/google/callback`**
   - Validate the state, cookie, expiry and single use exactly like the
     sign-in callback, then exchange the code with the Google provider. The
     trust rule and the allowed domains apply.
   - The Google `sub` must belong to the ticket's user, through an
     `identities` row with `provider = 'google'` and this subject. Otherwise
     show a `403` page: "Sign in with the Google account you use for Storage
     (<user's email>)." The flow ends there.
   - A user with no Google identity, such as one made by `bootstrap` who
     never signed in, gets a `403` page: "Run `storage login` with Google
     first, then connect GitHub."
   - On success, advance the same state to step `github` with a new PKCE
     verifier and state value, and redirect to GitHub (scope `read:user`).
     The redirect URI is `<public>/connect/github/callback`.
4. **`GET /connect/github/callback`**
   - Validate the state as above, with step `github`.
   - Exchange the code with `githubProvider`'s token exchange. Read
     `GET /user` and keep `id` and `login`; email isn't used.
   - Insert into `connected_accounts`: user, `github`, the id as a string,
     and the login. Then:
     - **This GitHub id is connected to another user:** `409` page, "This
       GitHub account is already connected to another Storage account."
     - **This user already has a GitHub account connected:** `409` page,
       "Your Storage account is already connected to GitHub account
       <login>. Run `storage disconnect github` first." Reconnecting the
       same id just updates `login` and `updated_at`.
   - On success, audit `account.connect` (no org; detail: provider, id,
     login) and show "Connected GitHub account <login>. You can close this
     tab."

`storage disconnect github` calls the internal operation `disconnect` with
`{ provider: "github" }`. It needs the same unscoped token, deletes the row,
and audits `account.disconnect`. It is idempotent and returns
`{ provider, disconnected: boolean }`. Grants to `github-user:<id>` stay, and
apply again if the account reconnects.

Pages reuse `signin/pages.ts`, with the same headers and escaping.

## Data model

Migration `0009_connected_accounts`:

- **`connected_accounts`:** `id` (primary key, `newId("cac")`), `user_id`
  (references `users.id`, not null), `provider` (not null), `subject` (not
  null), `login` (not null), `created_at`, `updated_at`.
  - Unique on `(provider, subject)` and on `(user_id, provider)`.
- **`connect_tickets`:** `id`, `ticket_hash` (unique), `user_id`, `provider`,
  `created_at`, `expires_at`, `used_at`.
- **`connect_states`:** `id`, `state_hash` (unique), `browser_hash`,
  `user_id`, `provider` (the target, `github`), `step` (`google` | `github`),
  `code_verifier`, `created_at`, `expires_at`, `used_at`.
  - Advancing a step replaces `state_hash`, `code_verifier` and `step` with a
    conditional update on the old state hash, so each state value is
    single-use.

## Principals

- **`principalInputSchema`** (`packages/core/src/schemas.ts`) accepts
  `github-user:<login>`. Logins follow GitHub's rule: 1 to 39 characters,
  alphanumeric or single hyphens, not starting or ending with a hyphen.
  Update the error message and description to match.
- **`share`** with `github-user:<login>`:
  - Resolve the login with `GET https://api.github.com/users/<login>`,
    using HTTP basic auth with the client id and secret for the higher rate
    limit, and keep `id`.
  - A `404` from GitHub → `invalid_argument` "No GitHub user <login>."
  - Other failures → `unavailable` "Couldn't reach GitHub to look up
    <login>." The share fails closed.
  - Store the grant with principal `github-user:<id>`.
- **`unshare`** with `github-user:<login>` resolves the same way. It also
  accepts `github-user:<id>` (digits only), so a grant to a renamed or
  deleted account can still be removed. Allow digits in the input regex for
  that reason: logins can't be all digits in practice, but treat an
  all-digit value as an id.
- **Grant output** gains `github_login: string | null`, and `email` stays
  null for these grants:
  - `share` and `unshare` return the login they just looked up.
  - `grants` returns the login from `connected_accounts`, or null if the
    account isn't connected.
  - The share audit detail records the login as well as the id.
- **`authenticate`** (`packages/server/src/auth.ts`): for `user:` principals,
  `memberOf` adds `github-user:<subject>` when the user has a connected
  GitHub account. That's one extra indexed lookup per request. Services and
  links are unchanged. Token scopes still cap the result.
- **`whoami`** output gains `connected: [{ provider: "github", id, login }]`,
  empty when none. It's also empty for services and links.
- **Share link creator check:** `memberOf` already flows through grant
  queries, so nothing changes. Add a test (below) to prove it.

## Operations

- **`connect_start`:** internal. Input `{ provider: "github" }`, output
  `{ url, expires_at }`.
- **`disconnect`:** internal. Input `{ provider: "github" }`, output
  `{ provider, disconnected }`.
- **CLI commands** `storage connect github` and `storage disconnect github`
  are added by hand in a new `packages/cli/src/connect.ts`, like `token` in
  `token.ts`. Neither is exposed over MCP.

## Tests

The lead hands these to `test-writer` as written. Add fake GitHub and Google
providers to `tests/fake-idp.ts`, with a fake `GET /user` and a fake
`GET /users/<login>` behind the server's `fetch`.

**Connecting (`tests/connect.test.ts`):**

1. Happy path: a user signs in with Google `sub` A, runs `connect_start`,
   opens the URL, completes Google as `sub` A and then GitHub as id 42 /
   `octo`. `whoami.connected` is `[{ provider: "github", id: "42", login:
   "octo" }]`, and `account.connect` is audited.
2. Completing the Google step as a different `sub` gets a `403` page
   containing "Sign in with the Google account you use for Storage". No
   connected account is created.
3. A user created by `bootstrap` with no Google identity gets a `403` page
   containing "Run `storage login`".
4. Reusing a ticket, or opening it after 10 minutes (advance the clock), gets
   a `400` page.
5. A Google or GitHub callback without the `storage_connect` cookie, or
   replayed, gets a `400` page, and nothing is connected.
6. A GitHub account already connected to user X can't be connected by user
   Y: `409`, and X's connection is unchanged.
7. Connecting a second, different GitHub account to the same user gives
   `409`. Reconnecting the same id with a new login updates the login.
8. `connect_start` with a scoped token, a child token, a service token or a
   share link gives `forbidden`.
9. With GitHub not configured, `connect_start` gives `unavailable`.
10. `disconnect` removes the connection and audits it. A second call returns
    `disconnected: false`.

**Principals (`tests/connect.test.ts` or `tests/grants.test.ts`):**

11. `share storage://acme/c/ github-user:octo reader` stores principal
    `github-user:42` and returns `github_login: "octo"`. `grants` shows
    `github_login: null` until octo connects, then `"octo"`.
12. Before octo connects, the user has no access to `acme/c` (`not_found`).
    After connecting they can `list` it. After `disconnect` they lose it
    again.
13. `share … github-user:nobody` with the fake answering `404` gives
    `invalid_argument` "No GitHub user nobody". When the fake fails, the
    share gives `unavailable` and no grant is created.
14. `unshare … github-user:42` removes the grant.
15. A token scoped to another collection doesn't gain access through a
    `github-user` grant: scopes still cap it.
16. A user who is admin on a collection only through a `github-user` grant
    can create a share link on it.

**CLI (`tests/cli.test.ts`):**

17. `storage connect github` prints the URL. Once the connection is made
    (driven by the test), it prints `Connected GitHub account octo.` and
    exits 0. With `--json` it prints one JSON line.
18. `storage disconnect github` exits 0, and with `--json` prints
    `{"provider":"github","disconnected":true}`.

## Out of scope

- `github-org:` and `github-team:` principals and the membership cache.
  That's the group principals PR, which will need the `read:org` scope; users
  will reconnect then.
- Signing in with GitHub.
- A web page for managing connections. That waits for the viewer.

## Verify

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and Postgres (`verifier`).
- Manual: build, configure fake-looking Google and GitHub credentials, and
  check that `/connect/github/start` with a bad ticket gives `400` and that
  `storage connect github` prints a URL. A real round trip needs real OAuth
  apps.

## As built

Where the code differs from this spec:

- A user with no Google identity gets the `403` at `/connect/github/start`,
  right after the ticket is spent, instead of after the Google step.
- The share link creator check did need a change: it matched `created_by`
  only, so a link made through a `github-user:` grant broke on first use.
  It now also matches the creator's connected `github-user:` principal.
- `share` refuses an all-digit `github-user:` value ("Share with a GitHub
  login"); only `unshare` takes the numeric id.
- `storage connect github` times the 10 minutes on the local clock, so
  clock skew can't end the wait early. It refuses to start when a GitHub
  account is already connected, and points at `storage disconnect github`.
- A cancelled or failed Google step also spends the connect state.
- Tests use a fake `GitHubConnector` (`tests/fake-idp.ts`) instead of fake
  GitHub HTTP endpoints behind the server's `fetch`. The real connector's
  HTTP calls are unit-tested in `packages/server/src/signin/github.test.ts`.
