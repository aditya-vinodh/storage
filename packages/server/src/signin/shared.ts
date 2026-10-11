import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { hashToken } from "../auth.js";
import type { Db } from "../db/index.js";
import { newId } from "../ids.js";
import { retryOnUniqueViolation } from "../service/grants.js";
import type { GitHubConnector } from "./github.js";
import { type ProviderIdentity, SignInError, type SignInProvider } from "./providers.js";

export interface SignInOptions {
  /** Public base URL (no trailing slash): verification_uri and redirect URIs are built from it. */
  publicUrl: string;
  providers: SignInProvider[];
  /** Connects GitHub accounts to signed-in users. Needs a Google provider to be usable. */
  github?: GitHubConnector;
}

export interface SignInDeps {
  db: Db;
  signIn?: SignInOptions;
}

export const SIGN_IN_STATE_TTL_SECONDS = 600;
const COOKIE_NAME = "storage_signin";
const COOKIE_PATH = "/auth/";

export const NOT_CONFIGURED = "Browser sign-in isn't configured on this server.";
export const INVALID_LINK = "This sign-in link is invalid or has expired. Run `storage login` again.";

export function token(): string {
  return randomBytes(32).toString("base64url");
}

export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function addSeconds(at: Date, seconds: number): Date {
  return new Date(at.getTime() + seconds * 1000);
}

/** Reads a form body. Returns null if any value isn't a string. */
export async function readForm(c: Context): Promise<Record<string, string> | null> {
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

export function oauthJson(c: Context, body: object, status: ContentfulStatusCode = 200): Response {
  return c.json(body, status, { "cache-control": "no-store" });
}

export function oauthError(
  c: Context,
  error: string,
  description?: string,
  status: ContentfulStatusCode = 400,
): Response {
  return oauthJson(c, description === undefined ? { error } : { error, error_description: description }, status);
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** What the sign-in routes share: the database, the configured providers and the public URL. */
export interface SignInEnv {
  db: Db;
  providers: SignInProvider[];
  publicUrl: string;
  configured: boolean;
  secure: boolean;
}

export function signInEnv(options: SignInDeps): SignInEnv {
  const providers = options.signIn?.providers ?? [];
  const publicUrl = options.signIn?.publicUrl ?? "";
  return {
    db: options.db,
    providers,
    publicUrl,
    configured: providers.length > 0,
    secure: publicUrl.startsWith("https://"),
  };
}

/**
 * Records a sign-in state for the provider redirect, sets the browser cookie and redirects to the provider.
 * Exactly one of `target`'s ids is set. The state row expires with the request it belongs to.
 */
export async function startProviderSignIn(
  c: Context,
  env: SignInEnv,
  at: Date,
  provider: SignInProvider,
  target: { deviceAuthorizationId: string | null; authorizationRequestId: string | null },
  requestExpiresAt: string,
): Promise<Response> {
  const state = token();
  const verifier = token();
  const nonce = token();
  const expiresAt = Math.min(addSeconds(at, SIGN_IN_STATE_TTL_SECONDS).getTime(), new Date(requestExpiresAt).getTime());
  await env.db
    .insertInto("sign_in_states")
    .values({
      id: newId("sis"),
      state_hash: hashToken(state),
      browser_hash: hashToken(nonce),
      provider: provider.id,
      code_verifier: verifier,
      device_authorization_id: target.deviceAuthorizationId,
      authorization_request_id: target.authorizationRequestId,
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
    secure: env.secure,
  });
  return c.redirect(
    provider.authorizeUrl({
      state,
      redirectUri: `${env.publicUrl}/auth/${provider.id}/callback`,
      codeChallenge: codeChallenge(verifier),
    }),
    302,
  );
}

export const SIGN_IN_COOKIE = COOKIE_NAME;

export function clearSignInCookie(c: Context, env: SignInEnv): void {
  setCookie(c, COOKIE_NAME, "", { path: COOKIE_PATH, httpOnly: true, sameSite: "Lax", maxAge: 0, secure: env.secure });
}

/**
 * Finds or creates the user for a provider identity. Retried once on a unique violation.
 * Throws SignInError when the email belongs to a user already linked to a different account at the provider.
 */
export function resolveUser(db: Db, identity: ProviderIdentity, at: Date): Promise<string> {
  return retryOnUniqueViolation(() =>
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
          .set({ email: identity.email, hd: identity.hd, last_sign_in_at: stamp })
          .where("id", "=", existing.id)
          .execute();
        return existing.user_id;
      }
      let userId: string;
      const byEmail = await trx.selectFrom("users").select("id").where("email", "=", identity.email).executeTakeFirst();
      if (byEmail) {
        const sameProvider = await trx
          .selectFrom("identities")
          .select("id")
          .where("user_id", "=", byEmail.id)
          .where("provider", "=", identity.provider)
          .executeTakeFirst();
        if (sameProvider) {
          throw new SignInError(
            `${identity.email} is already linked to a different ${identity.provider === "google" ? "Google" : "GitHub"} account. Ask an admin of your Storage server for help.`,
          );
        }
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
          hd: identity.hd,
          created_at: stamp,
          last_sign_in_at: stamp,
        })
        .execute();
      return userId;
    }),
  );
}
