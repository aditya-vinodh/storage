---
title: Connect an agent
description: Use the local MCP server, the hosted MCP server, or the CLI from an agent.
---

Any agent that speaks MCP can use your files. Agents with a shell can also
run the CLI directly. Both have the same operations, arguments and output.

The examples use the hosted service. For your own server, replace
`https://api.storage.adityaone.com` with its URL.

## Hosted MCP server

The server serves MCP over Streamable HTTP at `/mcp`. Nothing needs to be
installed, and clients sign in with OAuth in the browser:

| Agent | How |
|---|---|
| Claude Code | `claude mcp add --transport http storage https://api.storage.adityaone.com/mcp` |
| Codex | `codex mcp add storage --url https://api.storage.adityaone.com/mcp` |
| Cursor | [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=storage&config=eyJ1cmwiOiJodHRwczovL2FwaS5zdG9yYWdlLmFkaXR5YW9uZS5jb20vbWNwIn0%3D) |
| VS Code | [Add to VS Code](vscode:mcp/install?%7B%22name%22%3A%22storage%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fapi.storage.adityaone.com%2Fmcp%22%7D) |
| ChatGPT, Claude and any other app | Copy `https://api.storage.adityaone.com/mcp` and paste it into the agent (in ChatGPT and Claude, as a custom connector) |

The client discovers the server's OAuth endpoints, registers itself and
opens a browser. The consent page shows the name the app gave itself and
where it will send you; check both. The app gets a one-hour access token that
only works at `/mcp`, refreshed for up to 90 days. It shows up in
`storage token list` as `MCP: <app name>`, and `storage token revoke` ends
it.

A pasted token works too:

```sh
claude mcp add --transport http storage https://api.storage.adityaone.com/mcp \
  --header "Authorization: Bearer $STORAGE_TOKEN"
```

Over the hosted MCP server, `push` and `pull` aren't offered. `put` takes base64
`bytes`, and `get` returns a signed URL, or the content with
`delivery: "inline"`.

## Local MCP server

`storage mcp` runs an MCP server over stdio, with one tool per CLI command
and the CLI's sign-in. Use it for agents that run on your machine and should
read and write local files with `push`, `pull` and `get`. `storage setup`
adds it to Claude Code, Codex and Cursor for you. To add it by hand:

```sh
claude mcp add --scope user storage -- storage mcp
```

For other clients, configure a stdio server with the command `storage mcp`.

Tools return the same JSON as the CLI's `--json`. `get` downloads to a local
path by default. With `delivery: "inline"` it returns text and images (PNG,
JPEG, GIF, WebP) in the tool result, up to 1 MiB. Other types, and anything
larger, are downloaded to a path instead, with a `note` saying why.

## Scoped tokens for agents

Give an agent only the access it needs:

```sh
storage token create --name ci --scope 'acme/pr-*:writer'
```

Use the token with `STORAGE_TOKEN`, `storage login --with-token`, or as the
bearer token for the hosted MCP server.
