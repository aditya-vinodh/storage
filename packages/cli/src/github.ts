import { ApiClient, loadClientConfig } from "@storage/client";
import { type OperationOutput, ops, StorageError } from "@storage/core";
import type { Command } from "commander";
import { type CliDeps, runReporting, writeLine } from "./output.js";
import { date, table } from "./table.js";

const POLL_MS = 3000;
/** The server's ticket lifetime. Timed locally, so a skewed clock can't end the wait early or late. */
const TICKET_MS = 10 * 60 * 1000;

function formatList(o: OperationOutput<typeof ops.githubInstallationList>): string {
  if (o.installations.length === 0) {
    return `No GitHub App installations are linked to ${o.uri}.`;
  }
  return table([
    ["INSTALLATION", "ACCOUNT", "TYPE", "LINKED"],
    ...o.installations.map((i) => [i.installation_id, i.account_login, i.account_type, date(i.created_at)]),
  ]);
}

/** Adds `github install`, `github list` and `github remove`, which call the installation operations with the active profile. */
export function addGitHubCommands(program: Command, deps: CliDeps, setExitCode: (code: number) => void): void {
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
  const print = (json: boolean, output: unknown, human: () => string) => {
    writeLine(deps.stdout, json ? JSON.stringify(output) : human());
  };

  const github = program
    .command("github")
    .summary("Link GitHub App installations to an org")
    .description(
      "Manages the GitHub App installations linked to an org, which collections can be bound to pull requests " +
        "through. Needs the token from `storage login`, and org admin access to install or remove.",
    );

  github
    .command("install")
    .summary("Install the GitHub App and link it to an org")
    .description(
      "Prints a link to open in a browser where you're signed in to Google as the same user, then waits for you to " +
        "install the GitHub App on a GitHub account and approve it. The installation is then linked to the org. " +
        "The link is single-use and expires in 10 minutes. It is never opened for you.",
    )
    .argument("<org-uri>", "Org URI, for example storage://acme/.")
    .option("--json", "Print the result as JSON.")
    .action(async (uri: string, options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const api = client();
        const known = new Set(
          (await api.call(ops.githubInstallationList, { uri })).installations.map((i) => i.installation_id),
        );
        const deadline = now().getTime() + TICKET_MS;
        const start = await api.call(ops.githubInstallStart, { uri });
        const info = deps[json ? "stderr" : "stdout"];
        writeLine(info, "Open this link in a browser where you're signed in to Google, then install the GitHub App:");
        writeLine(info, start.url);
        for (;;) {
          await sleep(POLL_MS);
          const listed = await api.call(ops.githubInstallationList, { uri });
          const added = listed.installations.find((i) => !known.has(i.installation_id));
          if (added) {
            print(
              json,
              { uri: listed.uri, installation: added },
              () => `Linked ${added.account_login} to ${listed.uri}.`,
            );
            return;
          }
          if (now().getTime() >= deadline) {
            throw new StorageError("unauthenticated", "The install link expired. Run `storage github install` again.");
          }
        }
      });
    });

  github
    .command("list")
    .summary("List an org's linked GitHub App installations")
    .description("Lists the GitHub App installations linked to an org.")
    .argument("<org-uri>", "Org URI, for example storage://acme/.")
    .option("--json", "Print the result as JSON.")
    .action(async (uri: string, options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const output = await client().call(ops.githubInstallationList, { uri });
        print(json, output, () => formatList(output));
      });
    });

  github
    .command("remove")
    .summary("Unlink a GitHub App installation from an org")
    .description(
      "Unlinks an installation from an org. Bindings made through it keep their state but stop updating. " +
        "Find the id with `storage github list`.",
    )
    .argument("<org-uri>", "Org URI, for example storage://acme/.")
    .argument("<installation-id>", "The installation's id.")
    .option("--json", "Print the result as JSON.")
    .action(async (uri: string, installationId: string, options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const output = await client().call(ops.githubInstallationRemove, { uri, installation_id: installationId });
        print(json, output, () => `Unlinked ${output.removed.account_login} from ${output.uri}.`);
      });
    });
}
