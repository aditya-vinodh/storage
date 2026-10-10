import type { Writable } from "node:stream";
import { ApiClient, loadClientConfig, runOperation } from "@storage/client";
import { EXIT_CODES, exitCodeFor, type OperationSpec, PUBLIC_OPERATIONS, StorageError } from "@storage/core";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { z } from "zod";
import { formatHuman } from "./format.js";

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  fetch?: typeof fetch;
}

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

function writeLine(stream: Writable, text: string): void {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

function reportError(error: StorageError, json: boolean, deps: CliDeps): void {
  if (json) {
    writeLine(deps.stderr, JSON.stringify(error.toEnvelope()));
    return;
  }
  writeLine(deps.stderr, `error: ${error.message}`);
  if (error.hint) {
    writeLine(deps.stderr, `hint: ${error.hint}`);
  }
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
    const config = loadClientConfig(deps.env);
    try {
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
    } catch (error) {
      const storageError =
        error instanceof StorageError
          ? error
          : new StorageError("internal", error instanceof Error ? error.message : String(error));
      reportError(storageError, json, deps);
      setExitCode(exitCodeFor(storageError.code));
    }
  });
}

export function buildProgram(deps: CliDeps, setExitCode: (code: number) => void): Command {
  const program = new Command("storage")
    .description("Agent-first artifact storage. Configure with STORAGE_SERVER and STORAGE_TOKEN.")
    .version(VERSION)
    .exitOverride()
    .showHelpAfterError()
    .configureOutput({
      writeOut: (text) => deps.stdout.write(text),
      writeErr: (text) => deps.stderr.write(text),
    });
  for (const spec of PUBLIC_OPERATIONS) {
    addOperationCommand(program, spec, deps, setExitCode);
  }
  for (const command of program.commands) {
    command.exitOverride().configureOutput({
      writeOut: (text) => deps.stdout.write(text),
      writeErr: (text) => deps.stderr.write(text),
    });
  }
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
