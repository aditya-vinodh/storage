---
title: Run a server
description: Run the server with docker-compose or directly with Node.
---

One container holds the API, the hosted MCP server and the maintenance
worker. Metadata goes in Postgres or SQLite, and file contents in any
S3-compatible bucket or on the local filesystem.

## With docker-compose

This runs a server on your machine with Postgres and RustFS, signs you in with
Google, uses the CLI, and connects an agent over MCP.

**You need**: Docker, Node 22+ and pnpm, and a Google account (Gmail or
Google Workspace).

### 1. Create a Google OAuth client

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

### 2. Configure the server

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

### 3. Start the server

This starts it with Postgres and RustFS:

```sh
docker compose up --detach --build --wait
```

### 4. Create your org and its first admin

Use the email of the Google account you'll sign in with:

```sh
docker compose exec server node dist/main.js bootstrap --org acme --email you@gmail.com
```

It also prints a token, which you can ignore.

### 5. Build the CLI

```sh
pnpm install && pnpm build
alias storage="node $PWD/packages/cli/dist/main.js"
```

### 6. Sign in

`storage login --server http://localhost:8787` prints a URL and a code. Open the URL, check the code, and
sign in with Google:

```sh
storage login --server http://localhost:8787
storage whoami          # you, and acme (admin)
```

### 7. Store and read files

```sh
storage create storage://acme/demo/ --title "Demo"
storage put ./screenshot.png storage://acme/demo/screenshots/home.png --meta state=after
storage list storage://acme/demo/
storage get storage://acme/demo/screenshots/home.png        # prints a local path
storage push ./artifacts storage://acme/demo/               # a whole directory
storage pull storage://acme/demo/screenshots/ --to ./review
```

### 8. Connect an agent

For Claude Code, run the MCP server locally with your CLI sign-in:

```sh
claude mcp add storage -- node $PWD/packages/cli/dist/main.js mcp
```

Then ask the agent to save something to `storage://acme/demo/`, or to list
what's there. See [Connect an agent](/docs/guides/agents/) for other clients.

### 9. Share with someone

```sh
storage share storage://acme/demo/ user:teammate@example.com reader
storage link create storage://acme/demo/screenshots/ --expires 7d
```

To start over, `docker compose down --volumes` deletes all data.

The image alone is `docker build -t storage-server .`. It listens on 8787, keeps local state in
`/data` (mount a volume there, as docker-compose does), and is configured with the variables listed under
[Configuration](/docs/self-hosting/configuration/).

## Without Docker

With SQLite and the filesystem blob store:

```sh
pnpm build

# Create an org and an admin, and print a token (data goes to ./.storage-data).
node packages/server/dist/main.js bootstrap --org acme --email you@example.com

# Start the API on http://localhost:8787.
node packages/server/dist/main.js serve

# `serve` also runs the maintenance worker (purges old deletions and unused blobs).
# To run it separately, set STORAGE_WORKER=false on `serve` and start:
node packages/server/dist/main.js worker

# In another shell:
alias storage="node $PWD/packages/cli/dist/main.js"
echo storage_pat_... | storage login --server http://localhost:8787 --with-token   # token from bootstrap

storage create storage://acme/pr-482/ --title "PR 482"
storage put ./after.png storage://acme/pr-482/screenshots/after.png --meta state=after
storage list storage://acme/pr-482/
storage get storage://acme/pr-482/screenshots/after.png   # prints the local path

# Directories: push uploads only files whose content changed; pull mirrors a prefix.
storage push ./artifacts storage://acme/pr-482/ --delete-missing --dry-run
storage push ./artifacts storage://acme/pr-482/ --delete-missing
storage pull storage://acme/pr-482/screenshots/ --to ./review
```

Every command takes `--json` and prints the same JSON the MCP tools
return. Errors use the envelope `{"error": {"code", "message", "hint"}}` and
the exit codes in design doc §10.4.
