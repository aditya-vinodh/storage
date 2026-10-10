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
}

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
