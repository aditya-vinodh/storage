# Spec: Google-only sign-in

Status: done. First of two PRs. The second is
[`github-connect.md`](github-connect.md).

## Why

Today a first sign-in through GitHub or Google links to any existing user
with the same email (`resolveUser` in `packages/server/src/signin/shared.ts`),
and a test asserts that GitHub and Google sign-ins with one email reach the
same user. Both browser flows sign in this way: the CLI device flow
(`signin/routes.ts`) and OAuth for the hosted MCP server (`signin/oauth.ts`).

GitHub verifies an address once and never again. Someone who once owned
`alice@acme.com`, for example the previous holder of a reassigned mailbox,
keeps it as a verified GitHub email. If the current Alice signs in with
Google, that person can sign in with GitHub and become her.

The fix is to give each provider one job:

- **Google is the only sign-in.** It's the only provider whose email is
  trusted, and the only one matched to users by email.
- **GitHub is connected after sign-in** to the account you're already signed
  in as, never matched by email. Its only job is to let people share with
  GitHub users, and later orgs and teams. That is the second PR.

## Trusted Google emails

A Google account's email is trusted only when Google is the authority for
that address:

- **Gmail:** the email ends in `@gmail.com` or `@googlemail.com`, and the ID
  token has no `hd` claim.
- **Google Workspace:** the ID token has an `hd` claim. The Workspace admin
  verified every domain the account's address can be on.

Any other Google account is refused. That means a consumer Google account
registered with a non-Gmail address such as `bob@acme.com`: Google verified
that address once, which is the same weakness as GitHub. This applies whether
or not `STORAGE_GOOGLE_ALLOWED_DOMAINS` is set. When it is set, the existing
`hd` allowlist check still applies on top, so Gmail accounts are refused.

`email_verified` must still be `true`, and every existing claim check (`iss`,
`aud`, `azp`, `exp`, `sub`) stays.

## Behavior

### Providers

- `providersFromConfig` (`signin/providers.ts`) returns Google only. Both
  flows read that one list through `signInEnv` (`signin/shared.ts`), so this
  covers the device flow and MCP OAuth. `STORAGE_GITHUB_CLIENT_ID` and
  `STORAGE_GITHUB_CLIENT_SECRET` no longer enable sign-in. They still parse,
  and the second PR uses them for connecting accounts.
- `/device` and the MCP OAuth consent page (`/oauth/authorize`) show only
  "Continue with Google".
- `GET /device/start?provider=github` and
  `GET /oauth/authorize/start?…&provider=github` answer `400` with the
  existing "provider isn't available" page.
- `GET /auth/github/callback` answers `404` with the existing "No such
  sign-in provider." page.
- Rename the `IdentityProvider` interface to `SignInProvider`. Keep
  `githubProvider` in `providers.ts`, since the second PR reuses its token
  exchange, but nothing registers it for sign-in.

### The trust rule

It lives in `googleProvider().exchange`, after the existing claim checks and
`email_verified`, and before the `allowedDomains` check:

- Extract it as an exported pure function
  `isTrustedGoogleEmail(email: string, hd: string | null): boolean` so it can
  be unit-tested. Compare case-insensitively.
- When it fails, throw `SignInError` with:
  `Sign in with a Gmail or Google Workspace account. <email> is a Google account on an address Google doesn't manage.`
- The callback already turns a `SignInError` into a `403` page and denies the
  device code, so the CLI reports "Sign-in was cancelled or refused in the
  browser."

### Linking to users (`resolveUser` in `signin/shared.ts`)

The Google `sub` is the identity:

1. If an identity with `provider = 'google'` and this `subject` exists, return
   its user. Update `identities.email` and `last_sign_in_at` as today;
   `users.email` never changes. This step is unchanged.
2. Otherwise find the user with this email. Then:
   - **No such user:** create one, then the identity, as today.
   - **A user with no `google` identity:** created by `share` or `bootstrap`,
     or one who only had a GitHub identity that the migration below removed.
     Link to that user, as today.
   - **A user who already has a `google` identity with a different
     subject:** refuse with `SignInError`:
     `<email> is already linked to a different Google account. Ask an admin of your Storage server for help.`

     This happens when a Workspace admin deletes and recreates an account, or
     a Google account is deleted and re-registered. Refusing is the safe
     default; there is no admin tooling for this yet (see Open questions).

`users.email` stays unique and lowercased.

### Migration `0008_google_only_sign_in`

`0007_mcp_oauth` dropped and recreated `sign_in_states`, so the database no
longer records which provider issued a given token. The migration therefore
works per user. Run these steps in order:

1. **Revoke the sign-in tokens of every user who has a `github` identity**,
   and every token created from them. A token that came from email matching
   may belong to the wrong person, so deleting the identity alone wouldn't
   stop it working.
   - **Sign-in tokens:** `device_authorizations.token_id` (CLI device flow)
     and `oauth_authorization_requests.token_id` (MCP OAuth), where the row's
     `user_id` has an `identities` row with `provider = 'github'`. Tokens
     those users got through Google are revoked too. That over-revokes a
     little, and the cost is signing in again.
   - **Descendants:** found through `tokens.parent_id`. Walk them in a loop
     in the migration's TypeScript: select the children of the current set,
     add them, and repeat until nothing new turns up.
   - Set `revoked_at` to the migration time on each token where it's null.
     MCP OAuth refresh already fails for a revoked `tokens` row
     (`signin/oauth.ts`), so the refresh tokens need no change.
2. **Delete rows from `identities`** where `provider = 'github'`. They were
   created by email matching. The second PR connects GitHub accounts
   explicitly, in a separate table.
3. **Delete rows from `sign_in_states`** where `provider = 'github'`.

Users and grants are untouched. A user who signed in only with GitHub signs
in again with Google, and is linked by the "no `google` identity" rule above
if the email matches.

Use portable SQL. Never edit an applied migration.

### CLI and docs

- `storage login` help (`packages/cli/src/auth.ts`): "sign in with Google".
- README "Sign-in":
  - only Google is a sign-in provider, and the callback is unchanged;
  - state the trust rule;
  - say GitHub is for connecting accounts (second PR) and its callback moves
    there;
  - drop the GitHub sign-in bullet.
- Design doc §8.1 and §8.2, and the roadmap, are already updated with this
  spec.

## Tests

The lead hands these to `test-writer` as written.

**Unit tests, `packages/server/src/signin/providers.test.ts`:**

1. `isTrustedGoogleEmail`:
   - `("alice@gmail.com", null)` → true.
   - `("Alice@GoogleMail.com", null)` → true.
   - `("alice@acme.com", "acme.com")` → true.
   - `("alice@acme.co.uk", "acme.com")` → true, because a Workspace can hold
     several domains.
   - `("bob@acme.com", null)` → false.
   - `("alice@gmail.com", "acme.com")` → true, because `hd` means Workspace.
2. `googleProvider().exchange` with an ID token whose email is
   `bob@acme.com`, `email_verified: true` and no `hd` throws a `SignInError`
   whose message contains "Gmail or Google Workspace".
3. The same with `hd: "acme.com"` and `allowedDomains: null` returns the
   identity.

**End-to-end, `tests/signin.test.ts`** (with the fake provider; replace the
GitHub-based cases):

4. With GitHub and Google configured, `GET /device?user_code=…` and the MCP
   OAuth consent page both show a "Continue with Google" link and no
   "GitHub" text.
5. `GET /device/start?provider=github` → `400`. The MCP OAuth
   `/oauth/authorize/start` with `provider=github` → `400`.
   `GET /auth/github/callback?state=x&code=y` → `404`.
6. A Google sign-in for a new email creates a user with no orgs (adapt
   "creates a new user with no orgs for a new email").
7. A user granted access by `share` to `user:bob@gmail.com` before signing in
   gets that access after a Google sign-in as `bob@gmail.com` (adapt the
   existing test to Google).
8. The same Google `sub` signing in later with a different email stays the
   same user, and `users.email` is unchanged.
9. Given a user who signed in with Google `sub` A as `alice@gmail.com`, a
   Google sign-in with `sub` B and the same email gets a `403` page containing
   "already linked to a different Google account". The device code is denied
   (polling returns `access_denied`), and no identity row is added.
10. Delete "keeps the same user when the same email signs in through Google".
    Switch the other tests that sign in through GitHub, in
    `tests/signin.test.ts` and `tests/mcp-oauth.test.ts`, to Google unless
    GitHub is what they're testing.

**Migration:**

11. Run the migrator to `0007_mcp_oauth`. Insert:
    - user G1 with one `github` and one `google` identity, an approved
      device authorization whose `token_id` is T1, and an MCP authorization
      request whose `token_id` is T2;
    - token C whose `parent_id` is T1, and a grandchild D under C;
    - user G2 with only a `google` identity, and a device authorization
      whose `token_id` is U;
    - a `github` sign-in state.

    Then migrate to latest:
    - T1, T2, C and D have `revoked_at` set, and U doesn't.
    - G1 keeps only the `google` identity.
    - The `github` sign-in state is gone.

    The fixture rows must match the column lists in migrations `0001` to
    `0007`, because the test inserts them before `0008` runs.

    The Kysely `Migrator` supports `migrateTo`, but `migrateToLatest` in
    `packages/server/src/db/index.ts` doesn't expose it. Build a `Migrator`
    in the test with the same `migrationProvider`. On Postgres it needs the
    same `migrationTableSchema` handling as `migrateToLatest`.

## Out of scope

- Connecting GitHub accounts and `github-user:` principals (the second PR).
- Admin tooling to re-link a user to a new Google account.
- Generic OpenID Connect providers for self-hosters without Google.

## Verify

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and the suite on Postgres
  (`verifier`), since this PR has a migration.
- Manual smoke test: `pnpm build`, start the server with the Google variables
  pointing at nothing, and check that `/device` renders only Google and that
  `/device/start?provider=github` gives `400`. A real Google round trip needs
  real credentials and isn't required.

## Open questions

- **Recovering a user whose Google account was recreated.** Today such a
  user is refused, per rule 2 above. An instance admin will need a command
  to move the user to the new Google `sub`. This is tracked in the roadmap.
