import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { httpStatusFor, operationsFor, StorageError } from "@storage/core";
import { createMcpServer, operationsForScopes } from "@storage/mcp";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type AuthDeps, authenticate, LINK_OPERATIONS, requireAllowedTool } from "../auth.js";
import { checkLinkCall } from "../links.js";
import type { ServiceContext, ServiceDeps } from "../service/index.js";
import type { SignInOptions } from "../signin/shared.js";
import { runHosted } from "./runners.js";

function errorResponse(error: StorageError, headers?: Record<string, string>): Response {
  return Response.json(error.toEnvelope(), { status: httpStatusFor(error.code) as ContentfulStatusCode, headers });
}

function jsonRpcError(status: 400, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

/** Base64 inflates bytes by 4/3; the rest of the body is JSON-RPC framing. */
function maxBodyBytes(maxUploadBytes: number): number {
  return Math.ceil(maxUploadBytes / 3) * 4 + 64 * 1024;
}

/**
 * Serves the hosted MCP server at /mcp over Streamable HTTP. It is stateless:
 * each POST gets its own MCP server and transport, authenticated by bearer token.
 */
export function addMcpRoutes(
  app: Hono,
  options: ServiceDeps & { googleSignIn: boolean },
  auth: AuthDeps,
  onError: (error: unknown) => void,
  signIn?: SignInOptions,
): void {
  // Points OAuth clients at the protected resource metadata (RFC 9728) once sign-in is configured.
  const challenge =
    signIn && signIn.providers.length > 0
      ? `Bearer realm="storage", resource_metadata="${signIn.publicUrl}/.well-known/oauth-protected-resource"`
      : 'Bearer realm="storage"';
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
      principal = await authenticate(auth, c.req.header("authorization"), now());
    } catch (error) {
      if (error instanceof StorageError && error.code === "unauthenticated") {
        return errorResponse(error, { "www-authenticate": challenge });
      }
      throw error;
    }
    // Parse the body here rather than in the transport: the transport's own reader stops at 4 MiB, below
    // the base64 size of a full-size put, while bodyLimit above has already capped the body for us.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonRpcError(400, -32700, "Parse error: the body must be one JSON-RPC message.");
    }
    // One request, one message. A batch of inline gets would make a small request buffer up to 100 times
    // the inline cap, and MCP dropped batching in protocol version 2025-06-18.
    if (Array.isArray(body)) {
      return jsonRpcError(400, -32600, "Batch requests aren't supported; send one JSON-RPC message per request.");
    }
    const ctx: ServiceContext = {
      db: options.db,
      blobs: options.blobs,
      config: options.config,
      principal,
      connect: options.connect,
      githubApp: options.githubApp,
      publicUrl: options.publicUrl,
      googleSignIn: options.googleSignIn,
      now,
    };

    const server = createMcpServer({
      name: "storage",
      version: "0.0.0",
      surface: "hosted",
      operations,
      listOperations: async () =>
        operationsForScopes(operations, principal.token.scopes, principal.token.allowedTools).filter(
          (op) => principal.link === null || LINK_OPERATIONS.has(op.name),
        ),
      async run(spec, input) {
        try {
          await checkLinkCall(ctx.db, principal, now(), spec.name, input);
          requireAllowedTool(principal, spec.name);
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
      return await transport.handleRequest(c.req.raw, { parsedBody: body });
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
