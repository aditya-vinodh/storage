import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { recordAuditAs } from "../audit.js";
import { DEFAULT_USER_TOKEN_TTL_DAYS, hashToken, insertToken } from "../auth.js";
import type { Db } from "../db/index.js";
import { newId } from "../ids.js";
import { isUniqueViolation, retryOnUniqueViolation } from "../service/grants.js";
import { escapeHtml, messagePage, page } from "./pages.js";
import { type IdentityProvider, type ProviderIdentity, SignInError } from "./providers.js";

export interface SignInOptions {
  /** Public base URL (no trailing slash): verification_uri and redirect URIs are built from it. */
  publicUrl: string;
  providers: IdentityProvider[];
}

export const DEVICE_CLIENT_ID = "storage-cli";
const DEVICE_CODE_TTL_SECONDS = 600;
const DEVICE_INTERVAL_SECONDS = 5;
const SIGN_IN_STATE_TTL_SECONDS = 600;
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const USER_CODE_ATTEMPTS = 5;
const COOKIE_NAME = "storage_signin";
const COOKIE_PATH = "/auth/";

const NOT_CONFIGURED = "Browser sign-in isn't configured on this server.";
const INVALID_LINK = "This sign-in link is invalid or has expired. Run `storage login` again.";
const INVALID_CODE = "That code isn't valid or has expired. Run `storage login` again.";

interface SignInDeps {
  db: Db;
  signIn?: SignInOptions;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function generateUserCode(): string {
  let code = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
}

function displayCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeCode(raw: string | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z]/g, "");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Reads a form body. Returns null if any value isn't a string. */
async function readForm(c: Context): Promise<Record<string, string> | null> {
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return {};
  }
  const form: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") {
      return null;
    }
    form[key] = value;
  }
  return form;
}

function oauthJson(c: Context, body: object, status: ContentfulStatusCode = 200): Response {
  return c.json(body, status, { "cache-control": "no-store" });
}

function oauthError(c: Context, error: string, description?: string, status: ContentfulStatusCode = 400): Response {
  return oauthJson(c, description === undefined ? { error } : { error, error_description: description }, status);
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Mounts browser sign-in and the OAuth device flow (design doc §8.1, §8.2). */
export function addSignInRoutes(
  app: Hono,
  options: SignInDeps,
  now: () => Date,
  onError: (error: unknown) => void,
): void {
  const { db } = options;
  const providers = options.signIn?.providers ?? [];
  const publicUrl = options.signIn?.publicUrl ?? "";
  const configured = providers.length > 0;
  const secure = publicUrl.startsWith("https://");

  const addSeconds = (at: Date, seconds: number) => new Date(at.getTime() + seconds * 1000);

  /** A pending, unexpired device authorization for a user code as typed. */
  const findPendingByUserCode = async (raw: string | undefined) => {
    const userCode = normalizeCode(raw);
    if (userCode === "") {
      return undefined;
    }
    const row = await db
      .selectFrom("device_authorizations")
      .selectAll()
      .where("user_code", "=", userCode)
      .where("status", "=", "pending")
      .executeTakeFirst();
    return row && new Date(row.expires_at).getTime() > now().getTime() ? row : undefined;
  };

  app.post("/oauth/device_authorization", async (c) => {
    const form = await readForm(c);
    if (form === null) {
      return oauthError(c, "invalid_request", "Form values must be strings.");
    }
    if (form.client_id !== DEVICE_CLIENT_ID) {
      return oauthError(c, "invalid_client", undefined, 401);
    }
    if (!configured) {
      return oauthError(c, "invalid_request", NOT_CONFIGURED);
    }
    const at = now();
    const deviceCode = `storage_dev_${token()}`;
    for (let attempt = 1; ; attempt++) {
      const userCode = generateUserCode();
      try {
        await db
          .insertInto("device_authorizations")
          .values({
            id: newId("dev"),
            device_code_hash: hashToken(deviceCode),
            user_code: userCode,
            client_id: DEVICE_CLIENT_ID,
            status: "pending",
            user_id: null,
            interval_seconds: DEVICE_INTERVAL_SECONDS,
            created_at: at.toISOString(),
            expires_at: addSeconds(at, DEVICE_CODE_TTL_SECONDS).toISOString(),
            last_polled_at: null,
            approved_at: null,
            token_id: null,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error) && attempt < USER_CODE_ATTEMPTS) {
          continue;
        }
        throw error;
      }
      return oauthJson(c, {
        device_code: deviceCode,
        user_code: displayCode(userCode),
        verification_uri: `${publicUrl}/device`,
        verification_uri_complete: `${publicUrl}/device?user_code=${displayCode(userCode)}`,
        expires_in: DEVICE_CODE_TTL_SECONDS,
        interval: DEVICE_INTERVAL_SECONDS,
      });
    }
  });

  app.post("/oauth/token", async (c) => {
    const form = await readForm(c);
    if (form === null) {
      return oauthError(c, "invalid_request", "Form values must be strings.");
    }
    if (form.grant_type !== DEVICE_GRANT_TYPE) {
      return oauthError(c, "unsupported_grant_type");
    }
    if (form.client_id !== DEVICE_CLIENT_ID) {
      return oauthError(c, "invalid_client", undefined, 401);
    }
    if (!form.device_code) {
      return oauthError(c, "invalid_request", "device_code is required.");
    }
    const row = await db
      .selectFrom("device_authorizations")
      .selectAll()
      .where("device_code_hash", "=", hashToken(form.device_code))
      .executeTakeFirst();
    if (!row || row.status === "consumed") {
      return oauthError(c, "invalid_grant");
    }
    const at = now();
    if (at.getTime() >= new Date(row.expires_at).getTime()) {
      return oauthError(c, "expired_token");
    }
    if (row.status === "denied") {
      return oauthError(c, "access_denied");
    }
    if (row.status === "pending") {
      const tooSoon =
        row.last_polled_at !== null &&
        at.getTime() - new Date(row.last_polled_at).getTime() < row.interval_seconds * 1000;
      await db
        .updateTable("device_authorizations")
        .set({
          last_polled_at: at.toISOString(),
          ...(tooSoon ? { interval_seconds: row.interval_seconds + 5 } : {}),
        })
        .where("id", "=", row.id)
        .execute();
      return oauthError(c, tooSoon ? "slow_down" : "authorization_pending");
    }

    const issued = await db.transaction().execute(async (trx) => {
      const claimed = await trx
        .updateTable("device_authorizations")
        .set({ status: "consumed" })
        .where("id", "=", row.id)
        .where("status", "=", "approved")
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) === 0 || row.user_id === null) {
        return null;
      }
      const expiresAt = addSeconds(at, DEFAULT_USER_TOKEN_TTL_DAYS * 86400);
      const created = await insertToken(trx, {
        principal: `user:${row.user_id}`,
        name: "storage login",
        expiresAt,
        now: at,
      });
      await trx.updateTable("device_authorizations").set({ token_id: created.id }).where("id", "=", row.id).execute();
      await recordAuditAs(trx, `user:${row.user_id}`, created.id, at, {
        orgId: null,
        action: "token.create",
        target: created.id,
        detail: { name: "storage login", via: "device" },
      });
      return { secret: created.secret, expiresIn: DEFAULT_USER_TOKEN_TTL_DAYS * 86400 };
    });
    if (issued === null) {
      return oauthError(c, "invalid_grant");
    }
    return oauthJson(c, { access_token: issued.secret, token_type: "Bearer", expires_in: issued.expiresIn });
  });

  app.get("/device", async (c) => {
    if (!configured) {
      return messagePage(c, "Sign-in unavailable", NOT_CONFIGURED, 400);
    }
    const raw = c.req.query("user_code");
    if (!raw) {
      return page(
        c,
        "Sign in to Storage",
        `<form method="get" action="/device">
<p><label>Enter the code from your terminal<br><input name="user_code" autocomplete="off" autofocus></label></p>
<p><button type="submit">Continue</button></p>
</form>`,
      );
    }
    const row = await findPendingByUserCode(raw);
    if (!row) {
      return messagePage(c, "Code not valid", INVALID_CODE, 400);
    }
    const links = providers
      .map(
        (provider) =>
          `<a class="button" href="${escapeHtml(`/device/start?user_code=${row.user_code}&provider=${provider.id}`)}">Continue with ${escapeHtml(provider.label)}</a>`,
      )
      .join("\n");
    return page(
      c,
      "Sign in to Storage",
      `<p>Your code:</p>
<p class="code">${escapeHtml(displayCode(row.user_code))}</p>
<p class="warning">Only continue if you just ran \`storage login\` and your terminal shows this code. Anyone who sends you this link can use it to get into your account.</p>
${links}`,
    );
  });

  app.get("/device/start", async (c) => {
    if (!configured) {
      return messagePage(c, "Sign-in unavailable", NOT_CONFIGURED, 400);
    }
    const provider = providers.find((candidate) => candidate.id === c.req.query("provider"));
    if (!provider) {
      return messagePage(c, "Sign-in unavailable", "That sign-in provider isn't available on this server.", 400);
    }
    const device = await findPendingByUserCode(c.req.query("user_code"));
    if (!device) {
      return messagePage(c, "Code not valid", INVALID_CODE, 400);
    }
    const at = now();
    const state = token();
    const verifier = token();
    const nonce = token();
    const expiresAt = Math.min(
      addSeconds(at, SIGN_IN_STATE_TTL_SECONDS).getTime(),
      new Date(device.expires_at).getTime(),
    );
    await db
      .insertInto("sign_in_states")
      .values({
        id: newId("sis"),
        state_hash: hashToken(state),
        browser_hash: hashToken(nonce),
        provider: provider.id,
        code_verifier: verifier,
        device_authorization_id: device.id,
        created_at: at.toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
        used_at: null,
      })
      .execute();
    setCookie(c, COOKIE_NAME, nonce, {
      path: COOKIE_PATH,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: SIGN_IN_STATE_TTL_SECONDS,
      secure,
    });
    return c.redirect(
      provider.authorizeUrl({
        state,
        redirectUri: `${publicUrl}/auth/${provider.id}/callback`,
        codeChallenge: codeChallenge(verifier),
      }),
      302,
    );
  });

  /** Finds or creates the user for a provider identity. Retried once by the caller on a unique violation. */
  const resolveUser = (identity: ProviderIdentity, at: Date): Promise<string> =>
    retryOnUniqueViolation(() =>
      db.transaction().execute(async (trx) => {
        const stamp = at.toISOString();
        const existing = await trx
          .selectFrom("identities")
          .select(["id", "user_id"])
          .where("provider", "=", identity.provider)
          .where("subject", "=", identity.subject)
          .executeTakeFirst();
        if (existing) {
          await trx
            .updateTable("identities")
            .set({ email: identity.email, last_sign_in_at: stamp })
            .where("id", "=", existing.id)
            .execute();
          return existing.user_id;
        }
        let userId: string;
        const byEmail = await trx
          .selectFrom("users")
          .select("id")
          .where("email", "=", identity.email)
          .executeTakeFirst();
        if (byEmail) {
          userId = byEmail.id;
        } else {
          userId = newId("usr");
          await trx
            .insertInto("users")
            .values({ id: userId, email: identity.email, name: identity.name, created_at: stamp })
            .execute();
        }
        await trx
          .insertInto("identities")
          .values({
            id: newId("idn"),
            user_id: userId,
            provider: identity.provider,
            subject: identity.subject,
            email: identity.email,
            created_at: stamp,
            last_sign_in_at: stamp,
          })
          .execute();
        return userId;
      }),
    );

  app.get("/auth/:provider/callback", async (c) => {
    const provider = providers.find((candidate) => candidate.id === c.req.param("provider"));
    if (!provider) {
      return messagePage(c, "Not found", "No such sign-in provider.", 404);
    }
    const invalid = () => messagePage(c, "Sign-in link not valid", INVALID_LINK, 400);
    const at = now();

    const state = c.req.query("state");
    const code = c.req.query("code");
    const providerError = c.req.query("error");
    const cookie = getCookie(c, COOKIE_NAME);
    if (!state || !cookie || (providerError === undefined && !code)) {
      return invalid();
    }
    const stored = await db
      .selectFrom("sign_in_states")
      .selectAll()
      .where("state_hash", "=", hashToken(state))
      .executeTakeFirst();
    if (
      !stored ||
      stored.provider !== provider.id ||
      stored.used_at !== null ||
      new Date(stored.expires_at).getTime() <= at.getTime() ||
      !sameHash(hashToken(cookie), stored.browser_hash)
    ) {
      return invalid();
    }
    const used = await db
      .updateTable("sign_in_states")
      .set({ used_at: at.toISOString() })
      .where("id", "=", stored.id)
      .where("used_at", "is", null)
      .executeTakeFirst();
    if (Number(used.numUpdatedRows) === 0) {
      return invalid();
    }
    setCookie(c, COOKIE_NAME, "", { path: COOKIE_PATH, httpOnly: true, sameSite: "Lax", maxAge: 0, secure });

    const deny = () =>
      db
        .updateTable("device_authorizations")
        .set({ status: "denied" })
        .where("id", "=", stored.device_authorization_id)
        .where("status", "=", "pending")
        .execute();

    if (providerError !== undefined) {
      await deny();
      return messagePage(c, "Sign-in cancelled", "Sign-in was cancelled.", 400);
    }
    const device = await db
      .selectFrom("device_authorizations")
      .select(["id", "status", "expires_at"])
      .where("id", "=", stored.device_authorization_id)
      .executeTakeFirst();
    if (device?.status !== "pending" || new Date(device.expires_at).getTime() <= at.getTime()) {
      return invalid();
    }

    let identity: ProviderIdentity;
    try {
      identity = await provider.exchange({
        code: code as string,
        redirectUri: `${publicUrl}/auth/${provider.id}/callback`,
        codeVerifier: stored.code_verifier,
      });
    } catch (error) {
      if (error instanceof SignInError) {
        await deny();
        return messagePage(c, "Sign-in refused", error.message, 403);
      }
      onError(error);
      return messagePage(c, "Sign-in failed", "Sign-in failed. Try again.", 502);
    }

    const userId = await resolveUser(identity, at);
    const approved = await db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable("device_authorizations")
        .set({ status: "approved", user_id: userId, approved_at: at.toISOString() })
        .where("id", "=", device.id)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        return false;
      }
      await recordAuditAs(trx, `user:${userId}`, null, at, {
        orgId: null,
        action: "user.sign_in",
        target: `user:${userId}`,
        detail: { provider: identity.provider, email: identity.email, via: "device" },
      });
      return true;
    });
    if (!approved) {
      return invalid();
    }
    return messagePage(
      c,
      "Signed in",
      `Signed in as ${identity.email}. You can close this tab and return to your terminal.`,
      200,
    );
  });
}
