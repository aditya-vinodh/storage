import { ApiClient, loadClientConfig } from "@storage/client";
import { type OperationOutput, ops, StorageError } from "@storage/core";
import type { Command } from "commander";
import { type CliDeps, runReporting, writeLine } from "./output.js";

const POLL_MS = 3000;
/** The server's ticket lifetime. Timed locally, so a skewed clock can't end the wait early or late. */
const TICKET_MS = 10 * 60 * 1000;

type Connected = OperationOutput<typeof ops.whoami>["connected"][number];

function checkProvider(provider: string): "github" {
  if (provider !== "github") {
    throw new StorageError("invalid_argument", "Only github can be connected.");
  }
  return provider;
}

/** Adds `connect github` and `disconnect github`, which call the connect operations with the active profile. */
export function addConnectCommands(program: Command, deps: CliDeps, setExitCode: (code: number) => void): void {
  const client = () => {
    const config = loadClientConfig(deps.env, { profile: program.opts<{ profile?: string }>().profile });
    return new ApiClient({
      server: config.server,
      token: config.token,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const github = (connected: Connected[]) => connected.find((c) => c.provider === "github");

  program
    .command("connect")
    .summary("Connect a GitHub account to your user")
    .description(
      "Connects a GitHub account to your Storage user, so others can share with you as github-user:<login>. " +
        "Prints a link to open in a browser where you're signed in to Google as the same user, then waits for you to " +
        "approve GitHub. The link is single-use and expires in 10 minutes. It is never opened for you. " +
        "Needs the token from `storage login`.",
    )
    .argument("<provider>", "The account to connect. Only github is supported.")
    .option("--json", "Print the result as JSON.")
    .action(async (provider: string, options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        checkProvider(provider);
        const api = client();
        const existing = github((await api.call(ops.whoami, {})).connected);
        if (existing) {
          throw new StorageError(
            "conflict",
            `Already connected to GitHub account ${existing.login}.`,
            "Run `storage disconnect github` first.",
          );
        }
        const deadline = now().getTime() + TICKET_MS;
        const start = await api.call(ops.connectStart, { provider: "github" });
        const info = deps[json ? "stderr" : "stdout"];
        writeLine(info, "Open this link in a browser where you're signed in to Google, then approve GitHub:");
        writeLine(info, start.url);
        for (;;) {
          await sleep(POLL_MS);
          const account = github((await api.call(ops.whoami, {})).connected);
          if (account) {
            writeLine(
              deps.stdout,
              json
                ? JSON.stringify({ provider: "github", id: account.id, login: account.login })
                : `Connected GitHub account ${account.login}.`,
            );
            return;
          }
          if (now().getTime() >= deadline) {
            throw new StorageError("unauthenticated", "The connect link expired. Run `storage connect github` again.");
          }
        }
      });
    });

  program
    .command("disconnect")
    .summary("Disconnect a GitHub account from your user")
    .description(
      "Disconnects your connected GitHub account. Grants to it stay and apply again if you reconnect. " +
        "Safe to repeat. Needs the token from `storage login`.",
    )
    .argument("<provider>", "The account to disconnect. Only github is supported.")
    .option("--json", "Print the result as JSON.")
    .action(async (provider: string, options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        checkProvider(provider);
        const output = await client().call(ops.disconnect, { provider: "github" });
        writeLine(
          deps.stdout,
          json
            ? JSON.stringify(output)
            : output.disconnected
              ? "Disconnected GitHub."
              : "No GitHub account was connected.",
        );
      });
    });
}
