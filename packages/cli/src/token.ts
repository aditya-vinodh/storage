import { ApiClient, loadClientConfig } from "@storage/client";
import { formatScope, type OperationInput, type OperationOutput, ops, parseScopeArg } from "@storage/core";
import { type Command, InvalidArgumentError, Option } from "commander";
import { type CliDeps, runReporting, writeLine } from "./output.js";

function collectList(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function parseDays(value: string): number {
  const days = Number(value);
  if (value.trim() === "" || Number.isNaN(days)) {
    throw new InvalidArgumentError(`Expected a number, got "${value}".`);
  }
  return days;
}

function date(iso: string): string {
  return iso.slice(0, 10);
}

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function formatCreated(o: OperationOutput<typeof ops.tokenCreate>): string {
  return [
    `Created token ${o.id} "${o.name}" (expires ${o.expires_at}).`,
    `Scopes: ${o.scopes.map(formatScope).join(", ")}. Default delivery: ${o.default_delivery ?? "ref"}.`,
    "Copy it now; it won't be shown again:",
    o.token,
  ].join("\n");
}

function formatList(o: OperationOutput<typeof ops.tokenList>): string {
  if (o.tokens.length === 0) {
    return "No tokens.";
  }
  return table([
    ["ID", "NAME", "SCOPES", "EXPIRES", "LAST USED"],
    ...o.tokens.map((t) => [
      t.current ? `${t.id} *` : t.id,
      t.name ?? "",
      t.scopes === null ? "(full access)" : t.scopes.map(formatScope).join(", "),
      t.expired ? "expired" : t.expires_at === null ? "never" : date(t.expires_at),
      t.last_used_at === null ? "never" : date(t.last_used_at),
    ]),
  ]);
}

/** Adds `token create`, `token list` and `token revoke`, which call the token operations with the active profile. */
export function addTokenCommands(program: Command, deps: CliDeps, setExitCode: (code: number) => void): void {
  const client = () => {
    const config = loadClientConfig(deps.env, { profile: program.opts<{ profile?: string }>().profile });
    return new ApiClient({
      server: config.server,
      token: config.token,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  };
  const print = (json: boolean, output: unknown, human: () => string) => {
    writeLine(deps.stdout, json ? JSON.stringify(output) : human());
  };

  const token = program
    .command("token")
    .summary("Create, list and revoke access tokens")
    .description(
      "Manages access tokens. Scoped tokens limit what a CI job or agent can reach. " +
        "Creating and listing tokens needs an unscoped token, such as the one from `storage login`.",
    );

  token
    .command("create")
    .summary("Create a scoped token")
    .description(
      "Creates a token limited to the given scopes and prints its secret once. A scope is " +
        "<org>/<collection-glob>:<role>, where the glob allows * and ?. Quote it so your shell doesn't expand the glob. " +
        "A scope can't give more access than your own grants.",
    )
    .addOption(new Option("--name <name>", "A label for the token, for example ci.").makeOptionMandatory())
    .addOption(
      new Option(
        "--scope <scope>",
        "Scope as '<org>/<collection-glob>:<role>', for example 'acme/pr-*:writer'. Repeatable. Quote the glob.",
      )
        .argParser(collectList)
        .makeOptionMandatory(),
    )
    .addOption(
      new Option("--default-delivery <mode>", "How `get` returns content by default.").choices(["ref", "inline"]),
    )
    .option("--expires-in-days <n>", "Days until the token expires, 1 to 90. Defaults to 90.", parseDays)
    .option("--json", "Print the result as JSON.")
    .action(
      async (options: {
        name: string;
        scope: string[];
        defaultDelivery?: "ref" | "inline";
        expiresInDays?: number;
        json?: boolean;
      }) => {
        const json = options.json === true;
        await runReporting(json, deps, setExitCode, async () => {
          const input: OperationInput<typeof ops.tokenCreate> = {
            name: options.name,
            scopes: options.scope.map(parseScopeArg),
            ...(options.defaultDelivery ? { default_delivery: options.defaultDelivery } : {}),
            ...(options.expiresInDays === undefined ? {} : { expires_in_days: options.expiresInDays }),
          };
          const output = await client().call(ops.tokenCreate, input);
          print(json, output, () => formatCreated(output));
        });
      },
    );

  token
    .command("list")
    .summary("List your tokens")
    .description("Lists your tokens that haven't been revoked. A * marks the token making this call.")
    .option("--json", "Print the result as JSON.")
    .action(async (options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const output = await client().call(ops.tokenList, {});
        print(json, output, () => formatList(output));
      });
    });

  token
    .command("revoke")
    .summary("Revoke a token")
    .description("Revokes a token by id. It stops working on its next request. A token may revoke itself.")
    .argument("<id>", "Token id, from `storage token list`.")
    .option("--json", "Print the result as JSON.")
    .action(async (id: string, options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const output = await client().call(ops.tokenRevoke, { id });
        print(json, output, () => `Revoked token ${output.id}.`);
      });
    });
}
