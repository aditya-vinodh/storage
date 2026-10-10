# Storage (working name)

Open-source, agent-first artifact storage. Coding agents upload screenshots,
recordings, test and eval reports, logs, and anything else into structured,
private-by-default collections. Owners share them with teammates, Google
Workspace domains, GitHub orgs, or review bots, and lifecycle rules (for
example "delete 7 days after the PR merges") clean them up automatically.

- CLI and MCP server with the same operations and output.
- Reads return a reference (local path or short-lived signed URL) by default.
  Content is returned inline only when an agent has no shell.
- Self-hosted first: one container, Postgres or SQLite, any S3-compatible
  bucket. A hosted service is built from the same code.

## Status

Design phase. There is no code yet. The design doc is at
[`docs/design.md`](docs/design.md).
