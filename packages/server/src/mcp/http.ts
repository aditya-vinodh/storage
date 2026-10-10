import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { httpStatusFor, operationsFor, StorageError } from "@storage/core";
import { createMcpServer, operationsForScopes } from "@storage/mcp";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { authenticate } from "../auth.js";
import type { ServiceContext, ServiceDeps } from "../service/index.js";
import { runHosted } from "./runners.js";

function errorResponse(error: StorageError, headers?: Record<string, string>): Response {
  return Response.json(error.toEnvelope(), { status: httpStatusFor(error.code) as ContentfulStatusCode, headers });
}

/** Base64 inflates bytes by 4/3; the rest of the body is JSON-RPC framing. */
function maxBodyBytes(maxUploadBytes: number): number {
  return Math.ceil(maxUploadBytes / 3) * 4 + 64 * 1024;
}

/**
 * Serves the hosted MCP server at /mcp over Streamable HTTP. It is stateless:
 * each POST gets its own MCP server and transport, authenticated by bearer token.
 */
export function addMcpRoutes(app: Hono, options: ServiceDeps, onError: (error: unknown) => void): void {
  const now = options.now ?? (() => new Date());
  const operations = operationsFor("hosted");

  app.use(
    "/mcp",
    bodyLimit({
      maxSize: maxBodyBytes(options.config.mcpMaxUploadBytes),
      onError: () => errorResponse(new StorageError("too_large", "Request body is too large.")),
    }),
  );

  app.post("/mcp", async (c) => {
    let principal: ServiceContext["principal"];
    try {
      principal = await authenticate(options.db, c.req.header("authorization"), now());
    } catch (error) {
      if (error instanceof StorageError && error.code === "unauthenticated") {
        return errorResponse(error, { "www-authenticate": 'Bearer realm="storage"' });
      }
      throw error;
    }
    const ctx: ServiceContext = { db: options.db, blobs: options.blobs, config: options.config, principal, now };

    const server = createMcpServer({
      name: "storage",
      version: "0.0.0",
      surface: "hosted",
      operations,
      listOperations: async () => operationsForScopes(operations, principal.token.scopes),
      async run(spec, input) {
        try {
          return await runHosted(spec, input, ctx);
        } catch (error) {
          if (error instanceof StorageError) {
            throw error;
          }
          // Remote callers get a generic error; the details go to the server log.
          onError(error);
          throw new StorageError("internal", "Internal server error.");
        }
      },
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  app.on(["GET", "DELETE"], "/mcp", () => {
    const error = new StorageError(
      "invalid_argument",
      "The MCP endpoint is stateless; send JSON-RPC requests with POST.",
    );
    return Response.json(error.toEnvelope(), { status: 405, headers: { allow: "POST" } });
  });
}
