import type { Readable } from "node:stream";
import { ApiClient, loadClientConfig, removeLogin, saveLogin } from "@storage/client";
import { ops, StorageError } from "@storage/core";
import type { Command } from "commander";
import { type CliDeps, runReporting, writeLine } from "./output.js";

/** Reads the first line of `stdin`, so a pasted token works as well as a pipe. */
async function readTokenLine(stdin: Readable): Promise<string> {
  let text = "";
  for await (const chunk of stdin) {
    text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    if (text.includes("\n")) {
      break;
    }
  }
  return (text.split(/\r?\n/)[0] ?? "").trim();
}

function checkServerUrl(server: string): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new StorageError(
      "invalid_argument",
      `Invalid server URL "${server}".`,
      "Use a URL like https://storage.example.com.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new StorageError("invalid_argument", `Invalid server URL "${server}".`, "Use an http or https URL.");
  }
  return server.replace(/\/+$/, "");
}

/** Adds `login`, `logout` and `config`, which manage the local profile rather than calling an operation. */
export function addAuthCommands(program: Command, deps: CliDeps, setExitCode: (code: number) => void): void {
  const profileOption = () => program.opts<{ profile?: string }>().profile;

  program
    .command("login")
    .summary("Sign in and save the token to a profile")
    .description(
      "Checks a Storage token against the server and saves it to the profile (the default profile unless " +
        "--profile is given). Pipe the token on stdin with --with-token so it stays out of your shell history. " +
        "Tokens are stored in credentials.toml with mode 0600. Browser sign-in isn't available yet.",
    )
    .option("--server <url>", "Server URL. Defaults to STORAGE_SERVER, then the profile's server.")
    .option("--with-token", "Read the token from stdin.")
    .option("--token <token>", "The token. Prefer --with-token, which keeps it out of shell history.")
    .option("--json", "Print the result as JSON.")
    .action(async (options: { server?: string; withToken?: boolean; token?: string; json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        if (options.withToken && options.token !== undefined) {
          throw new StorageError("invalid_argument", "Pass either --token or --with-token, not both.");
        }
        let token: string;
        if (options.token !== undefined) {
          token = options.token.trim();
        } else if (options.withToken) {
          if (!deps.stdin) {
            throw new StorageError("invalid_argument", "No stdin to read the token from.");
          }
          token = await readTokenLine(deps.stdin);
        } else {
          throw new StorageError(
            "invalid_argument",
            "Browser sign-in isn't available yet.",
            "Pipe a Storage token to `storage login --with-token`. An admin can create one with `storage-server bootstrap`.",
          );
        }
        if (token === "") {
          throw new StorageError("invalid_argument", "The token is empty.");
        }

        const current = loadClientConfig(deps.env, { profile: profileOption() });
        const server = checkServerUrl(options.server ?? current.server);
        const me = await new ApiClient({ server, token, ...(deps.fetch ? { fetch: deps.fetch } : {}) }).call(
          ops.whoami,
          {},
        );
        saveLogin(deps.env, { profile: current.profile, server, token });

        if (json) {
          writeLine(deps.stdout, JSON.stringify({ profile: current.profile, server, ...me }));
          return;
        }
        writeLine(deps.stdout, `Logged in to ${server} as ${me.principal} (profile ${current.profile}).`);
        const after = loadClientConfig(deps.env, { profile: current.profile });
        if (after.tokenSource === "STORAGE_TOKEN") {
          writeLine(deps.stderr, "note: STORAGE_TOKEN is set and takes precedence over the saved token.");
        } else if (after.server !== server) {
          writeLine(
            deps.stderr,
            `note: STORAGE_SERVER points at ${after.server}, so the saved token isn't used until it is unset.`,
          );
        }
      });
    });

  program
    .command("logout")
    .summary("Remove the profile's saved token")
    .description("Deletes the token saved for the profile. The profile's server setting is kept.")
    .option("--json", "Print the result as JSON.")
    .action(async (options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const { profile } = loadClientConfig(deps.env, { profile: profileOption() });
        const removed = removeLogin(deps.env, profile);
        if (json) {
          writeLine(deps.stdout, JSON.stringify({ profile, removed }));
          return;
        }
        writeLine(
          deps.stdout,
          removed ? `Logged out of profile ${profile}.` : `No token saved for profile ${profile}.`,
        );
      });
    });

  program
    .command("config")
    .summary("Show the active profile, server and where the token comes from")
    .description("Shows the settings the CLI would use and where each comes from. Never prints the token itself.")
    .option("--json", "Print the result as JSON.")
    .action(async (options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const config = loadClientConfig(deps.env, { profile: profileOption() });
        const view = {
          profile: config.profile,
          server: config.server,
          server_source: config.serverSource,
          token_source: config.tokenSource,
          config_file: config.configFile,
          credentials_file: config.credentialsFile,
          home: config.home,
        };
        if (json) {
          writeLine(deps.stdout, JSON.stringify(view));
          return;
        }
        const width = Math.max(...Object.keys(view).map((key) => key.length));
        writeLine(
          deps.stdout,
          Object.entries(view)
            .map(([key, value]) => `${key.padEnd(width)}  ${value}`)
            .join("\n"),
        );
      });
    });
}
