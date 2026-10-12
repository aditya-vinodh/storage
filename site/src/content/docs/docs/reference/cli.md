---
title: CLI
description: Commands, output, profiles and environment variables.
---

Run `storage --help` for the full list, and `storage <command> --help` for
one command. The main commands:

| Command | Does |
|---|---|
| `create`, `collections` | Create a collection, list the ones you can read |
| `put`, `push` | Upload a file, or a directory (only changed files) |
| `get`, `pull` | Download a file, or everything under a prefix |
| `list`, `stat`, `history` | Browse objects and their versions |
| `delete`, `restore` | Delete, undelete, or make an older version current |
| `share`, `unshare`, `grants` | Manage access |
| `link create`, `link list`, `link revoke` | Share links |
| `lifecycle`, `set-lifecycle` | Cleanup rules |
| `bind`, `unbind`, `github` | Pull request bindings |
| `token`, `service` | Tokens and services |
| `setup` | Sign in and add the MCP server to your agents |
| `login`, `logout`, `whoami`, `config` | Sign-in and profiles |
| `audit` | An org's audit log |
| `mcp` | The local MCP server |

## Output

Every command takes `--json` and prints the same JSON the MCP tools return.
Errors use the envelope `{"error": {"code", "message", "hint"}}` and exit
with a non-zero code.

## Profiles and environment

`storage login` signs in through the browser ([Sign-in](/docs/self-hosting/sign-in/)), and
`storage login --with-token` reads a token from stdin instead (for CI and
scripts). Either way the CLI checks the token with the server and saves it to a
profile. `--server` picks the server (default
`STORAGE_SERVER`, then the profile's server, then the hosted service at
`https://api.storage.adityaone.com`),
and the global `--profile <name>` picks the profile. `storage logout` removes
the saved token, and `storage config` shows the active profile, server and
token source without printing the token.

Profiles live in `~/.config/storage/` (`$XDG_CONFIG_HOME/storage`,
`%APPDATA%\storage` on Windows, or `STORAGE_CONFIG_DIR`):

- `config.toml`: `default_profile` and `[profiles.<name>] server = "…"`.
  It holds no secrets.
- `credentials.toml`, mode `0600`: `[profiles.<name>] token = "…"`.

Environment variables override the profile:

| Variable | Meaning |
|---|---|
| `STORAGE_SERVER` | Server URL. A saved token is only sent to its own profile's server, so pointing this elsewhere leaves you signed out. |
| `STORAGE_TOKEN` | Token. Takes precedence over the saved one. |
| `STORAGE_PROFILE` | Profile name, when `--profile` isn't given. |
| `STORAGE_CONFIG_DIR` | Directory holding `config.toml` and `credentials.toml`. |
| `STORAGE_HOME` | Download cache root, default `~/.storage`. |
