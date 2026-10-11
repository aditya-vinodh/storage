import { createHmac, timingSafeEqual } from "node:crypto";
import { httpStatusFor, StorageError } from "@storage/core";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Db } from "../db/index.js";
import { applyPullRequest, unlinkInstallation } from "./bindings.js";
import { readPullRequest } from "./pulls.js";

/** GitHub's webhook endpoint for pull request events (docs/specs/bindings.md). */

const MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024;
const PULL_REQUEST_ACTIONS = new Set(["opened", "closed", "reopened", "edited", "synchronize"]);

/** Checks an `X-Hub-Signature-256` header (`sha256=<hex>`) against the body, in constant time. */
export function verifyWebhookSignature(secret: string, body: Uint8Array, header: string | undefined): boolean {
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header ?? "");
  if (!match?.[1]) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(match[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function malformed(): StorageError {
  return new StorageError("invalid_argument", "Webhook payload is malformed.");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Mounts POST /v1/github/webhook. It's authenticated by signature alone and never reads the Authorization header. */
export function addGitHubWebhookRoute(app: Hono, deps: { db: Db; secret: string; now: () => Date }): void {
  app.post(
    "/v1/github/webhook",
    bodyLimit({
      maxSize: MAX_WEBHOOK_BODY_BYTES,
      onError: () =>
        Response.json(new StorageError("too_large", "Request body is too large.").toEnvelope(), {
          status: httpStatusFor("too_large"),
        }),
    }),
    async (c) => {
      const body = new Uint8Array(await c.req.arrayBuffer());
      if (!verifyWebhookSignature(deps.secret, body, c.req.header("x-hub-signature-256"))) {
        throw new StorageError("unauthenticated", "Webhook signature is missing or wrong.");
      }

      const event = c.req.header("x-github-event");
      if (event === "ping") {
        return c.json({ ok: true });
      }
      if (event !== "pull_request" && event !== "installation") {
        return c.json({ ok: true, bindings: 0 });
      }

      let payload: Record<string, unknown> | null;
      try {
        payload = record(JSON.parse(new TextDecoder().decode(body)));
      } catch {
        throw malformed();
      }
      if (payload === null) {
        throw malformed();
      }
      const action = payload.action;
      if (typeof action !== "string") {
        throw malformed();
      }
      if (event === "installation") {
        const id = record(payload.installation)?.id;
        if (action === "deleted" && (typeof id === "number" || typeof id === "string")) {
          await unlinkInstallation(deps.db, String(id), deps.now());
        }
        return c.json({ ok: true, bindings: 0 });
      }
      if (!PULL_REQUEST_ACTIONS.has(action)) {
        return c.json({ ok: true, bindings: 0 });
      }

      const pullRequest = record(payload.pull_request);
      const owner = record(record(payload.repository)?.owner)?.login;
      const repo = record(payload.repository)?.name;
      const number = pullRequest?.number;
      const pull = readPullRequest(pullRequest);
      if (
        pull === null ||
        typeof owner !== "string" ||
        typeof repo !== "string" ||
        typeof number !== "number" ||
        !Number.isInteger(number)
      ) {
        throw malformed();
      }
      const installationId = record(payload.installation)?.id;
      if (typeof installationId !== "number" && typeof installationId !== "string") {
        return c.json({ ok: true, bindings: 0 });
      }
      const bindings = await applyPullRequest(
        deps.db,
        { installationId: String(installationId), owner, repo, number },
        pull,
        "webhook",
        deps.now(),
      );
      return c.json({ ok: true, bindings });
    },
  );
}
