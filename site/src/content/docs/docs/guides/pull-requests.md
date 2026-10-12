---
title: Pull requests
description: Keep a pull request's files together and clean them up after it merges.
---

A collection can be bound to a GitHub pull request. Lifecycle rules can then
count from when it closes or merges, and agents can address its files by the
pull request itself.

## Address files by pull request

```sh
storage push ./artifacts gh-pr:acme/web#482/screenshots/   # creates and binds web-pr-482 on the first write
storage list gh-pr:acme/web#482/
storage list gh-pr:acme/web@feature%2Flogin/                # the open PR for a branch (%2F for /)
```

The first write creates the collection with the org's default lifecycle
rules and binds it. A `gh-pr:` URI lands in the org that linked GitHub for
that owner and that you can access. If several of your orgs did, pick one
with `storage set-default-org <org>`, or for one command with `--org <org>`.

## Bind a collection yourself

```sh
storage bind storage://acme/checkout/ github:acme/web#482
storage set-lifecycle storage://acme/checkout/ --rules '[
  { "prefix": "", "delete_after_event": { "event": "binding.merged", "after": "7d" } }
]'
storage lifecycle storage://acme/checkout/      # shows the binding and its state
storage unbind storage://acme/checkout/
```

`binding.closed` counts from when the pull request closes, merged or not, and
`binding.merged` from when it merges. A reopen cancels a pending deletion.

## Link your GitHub account or org

The server reads pull requests through a GitHub App that each org installs
on its own GitHub accounts, so an org only sees the repositories it gave the
app. An org admin links each installation:

```sh
storage github install storage://acme/
storage github list storage://acme/
storage github remove storage://acme/ <installation-id>
```

Installing on a GitHub org needs one of its owners. Server operators set the
app up once; see [Configuration](/docs/self-hosting/configuration/#github-app).
