---
title: Quickstart
description: Run a server on your machine, sign in, store files, and connect an agent.
---

This sets up a server on your machine with docker-compose, signs you in with
Google, uses the CLI, and connects an agent over MCP.

:::note
There's no hosted server or published CLI package yet, so this guide builds
both from the repository. Once a hosted version is live, getting started will
be a single command.
:::

**You need**: Docker, Node 22+ and pnpm, and a Google account (Gmail or
Google Workspace).

## 1. Create a Google OAuth client

In the Google Cloud console, go to APIs & Services → Credentials → Create
credentials → OAuth client ID, type "Web application". Add these authorized
redirect URIs:

```
http://localhost:8787/auth/google/callback
http://localhost:8787/connect/google/callback
http://localhost:8787/github/install/google/callback
```

If the consent screen is in testing mode, add your Google account as a test
user.

## 2. Configure the server

Clone the repository, copy the example settings, and fill in the Google
client:

```sh
git clone https://github.com/aditya-vinodh/storage.git && cd storage
cp .env.example .env
# edit .env: STORAGE_GOOGLE_CLIENT_ID and STORAGE_GOOGLE_CLIENT_SECRET
```

Server settings are environment variables, set by whoever runs the server.
Everything a user chooses (their default org, tokens, shares, lifecycle
rules) is set through the CLI.

## 3. Start the server

This starts it with Postgres and RustFS:

```sh
docker compose up --detach --build --wait
```

## 4. Create your org and its first admin

Use the email of the Google account you'll sign in with:

```sh
docker compose exec server node dist/main.js bootstrap --org acme --email you@gmail.com
```

It also prints a token, which you can ignore.

## 5. Build the CLI

```sh
pnpm install && pnpm build
alias storage="node $PWD/packages/cli/dist/main.js"
```

## 6. Sign in

`storage login` prints a URL and a code. Open the URL, check the code, and
sign in with Google:

```sh
storage login
storage whoami          # you, and acme (admin)
```

## 7. Store and read files

```sh
storage create storage://acme/demo/ --title "Demo"
storage put ./screenshot.png storage://acme/demo/screenshots/home.png --meta state=after
storage list storage://acme/demo/
storage get storage://acme/demo/screenshots/home.png        # prints a local path
storage push ./artifacts storage://acme/demo/               # a whole directory
storage pull storage://acme/demo/screenshots/ --to ./review
```

## 8. Connect an agent

For Claude Code, run the MCP server locally with your CLI sign-in:

```sh
claude mcp add storage -- node $PWD/packages/cli/dist/main.js mcp
```

Then ask the agent to save something to `storage://acme/demo/`, or to list
what's there. See [Connect an agent](/docs/guides/agents/) for other clients
and the hosted MCP server.

## 9. Share with someone

```sh
storage share storage://acme/demo/ user:teammate@example.com reader
storage link create storage://acme/demo/screenshots/ --expires 7d
```

To start over, `docker compose down --volumes` deletes all data.
