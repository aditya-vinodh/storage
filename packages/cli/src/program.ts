import { ApiClient, loadClientConfig, runOperation } from "@storage/client";
import { EXIT_CODES, type OperationSpec, PUBLIC_OPERATIONS } from "@storage/core";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { z } from "zod";
import { addAuthCommands } from "./auth.js";
import { formatHuman } from "./format.js";
import { addMcpCommand } from "./mcp.js";
import { type CliDeps, runReporting, writeLine } from "./output.js";
import { addTokenCommands } from "./token.js";

export type { CliDeps } from "./output.js";

interface JsonSchema {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: JsonSchema;
  additionalProperties?: JsonSchema | boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

export const VERSION = "0.0.0";

function kebab(name: string): string {
  return name.replace(/_/g, "-");
}

function collectList(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function collectKeyValue(value: string, previous: Record<string, string> | undefined): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq <= 0) {
    throw new InvalidArgumentError(`Expected key=value, got "${value}".`);
  }
  return { ...(previous ?? {}), [value.slice(0, eq)]: value.slice(eq + 1) };
}

function parseNumber(value: string): number {
  const number = Number(value);
  if (value.trim() === "" || Number.isNaN(number)) {
    throw new InvalidArgumentError(`Expected a number, got "${value}".`);
  }
  return number;
}

/** Maps one JSON Schema property to a commander option. */
function optionFor(name: string, schema: JsonSchema): Option {
  const flag = `--${kebab(name)}`;
  const description = schema.description ?? "";
  if (schema.type === "boolean") {
    return new Option(flag, description);
  }
  if (schema.type === "integer" || schema.type === "number") {
    return new Option(`${flag} <n>`, description).argParser(parseNumber);
  }
  if (schema.type === "array") {
    return new Option(`${flag} <value>`, `${description} Repeatable.`).argParser(collectList);
  }
  if (schema.type === "object") {
    return new Option(`${flag} <key=value>`, `${description} Repeatable.`).argParser(collectKeyValue);
  }
  const option = new Option(`${flag} <value>`, description);
  return schema.enum ? option.choices(schema.enum) : option;
}

/** Adds one generated command per public operation. */
function addOperationCommand(
  program: Command,
  spec: OperationSpec,
  deps: CliDeps,
  setExitCode: (code: number) => void,
): void {
  const schema = z.toJSONSchema(spec.input, { io: "input" }) as JsonSchema;
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const positional = spec.positional ?? [];

  const command = program.command(spec.name).summary(spec.summary).description(spec.description);
  for (const name of positional) {
    const description = properties[name]?.description ?? "";
    command.argument(required.has(name) ? `<${name}>` : `[${name}]`, description);
  }
  const flags = new Map<string, string>();
  for (const [name, property] of Object.entries(properties)) {
    if (positional.includes(name)) {
      continue;
    }
    const option = optionFor(name, property);
    if (required.has(name)) {
      option.makeOptionMandatory();
    }
    flags.set(option.attributeName(), name);
    command.addOption(option);
  }
  command.option("--json", "Print the result as JSON.");

  command.action(async (...args: unknown[]) => {
    const options = args[positional.length] as Record<string, unknown>;
    const input: Record<string, unknown> = {};
    positional.forEach((name, i) => {
      if (args[i] !== undefined) {
        input[name] = args[i];
      }
    });
    for (const [attribute, name] of flags) {
      if (options[attribute] !== undefined) {
        input[name] = options[attribute];
      }
    }
    const json = options.json === true;
    await runReporting(json, deps, setExitCode, async () => {
      const config = loadClientConfig(deps.env, { profile: program.opts<{ profile?: string }>().profile });
      const output = await runOperation(spec, input, {
        api: new ApiClient({
          server: config.server,
          token: config.token,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        }),
        home: config.home,
        cwd: deps.cwd,
        stdout: deps.stdout,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      if ((output as { delivery?: string }).delivery === "inline") {
        return;
      }
      writeLine(deps.stdout, json ? JSON.stringify(output) : formatHuman(spec.name, output));
    });
  });
}

export function buildProgram(deps: CliDeps, setExitCode: (code: number) => void): Command {
  const program = new Command("storage")
    .description("Agent-first artifact storage. Sign in with `storage login`, or set STORAGE_SERVER and STORAGE_TOKEN.")
    .version(VERSION)
    .option("--profile <name>", "Config profile to use. Defaults to STORAGE_PROFILE, then the default profile.")
    .exitOverride()
    .showHelpAfterError()
    .configureOutput({
      writeOut: (text) => deps.stdout.write(text),
      writeErr: (text) => deps.stderr.write(text),
    });
  for (const spec of PUBLIC_OPERATIONS) {
    addOperationCommand(program, spec, deps, setExitCode);
  }
  addAuthCommands(program, deps, setExitCode);
  addMcpCommand(program, deps, setExitCode);
  addTokenCommands(program, deps, setExitCode);
  const configure = (command: Command) => {
    command.exitOverride().configureOutput({
      writeOut: (text) => deps.stdout.write(text),
      writeErr: (text) => deps.stderr.write(text),
    });
    command.commands.forEach(configure);
  };
  program.commands.forEach(configure);
  return program;
}

/** Runs the CLI with `argv` (excluding the node and script paths) and returns the exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let exitCode: number = EXIT_CODES.success;
  const program = buildProgram(deps, (code) => {
    exitCode = code;
  });
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      const ok = error.code === "commander.helpDisplayed" || error.code === "commander.version" || error.exitCode === 0;
      return ok ? EXIT_CODES.success : EXIT_CODES.usage;
    }
    throw error;
  }
  return exitCode;
}
