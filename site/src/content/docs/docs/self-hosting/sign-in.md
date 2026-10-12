---
title: Sign-in
description: Google sign-in for the CLI and MCP clients.
---

`storage login` signs in through the browser with the OAuth device flow: it
prints a URL and a code, you open the URL on any device, check the code, and
sign in with Google. The CLI then receives a 90-day token. It works
in headless terminals and over SSH.

Google is the only sign-in provider. Enable it by registering an OAuth client
(Cloud console → Credentials → OAuth client ID, type "Web application") with
this callback URL (`STORAGE_PUBLIC_URL` must be the address browsers reach the
server at): `<STORAGE_PUBLIC_URL>/auth/google/callback`. The account's email
must be verified.

An account can sign in only if Google manages its address: a Gmail address
(`@gmail.com` or `@googlemail.com`), or a Google Workspace account. Other
Google accounts, such as a personal account registered with a non-Gmail
address, are refused. `STORAGE_GOOGLE_ALLOWED_DOMAINS` further limits sign-in
to those Workspace domains.

GitHub isn't a sign-in provider. The GitHub variables are for connecting
GitHub accounts after sign-in (see [Share files](/docs/guides/sharing/)).

The first sign-in links to an existing user with the same email, so grants
made with `storage share … user:alice@acme.com` before Alice signed in apply
once she does. Later sign-ins match the Google account, even if its email
changes. If a Google account is deleted and re-registered with the same
email, sign-in is refused until an admin helps. Signing in grants nothing by itself: a new user sees no orgs until
someone shares one with them. Without a provider, `storage login` fails and
points at `--with-token`.
