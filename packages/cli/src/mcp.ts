import type { Readable } from "node:stream";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient, loadClientConfig, runOperation } from "@storage/client";
import { DEFAULT_INLINE_MAX_BYTES, type InlineContent, PUBLIC_OPERATIONS } from "@storage/core";
import { createMcpServer } from "@storage/mcp";
import type { Command } from "commander";
import type { CliDeps } from "./output.js";
import { runReporting } from "./output.js";

export interface LocalMcpOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetch?: typeof fetch;
  profile?: string;
  inlineMaxBytes?: number;
}

/** The local MCP server: public operations run through runOperation, as the CLI does. */
export function createLocalMcpServer(options: LocalMcpOptions): Server {
  return createMcpServer({
    name: "storage",
    version: "0.0.0",
    operations: PUBLIC_OPERATIONS,
    async run(spec, input) {
      // Loaded per call so a later `storage login` takes effect without a restart.
      const config = loadClientConfig(options.env, { profile: options.profile });
      const inline: InlineContent[] = [];
      const output = await runOperation(spec, input, {
        api: new ApiClient({
          server: config.server,
          token: config.token,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        }),
        home: config.home,
        cwd: options.cwd,
        inline: {
          maxBytes: options.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES,
          onContent: (content) => inline.push(content),
        },
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return { output, inline };
    },
  });
}

/**
 * The SDK's stdio transport doesn't watch for the end of input. Close the
 * server once the client hangs up and every request it sent has been
 * answered, so a client that writes its requests and closes stdin still gets
 * its responses.
 */
function closeWhenInputEnds(server: Server, transport: StdioServerTransport, stdin: Readable): void {
  let pending = 0;
  let ended = false;
  const closeIfDone = () => {
    if (ended && pending === 0) {
      void server.close();
    }
  };
  const receive = transport.onmessage;
  transport.onmessage = (message) => {
    if ("method" in message && "id" in message) {
      pending += 1;
    }
    receive?.(message);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    await send(message);
    if (!("method" in message) && "id" in message) {
      pending -= 1;
      closeIfDone();
    }
  };
  stdin.once("end", () => {
    ended = true;
    closeIfDone();
  });
}

/** Adds `mcp`, which serves the public operations as MCP tools over stdio. */
export function addMcpCommand(program: Command, deps: CliDeps, setExitCode: (code: number) => void): void {
  program
    .command("mcp")
    .summary("Run the local MCP server over stdio")
    .description(
      "Serves the public operations as MCP tools over stdio, using the active profile's credentials. " +
        "Nothing else is written to stdout while it runs.",
    )
    .action(async () => {
      await runReporting(false, deps, setExitCode, async () => {
        const profile = program.opts<{ profile?: string }>().profile;
        const server = createLocalMcpServer({
          env: deps.env,
          cwd: deps.cwd,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(profile ? { profile } : {}),
        });
        const stdin = deps.stdin ?? process.stdin;
        const transport = new StdioServerTransport(stdin, deps.stdout);
        const closed = new Promise<void>((resolve) => {
          server.onclose = resolve;
        });
        await server.connect(transport);
        closeWhenInputEnds(server, transport, stdin);
        await closed;
      });
    });
}
