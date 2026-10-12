---
title: Run a server
description: Run the server with docker-compose or directly with Node.
---

One container holds the API, the hosted MCP server and the maintenance
worker. Metadata goes in Postgres or SQLite, and file contents in any
S3-compatible bucket or on the local filesystem.

## With docker-compose

The [Quickstart](/docs/quickstart/) runs the server with docker-compose, Postgres and RustFS. The image alone is
`docker build -t storage-server .`. It listens on 8787, keeps local state in
the `/data` volume, and is configured with the variables listed under
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
echo storage_pat_... | storage login --with-token   # token from bootstrap

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
