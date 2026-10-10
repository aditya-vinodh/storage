import { ApiClient, loadClientConfig } from "@storage/client";
import { type OperationOutput, ops } from "@storage/core";
import type { Command } from "commander";
import { type CliDeps, runReporting, writeLine } from "./output.js";
import { date, table } from "./table.js";

function formatList(o: OperationOutput<typeof ops.serviceList>): string {
  if (o.services.length === 0) {
    return "No services.";
  }
  return table([["NAME", "PRINCIPAL", "CREATED"], ...o.services.map((s) => [s.name, s.principal, date(s.created_at)])]);
}

/** Adds `service create`, `service list` and `service delete`, which call the service operations with the active profile. */
export function addServiceCommands(program: Command, deps: CliDeps, setExitCode: (code: number) => void): void {
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

  const service = program
    .command("service")
    .summary("Create, list and delete services")
    .description(
      "Manages services: non-human principals (service:<org>/<name>) that can be granted access and given tokens. " +
        "Needs an unscoped token, such as the one from `storage login`, and org admin access to change them.",
    );

  service
    .command("create")
    .summary("Create a service")
    .description(
      "Creates a service in an org. Creating one that already exists succeeds and changes nothing. " +
        "Grant it access with `storage share`, and give it a token with `storage token create --service <org>/<name>`.",
    )
    .argument("<org>", "Org slug.")
    .argument("<name>", "Service name, for example bugbot.")
    .option("--json", "Print the result as JSON.")
    .action(async (org: string, name: string, options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const output = await client().call(ops.serviceCreate, { org, name });
        print(json, output, () =>
          output.created
            ? `Created service ${output.service.principal}.`
            : `Service ${output.service.principal} already exists.`,
        );
      });
    });

  service
    .command("list")
    .summary("List an org's services")
    .description("Lists the services in an org.")
    .argument("<org>", "Org slug.")
    .option("--json", "Print the result as JSON.")
    .action(async (org: string, options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const output = await client().call(ops.serviceList, { org });
        print(json, output, () => formatList(output));
      });
    });

  service
    .command("delete")
    .summary("Delete a service")
    .description("Deletes a service, revokes all its tokens and removes its grants in the org.")
    .argument("<org>", "Org slug.")
    .argument("<name>", "Service name.")
    .option("--json", "Print the result as JSON.")
    .action(async (org: string, name: string, options: { json?: boolean }) => {
      const json = options.json === true;
      await runReporting(json, deps, setExitCode, async () => {
        const output = await client().call(ops.serviceDelete, { org, name });
        print(
          json,
          output,
          () =>
            `Deleted service ${output.service.principal}: revoked ${output.revoked_tokens} tokens, removed ${output.removed_grants} grants.`,
        );
      });
    });
}
