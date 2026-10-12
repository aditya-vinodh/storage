---
title: Concepts
description: Orgs, collections, objects, versions, URIs and roles.
---

## Orgs and collections

An **org** holds **collections**. A collection is where files live: it has
its own access grants, lifecycle rules and, optionally, a binding to a GitHub
pull request. Create one before writing to it:

```sh
storage create storage://acme/demo/ --title "Demo"
```

## Objects and versions

A file in a collection is an **object**, addressed by its path. Every write
is a new **version**, so nothing is overwritten. `history` lists an object's
versions, and `restore <uri>@<n>` makes an older one current again by adding
a new version.

```sh
storage put ./report.pdf storage://acme/demo/reports/q3.pdf --meta quarter=q3
storage history storage://acme/demo/reports/q3.pdf
storage restore storage://acme/demo/reports/q3.pdf@1
```

Identical content is stored once per org, so re-uploading the same file is
cheap. Writes can be made safe to retry with idempotency keys, and
conditional with `if_match`.

## URIs

| URI | Points at |
|---|---|
| `storage://acme/` | The org `acme` |
| `storage://acme/demo/` | The collection `demo` |
| `storage://acme/demo/screenshots/` | Everything under a prefix |
| `storage://acme/demo/screenshots/home.png` | One object |
| `storage://acme/demo/screenshots/home.png@3` | Version 3 of that object |
| `gh-pr:acme/web#482/screenshots/` | The collection bound to a pull request (see [Pull requests](/docs/guides/pull-requests/)) |

## Roles

Grants give a principal one of three roles on an org or a collection:

- **reader**: list, stat, history and get.
- **writer**: everything a reader can do, plus put, push, delete and restore.
- **admin**: everything a writer can do, plus sharing, share links and
  lifecycle rules.

An org grant applies to every collection in the org.

## References instead of bytes

Reads return a reference by default: `get` downloads to a local path, and
over the hosted MCP server it returns a short-lived signed URL. An agent asks
for content inline only when it has no shell.
