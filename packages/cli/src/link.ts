import { ApiClient, loadClientConfig } from "@storage/client";
import { type OperationInput, type OperationOutput, ops } from "@storage/core";
import type { Command } from "commander";
import { type CliDeps, runReporting, writeLine } from "./output.js";
import { date, parseDays, table } from "./table.js";

/** Accepts days as `7` or `7d`. */
function parseExpires(value: string): number {
  return parseDays(value.trim().replace(/d$/i, ""));
}

function lastSegment(uri: string): string {
  return uri.replace(/\/+$/, "").split("/").pop() || "download";
}

function formatCreated(o: OperationOutput<typeof ops.linkCreate>, server: string): string {
  return [
    `Created share link ${o.link.id} for ${o.link.uri} (expires ${o.link.expires_at}).`,
    "It can list, stat and get objects under that URI, and nothing else.",
    "Copy the secret now; it won't be shown again:",
    o.secret,
    `Use it with: STORAGE_SERVER=${server} STORAGE_TOKEN=${o.secret} storage pull ${o.link.uri} --to ./${lastSegment(o.link.uri)}`,
  ].join("\n");
}

function formatList(o: OperationOutput<typeof ops.linkList>): string {
  if (o.links.length === 0) {
    return `No share links on ${o.uri}.`;
  }
  return table([
    ["ID", "URI", "NAME", "EXPIRES", "LAST USED"],
    ...o.links.map((l) => [
      l.id,
      l.uri,
      l.name ?? "",
      l.expired ? "expired" : date(l.expires_at),
      l.last_used_at === null ? "never" : date(l.last_used_at),
    ]),
  ]);
}

/** Adds `link create`, `link list` and `link revoke`, which call the share link operations with the active profile. */
export function addLinkCommands(program: Command, deps: CliDeps, setExitCode: (code: number) => void): void {
  const config = () => loadClientConfig(deps.env, { profile: program.opts<{ profile?: string }>().profile });
  const client = () => {
    const { server, token } = config();
    return new ApiClient({ server, token, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  };
  const print = (json: boolean, output: unknown, human: () => string) => {
    writeLine(deps.stdout, json ? JSON.stringify(output) : human());
  };

  const link = program
    .command("link")
    .summary("Create, list and revoke share links")
    .description(
      "Manages share links. A share link gives whoever holds its secret read-only, expiring access to a " +
        "collection or a prefix of it. Managing links needs admin access to the collection.",
    );

  link
    .command("create")
    .summary("Create a share link")
    .description(
      "Creates a read-only, expiring share link to a collection or a prefix of it and prints its secret once. " +
        "The secret can list, stat and get objects under that URI, and nothing else.",
    )
    .argument("<uri>", "Collection or prefix URI, for example storage://acme/pr-482/.")
    .option("--expires <days>", "Days until the link expires, for example 7 or 7d. Defaults to 7.", parseExpires)
    .option("--name <name>", "A label for the link, for example reviewer.")
    .option("--json", "Print the result as JSON.")
    .action(async (uri: string, options: { expires?: number; name?: string; json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const input: OperationInput<typeof ops.linkCreate> = {
          uri,
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.expires === undefined ? {} : { expires_in_days: options.expires }),
        };
        const { server } = config();
        const output = await client().call(ops.linkCreate, input);
        print(json, output, () => formatCreated(output, server));
      });
    });

  link
    .command("list")
    .summary("List a collection's share links")
    .description("Lists the share links on a collection that haven't been revoked, including expired ones.")
    .argument("<uri>", "Collection URI.")
    .option("--json", "Print the result as JSON.")
    .action(async (uri: string, options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const output = await client().call(ops.linkList, { uri });
        print(json, output, () => formatList(output));
      });
    });

  link
    .command("revoke")
    .summary("Revoke a share link")
    .description("Revokes a share link by id. It stops working on its next request.")
    .argument("<id>", "Link id, from `storage link list`.")
    .option("--json", "Print the result as JSON.")
    .action(async (id: string, options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const output = await client().call(ops.linkRevoke, { id });
        print(json, output, () => `Revoked share link ${output.id} for ${output.uri}.`);
      });
    });
}
