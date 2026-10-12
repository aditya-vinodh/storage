---
title: Lifecycle rules
description: Delete files on a schedule or after a pull request merges, keep only recent versions, and restore.
---

A collection can clean up after itself. Its rules are a list, each with a
`prefix` (`""` for the whole collection) and one action:

```sh
storage set-lifecycle storage://acme/demo/ --rules '[
  { "prefix": "", "delete_after": "90d" },
  { "prefix": "videos/", "delete_after": "7d" },
  { "prefix": "", "keep_versions": 5 }
]'
storage lifecycle storage://acme/demo/
```

| Action | What it does |
|---|---|
| `delete_after` | Deletes objects under the prefix this long after the collection was created (`30d`, `12h`). |
| `delete_after_event` | Deletes them this long after the collection's pull request closes or merges: `{ "event": "binding.merged", "after": "7d" }`. See [Pull requests](/docs/guides/pull-requests/). |
| `keep_versions` | Keeps each object's newest versions and removes older ones for good. |

For an object, the matching rule with the longest prefix wins, so
`{ "prefix": "keep/", "delete_after": "3650d" }` protects `keep/` from a
30-day rule on the whole collection. `lifecycle` shows each rule's due time
and what it governs. An empty list removes the rules.

Org admins can set default rules on the org URI. New collections start with
a copy of them:

```sh
storage set-lifecycle storage://acme/ --rules '[{ "prefix": "", "delete_after": "30d" }]'
```

## Restore

Deleted objects, whether deleted by hand or by a rule, can be restored for a
grace period (7 days by default). After that they are purged.

```sh
storage restore storage://acme/demo/reports/q3.pdf
storage restore storage://acme/demo/screenshots/ --recursive
storage restore storage://acme/demo/reports/q3.pdf@2     # make version 2 current again
```
