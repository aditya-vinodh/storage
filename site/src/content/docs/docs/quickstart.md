---
title: Quickstart
description: Connect an agent to the hosted service, or install the CLI, in one step.
---

The hosted service is at `https://api.storage.adityaone.com`. Sign in with a
Google account. The first time you sign in you get your own org, named after
your email (`jane` for `jane@gmail.com`), where you're an admin.

There are two ways in. Pick one, or use both.

## Connect an agent (nothing to install)

Agents connect to the hosted MCP server and sign you in through the browser
the first time they use it.

| Agent | How |
|---|---|
| Cursor | [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=storage&config=eyJ1cmwiOiJodHRwczovL2FwaS5zdG9yYWdlLmFkaXR5YW9uZS5jb20vbWNwIn0%3D) |
| VS Code | [Add to VS Code](vscode:mcp/install?%7B%22name%22%3A%22storage%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fapi.storage.adityaone.com%2Fmcp%22%7D) |
| Claude Code | `claude mcp add --transport http storage https://api.storage.adityaone.com/mcp` |
| Codex | `codex mcp add storage --url https://api.storage.adityaone.com/mcp` |
| ChatGPT, Claude and other apps | Add a custom connector with the URL `https://api.storage.adityaone.com/mcp` |

Then ask your agent to save something, for example "save these notes to my
storage" or "list my collections".

## Install the CLI

On macOS or Linux with Node 22 or newer:

```sh
curl -fsSL https://storage.adityaone.com/install.sh | sh
```

This installs the `storage` command to `~/.local/bin`, then runs
`storage setup`, which:

1. Signs you in. It prints a URL and a code; open the URL, check the code,
   and sign in with Google.
2. Adds the local MCP server (`storage mcp`) to Claude Code, Codex and Cursor
   if they're installed. Agents that already have it are left alone.

Run `storage setup` again any time, for example after installing a new
agent. `storage setup --no-agents` only signs in.

## Store and read files

Replace `jane` with your org, shown by `storage whoami`:

```sh
storage create storage://jane/demo/ --title "Demo"
storage put ./screenshot.png storage://jane/demo/screenshots/home.png --meta state=after
storage list storage://jane/demo/
storage get storage://jane/demo/screenshots/home.png        # prints a local path
storage push ./artifacts storage://jane/demo/               # a whole directory
storage pull storage://jane/demo/screenshots/ --to ./review
```

## Share with someone

```sh
storage share storage://jane/demo/ user:teammate@example.com reader
storage link create storage://jane/demo/screenshots/ --expires 7d
```

## Your own server

To run your own server instead, see [Run a server](/docs/self-hosting/run/).
Point the CLI at it with `storage setup --server https://storage.example.com`,
and agents at `https://storage.example.com/mcp`.
