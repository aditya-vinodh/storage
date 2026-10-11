import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { findOperation, httpStatusFor, StorageError } from "@storage/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type AuthDeps, authenticate, requireAllowedTool } from "../auth.js";
import { parseTransferToken } from "../blobs/fs.js";
import { servesTransfers } from "../blobs/store.js";
import type { GitHubApp } from "../github/app.js";
import { addGitHubInstallRoutes } from "../github/install.js";
import { addGitHubWebhookRoute } from "../github/webhook.js";
import { checkLinkCall } from "../links.js";
import { addMcpRoutes } from "../mcp/http.js";
import { createMembershipResolver } from "../memberships.js";
import { SecretBox } from "../secret-box.js";
import { type ConnectConfig, HANDLERS, type ServiceDeps } from "../service/index.js";
import { runHandler } from "../service/run.js";
import { addSignInRoutes } from "../signin/routes.js";
import type { SignInOptions } from "../signin/shared.js";
import type { Signer } from "../signing.js";

const MAX_OPERATION_BODY_BYTES = 1024 * 1024;

export interface AppOptions extends Omit<ServiceDeps, "connect" | "githubApp" | "publicUrl"> {
  /** The GitHub App client. Needed, with `config.githubApp`, for bindings and installs. */
  githubApp?: GitHubApp | null;
  signer: Signer;
  /** Called for unexpected errors. Defaults to console.error. */
  onError?: (error: unknown) => void;
  /** Browser sign-in. Without it, the sign-in routes report that sign-in isn't configured. */
  signIn?: SignInOptions;
}

function errorResponse(error: StorageError): Response {
  return Response.json(error.toEnvelope(), { status: httpStatusFor(error.code) as ContentfulStatusCode });
}

/** Connecting accounts works only with a GitHub connector and a Google sign-in provider to re-check the user. */
function connectConfig(signIn: SignInOptions | undefined, box: SecretBox): ConnectConfig {
  return signIn?.github && signIn.providers.some((provider) => provider.id === "google")
    ? { github: signIn.github, publicUrl: signIn.publicUrl, box }
    : null;
}

/** Builds the HTTP API. Every server-side operation is served at POST /v1/ops/<name>. */
export function createApp(options: AppOptions): Hono {
  const box = new SecretBox(options.signer.deriveKey("storage connected account tokens v1"));
  const connect = connectConfig(options.signIn, box);
  const githubApp = options.config.githubApp === null ? null : (options.githubApp ?? null);
  const publicUrl = options.signIn?.publicUrl ?? null;
  const now = options.now ?? (() => new Date());
  const auth: AuthDeps = {
    db: options.db,
    memberships: createMembershipResolver({
      db: options.db,
      consumerDomains: options.config.consumerDomains,
      github: options.signIn?.github ?? null,
      box,
      ttlSeconds: options.config.githubMembershipTtlSeconds,
    }),
  };
  const googleSignIn = options.signIn?.providers.some((provider) => provider.id === "google") ?? false;
  const onError = options.onError ?? ((error: unknown) => console.error(error));
  const app = new Hono();

  app.onError((error) => {
    if (error instanceof StorageError) {
      return errorResponse(error);
    }
    onError(error);
    return errorResponse(new StorageError("internal", "Internal server error."));
  });

  app.notFound(() => errorResponse(new StorageError("not_found", "No such endpoint.")));

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use(
    "/v1/ops/*",
    bodyLimit({
      maxSize: MAX_OPERATION_BODY_BYTES,
      onError: () => errorResponse(new StorageError("too_large", "Request body is too large.")),
    }),
  );

  app.post("/v1/ops/:name", async (c) => {
    const name = c.req.param("name");
    const spec = findOperation(name);
    const handler = HANDLERS.get(name);
    if (!spec) {
      throw new StorageError("not_found", `Unknown operation "${name}".`);
    }
    if (!handler) {
      throw new StorageError("invalid_argument", `"${name}" runs on the client and has no server endpoint.`);
    }

    const principal = await authenticate(auth, c.req.header("authorization"), now());
    if (principal.token.clientId !== null) {
      throw new StorageError("unauthenticated", "This token was issued to an MCP client and only works at /mcp.");
    }

    let body: unknown = {};
    const text = await c.req.text();
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        throw new StorageError("invalid_argument", "Request body is not valid JSON.");
      }
    }
    await checkLinkCall(options.db, principal, now(), name, body);
    requireAllowedTool(principal, name);
    const output = await runHandler(handler, spec.input, body, {
      db: options.db,
      blobs: options.blobs,
      config: options.config,
      principal,
      connect,
      githubApp,
      publicUrl,
      googleSignIn,
      now,
    });
    return c.json(output as object);
  });

  if (options.config.githubApp !== null && githubApp !== null) {
    addGitHubWebhookRoute(app, { db: options.db, secret: options.config.githubApp.webhookSecret, now });
    addGitHubInstallRoutes(app, options, githubApp, now, onError);
  }

  addMcpRoutes(app, { ...options, connect, githubApp, publicUrl, googleSignIn }, auth, onError, options.signIn);
  addSignInRoutes(app, options, now, onError, box);

  if (servesTransfers(options.blobs)) {
    const store = options.blobs;
    const invalidLink = () =>
      new StorageError("forbidden", "Transfer link is invalid or has expired.", "Request a new link.");

    app.put("/v1/blobs/:token", async (c) => {
      const token = parseTransferToken(options.signer.verify(c.req.param("token"), now()));
      if (token?.op !== "put") {
        throw invalidLink();
      }
      const body = c.req.raw.body;
      if (body === null) {
        throw new StorageError("invalid_argument", "Upload body is empty.");
      }
      await store.write(token.key, Readable.fromWeb(body as NodeReadableStream), {
        size: token.size,
        sha256: token.sha256,
      });
      return c.body(null, 204);
    });

    app.get("/v1/blobs/:token", async (c) => {
      const token = parseTransferToken(options.signer.verify(c.req.param("token"), now()));
      if (token?.op !== "get") {
        throw invalidLink();
      }
      const blob = await store.stat(token.key);
      if (blob === null) {
        throw new StorageError("not_found", "Blob not found.");
      }
      const stream = await store.read(token.key);
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 200,
        headers: {
          "content-type": token.content_type,
          "content-length": String(blob.size),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(token.filename)}`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
          "cache-control": "private, no-store",
        },
      });
    });
  }

  return app;
}
