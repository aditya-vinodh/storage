import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { ApiClient, loadClientConfig, saveLogin } from "@storage/client";
import { ops, StorageError } from "@storage/core";
import type { Command } from "commander";
import { checkServerUrl, deviceSignIn } from "./auth.js";
import { type CliDeps, type ExecFn, runReporting, writeLine } from "./output.js";

const MCP_NAME = "storage";

type AgentResult = "added" | "already set up" | "not found" | `failed: ${string}`;

const defaultExec: ExecFn = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ code: null, output: "" });
        return;
      }
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}`.trim() });
    });
  });

/** Finds an executable named `name` on PATH. */
function onPath(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** The command an agent runs to start the local MCP server: this CLI, plus `--profile` when it isn't the default. */
function mcpCommand(deps: CliDeps, profile: string | undefined): string[] {
  const self =
    deps.selfCommand ??
    (onPath(deps.env, "storage") !== undefined
      ? [onPath(deps.env, "storage") as string]
      : [process.execPath, process.argv[1] ?? "storage"]);
  return [...self, ...(profile ? ["--profile", profile] : []), "mcp"];
}

async function addToCliAgent(exec: ExecFn, agent: "claude" | "codex", command: string[]): Promise<AgentResult> {
  const existing = await exec(agent, ["mcp", "get", MCP_NAME]);
  if (existing.code === null) {
    return "not found";
  }
  if (existing.code === 0) {
    return "already set up";
  }
  const scope = agent === "claude" ? ["--scope", "user"] : [];
  const added = await exec(agent, ["mcp", "add", ...scope, MCP_NAME, "--", ...command]);
  if (added.code === 0) {
    return "added";
  }
  return `failed: ${added.output.split("\n")[0] || `exit code ${added.code}`}`;
}

/** Cursor reads `~/.cursor/mcp.json`. Adds the server there, leaving every other entry alone. */
function addToCursor(home: string, command: string[]): AgentResult {
  const dir = join(home, ".cursor");
  if (!existsSync(dir)) {
    return "not found";
  }
  const file = join(dir, "mcp.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8")) as typeof config;
    } catch {
      return `failed: ${file} isn't valid JSON`;
    }
  }
  if (config.mcpServers?.[MCP_NAME] !== undefined) {
    return "already set up";
  }
  config.mcpServers = { ...config.mcpServers, [MCP_NAME]: { command: command[0], args: command.slice(1) } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return "added";
}

/** Adds `setup`: sign in if needed, then register the local MCP server with the agents it finds. */
export function addSetupCommand(program: Command, deps: CliDeps, setExitCode: (code: number) => void): void {
  program
    .command("setup")
    .summary("Sign in and add the MCP server to your agents")
    .description(
      "Signs in (skipped when the profile's saved token still works), then registers `storage mcp` with " +
        "Claude Code, Codex and Cursor when they are installed. Agents that already have it are left alone. " +
        "Safe to run again.",
    )
    .option(
      "--server <url>",
      "Server URL. Defaults to STORAGE_SERVER, then the profile's server, then the hosted server.",
    )
    .option("--no-agents", "Only sign in; don't register the MCP server with any agent.")
    .action(async (options: { server?: string; agents: boolean }) => {
      await runReporting(false, deps, setExitCode, async () => {
        const profileFlag = program.opts<{ profile?: string }>().profile;
        const current = loadClientConfig(deps.env, { profile: profileFlag });
        const server = checkServerUrl(options.server ?? current.server);
        const fetchOption = deps.fetch ? { fetch: deps.fetch } : {};

        let me: { principal: string; orgs: { slug: string }[] } | undefined;
        if (current.token !== undefined && server === current.server) {
          try {
            me = await new ApiClient({ server, token: current.token, ...fetchOption }).call(ops.whoami, {});
          } catch (error) {
            if (!(error instanceof StorageError) || error.code !== "unauthenticated") {
              throw error;
            }
          }
        }
        if (me === undefined) {
          const token = await deviceSignIn(deps, server);
          me = await new ApiClient({ server, token, ...fetchOption }).call(ops.whoami, {});
          saveLogin(deps.env, { profile: current.profile, server, token });
        }
        writeLine(deps.stdout, `Signed in to ${server} as ${me.principal}.`);

        if (!options.agents) {
          return;
        }
        const exec = deps.exec ?? defaultExec;
        const command = mcpCommand(deps, profileFlag);
        const results: [string, AgentResult][] = [
          ["Claude Code", await addToCliAgent(exec, "claude", command)],
          ["Codex", await addToCliAgent(exec, "codex", command)],
          ["Cursor", addToCursor(deps.env.HOME ?? homedir(), command)],
        ];
        for (const [agent, result] of results) {
          writeLine(deps.stdout, `${agent}: ${result}`);
        }
        if (results.every(([, result]) => result === "not found")) {
          writeLine(
            deps.stdout,
            `No agents found. To add the MCP server yourself, have your agent run: ${command.join(" ")}`,
          );
        } else {
          writeLine(deps.stdout, "Restart your agent to pick up the storage tools.");
        }
      });
    });
}
