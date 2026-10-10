import { ApiClient, loadClientConfig } from "@storage/client";
import { formatScope, type OperationInput, type OperationOutput, ops, parseScopeArg, TOOL_NAMES } from "@storage/core";
import { type Command, Option } from "commander";
import { type CliDeps, runReporting, writeLine } from "./output.js";
import { date, parseDays, table } from "./table.js";

type ToolName = (typeof TOOL_NAMES)[number];

function collectList(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function formatCreated(o: OperationOutput<typeof ops.tokenCreate>): string {
  return [
    `Created token ${o.id} "${o.name}" for ${o.principal} (expires ${o.expires_at ?? "never"}).`,
    `Scopes: ${o.scopes === null ? "(full access)" : o.scopes.map(formatScope).join(", ")}. Default delivery: ${o.default_delivery ?? "ref"}.`,
    ...(o.allowed_tools === null ? [] : [`Allowed tools: ${o.allowed_tools.join(", ")}.`]),
    "Copy it now; it won't be shown again:",
    o.token,
  ].join("\n");
}

function formatList(o: OperationOutput<typeof ops.tokenList>): string {
  if (o.tokens.length === 0) {
    return "No tokens.";
  }
  return table([
    ["ID", "NAME", "SCOPES", "TOOLS", "PARENT", "EXPIRES", "LAST USED"],
    ...o.tokens.map((t) => [
      t.current ? `${t.id} *` : t.id,
      t.name ?? "",
      t.scopes === null ? "(full access)" : t.scopes.map(formatScope).join(", "),
      t.allowed_tools === null ? "all" : t.allowed_tools.join(","),
      t.parent_id ?? "",
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
        "An unscoped token, such as the one from `storage login`, creates user tokens and service tokens. " +
        "Scoped and service tokens can create child tokens with narrower access.",
    );

  token
    .command("create")
    .summary("Create a token")
    .description(
      "Creates a token and prints its secret once. A scope is <org>/<collection-glob>:<role>, where the glob " +
        "allows * and ?. Quote it so your shell doesn't expand the glob. A scope can't give more access than your own " +
        "grants. With --service, creates a token for that service (an unscoped token and org admin access are needed). " +
        "When called with a scoped or service token, creates a child token that can't exceed the calling token.",
    )
    .addOption(new Option("--name <name>", "A label for the token, for example ci.").makeOptionMandatory())
    .addOption(
      new Option(
        "--scope <scope>",
        "Scope as '<org>/<collection-glob>:<role>', for example 'acme/pr-*:writer'. Repeatable. Quote the glob.",
      ).argParser(collectList),
    )
    .option("--service <org/name>", "Create a token for this service instead of yourself.")
    .addOption(
      new Option("--allowed-tool <name>", "Limit the token to this tool, for example get. Repeatable.")
        .choices(TOOL_NAMES)
        .argParser(collectList),
    )
    .addOption(
      new Option("--default-delivery <mode>", "How `get` returns content by default.").choices(["ref", "inline"]),
    )
    .option(
      "--expires-in-days <n>",
      "Days until the token expires. User tokens: 1 to 90, default 90. Service tokens: default never. A child token defaults to its parent's expiry.",
      parseDays,
    )
    .option("--json", "Print the result as JSON.")
    .action(
      async (options: {
        name: string;
        scope?: string[];
        service?: string;
        allowedTool?: string[];
        defaultDelivery?: "ref" | "inline";
        expiresInDays?: number;
        json?: boolean;
      }) => {
        const json = options.json === true;
        await runReporting(json, deps, setExitCode, async () => {
          const input: OperationInput<typeof ops.tokenCreate> = {
            name: options.name,
            ...(options.scope ? { scopes: options.scope.map(parseScopeArg) } : {}),
            ...(options.service === undefined ? {} : { service: options.service }),
            ...(options.allowedTool ? { allowed_tools: options.allowedTool as ToolName[] } : {}),
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
    .description(
      "Lists your tokens that haven't been revoked, or a service's with --service. A scoped or service token lists " +
        "itself and the tokens created from it. A * marks the token making this call.",
    )
    .option("--service <org/name>", "List this service's tokens (needs org admin access).")
    .option("--json", "Print the result as JSON.")
    .action(async (options: { service?: string; json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const output = await client().call(
          ops.tokenList,
          options.service === undefined ? {} : { service: options.service },
        );
        print(json, output, () => formatList(output));
      });
    });

  token
    .command("revoke")
    .summary("Revoke a token")
    .description(
      "Revokes a token by id, and every token created from it. It stops working on its next request. " +
        "A scoped or service token may revoke itself and the tokens created from it.",
    )
    .argument("<id>", "Token id, from `storage token list`.")
    .option("--json", "Print the result as JSON.")
    .action(async (id: string, options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const output = await client().call(ops.tokenRevoke, { id });
        print(
          json,
          output,
          () =>
            `Revoked token ${output.id}.` +
            (output.also_revoked.length > 0 ? ` Also revoked: ${output.also_revoked.join(", ")}.` : ""),
        );
      });
    });
}
