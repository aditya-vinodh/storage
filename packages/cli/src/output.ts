import type { Readable, Writable } from "node:stream";
import { exitCodeFor, StorageError } from "@storage/core";

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  /** Read by `login --with-token`. */
  stdin?: Readable;
  fetch?: typeof fetch;
  /** Waits between sign-in polls. Defaults to a `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
  /** The local clock, for `connect github`'s deadline. Defaults to the system clock. */
  now?: () => Date;
  /** Runs another program, for `setup` to register the MCP server with agents. Defaults to `child_process`. */
  exec?: ExecFn;
  /** How agents should start this CLI, for `setup`. Defaults to `storage` on PATH, else this process. */
  selfCommand?: string[];
}

/** Runs `command` with `args`. Resolves `code: null` when the program isn't installed. */
export type ExecFn = (command: string, args: string[]) => Promise<{ code: number | null; output: string }>;

export function writeLine(stream: Writable, text: string): void {
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

/** Runs a command body, reporting any error in the requested format and setting the exit code. */
export async function runReporting(
  json: boolean,
  deps: CliDeps,
  setExitCode: (code: number) => void,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (error) {
    const storageError =
      error instanceof StorageError
        ? error
        : new StorageError("internal", error instanceof Error ? error.message : String(error));
    reportError(storageError, json, deps);
    setExitCode(exitCodeFor(storageError.code));
  }
}
