---
title: Connect an agent
description: Use the local MCP server, the hosted MCP server, or the CLI from an agent.
---

Any agent that speaks MCP can use your files. Agents with a shell can also
run the CLI directly. Both have the same operations, arguments and output.

## Local MCP server

`storage mcp` runs an MCP server over stdio, with one tool per CLI command
and the CLI's sign-in. For Claude Code:

```sh
claude mcp add storage -- storage mcp
```

For other clients, configure a stdio server with the command `storage mcp`.

Tools return the same JSON as the CLI's `--json`. `get` downloads to a local
path by default. With `delivery: "inline"` it returns text and images (PNG,
JPEG, GIF, WebP) in the tool result, up to 1 MiB. Other types, and anything
larger, are downloaded to a path instead, with a `note` saying why.

## Hosted MCP server

The server also serves MCP over Streamable HTTP at `<server>/mcp`, for agents
that can't run the CLI. Clients sign in with OAuth in the browser:

```sh
claude mcp add --transport http storage https://storage.example.com/mcp
```

The client discovers the server's OAuth endpoints, registers itself and
opens a browser. The consent page shows the name the app gave itself and
where it will send you; check both. The app gets a one-hour access token that
only works at `/mcp`, refreshed for up to 90 days. It shows up in
`storage token list` as `MCP: <app name>`, and `storage token revoke` ends
it.

A pasted token works too:

```sh
claude mcp add --transport http storage https://storage.example.com/mcp \
  --header "Authorization: Bearer $STORAGE_TOKEN"
```

On the hosted server, `push` and `pull` aren't offered. `put` takes base64
`bytes`, and `get` returns a signed URL, or the content with
`delivery: "inline"`.

## Scoped tokens for agents

Give an agent only the access it needs:

```sh
storage token create --name ci --scope 'acme/pr-*:writer'
```

Use the token with `STORAGE_TOKEN`, `storage login --with-token`, or as the
bearer token for the hosted MCP server.
