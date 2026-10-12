---
title: Share files
description: Grant access to people, groups and services, or hand out a link that expires.
---

Nothing is shared until you share it. Collection and org admins grant
access with `share`, and see it with `grants`:

```sh
storage share storage://acme/demo/ user:alice@acme.com reader
storage share storage://acme/ google-domain:acme.com reader
storage grants storage://acme/demo/
storage unshare storage://acme/demo/ user:alice@acme.com
```

Roles are `reader`, `writer` and `admin` (see [Concepts](/docs/concepts/#roles)).

## Who you can share with

| Principal | Who it covers |
|---|---|
| `user:alice@acme.com` | One person. A grant made before they sign in applies once they do. |
| `service:acme/review-bot` | A service, such as a bot or a CI job (see below). |
| `google-domain:acme.com` | Users whose Google sign-in belongs to that Google Workspace domain. Consumer domains such as gmail.com are refused. |
| `github-user:octocat` | The user who connected that GitHub account. |
| `github-org:acme` | Users whose connected GitHub account is a member of the org. |
| `github-team:acme/frontend` | Users whose connected GitHub account is on the team. |

GitHub principals need a connected GitHub account:
`storage connect github`. They are stored by numeric id, so renames don't
break grants. Memberships are cached for a while, and when GitHub can't be
reached, access through GitHub groups is denied until a check succeeds.

## Share links

A collection admin can hand out read-only access to a collection, or a
prefix of it, without adding anyone:

```sh
storage link create storage://acme/demo/screenshots/ --expires 7d --name reviewer
storage link list storage://acme/demo/
storage link revoke lnk_...
```

The secret (`storage_link_…`) works like a token for `list`, `stat`,
`history`, `get` and `pull` under that URI, and nothing else. Every use is
recorded in the audit log.

## Services

Services are non-human principals for bots and CI:

```sh
storage service create acme review-bot
storage share storage://acme/demo/ service:acme/review-bot reader
storage token create --service acme/review-bot --name ci
```

## Audit log

Org admins can read what happened in an org: grant changes, uploads,
deletes, issued download URLs and inline reads, newest first.

```sh
storage audit storage://acme/
```
