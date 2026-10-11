import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { recordAuditAs } from "../audit.js";
import { hashToken } from "../auth.js";
import type { ConnectStatesTable } from "../db/schema.js";
import { newId } from "../ids.js";
import { retryOnUniqueViolation } from "../service/grants.js";
import type { GitHubAccount, GitHubConnector } from "./github.js";
import { messagePage } from "./pages.js";
import { type ProviderIdentity, SignInError } from "./providers.js";
import { addSeconds, codeChallenge, type SignInEnv, sameHash, token } from "./shared.js";

const CONNECT_COOKIE = "storage_connect";
const CONNECT_COOKIE_PATH = "/connect/";
const CONNECT_STATE_TTL_SECONDS = 600;

const NOT_CONNECTABLE = "Connecting GitHub isn't configured on this server.";
const INVALID_TICKET = "This connect link is invalid or has expired.";
const INVALID_STATE = "This connect link is invalid or has expired. Run `storage connect github` again.";

type ConnectState = ConnectStatesTable;

/** Mounts the browser side of connecting a GitHub account (spec: github-connect). */
export function addConnectRoutes(
  app: Hono,
  env: SignInEnv,
  github: GitHubConnector | undefined,
  now: () => Date,
  onError: (error: unknown) => void,
): void {
  const { db, publicUrl } = env;
  const google = env.providers.find((provider) => provider.id === "google");

  const setConnectCookie = (c: Context, value: string, maxAge: number) =>
    setCookie(c, CONNECT_COOKIE, value, {
      path: CONNECT_COOKIE_PATH,
      httpOnly: true,
      sameSite: "Lax",
      maxAge,
      secure: env.secure,
    });

  const markUsed = async (id: string, at: Date): Promise<boolean> => {
    const result = await db
      .updateTable("connect_states")
      .set({ used_at: at.toISOString() })
      .where("id", "=", id)
      .where("used_at", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  };

  /** Finds the state for a callback and checks the cookie, step, expiry and single use. Does not consume it. */
  const loadState = async (c: Context, step: ConnectState["step"], at: Date): Promise<ConnectState | null> => {
    const state = c.req.query("state");
    const cookie = getCookie(c, CONNECT_COOKIE);
    if (!state || !cookie) {
      return null;
    }
    const stored = await db
      .selectFrom("connect_states")
      .selectAll()
      .where("state_hash", "=", hashToken(state))
      .executeTakeFirst();
    if (
      !stored ||
      stored.step !== step ||
      stored.used_at !== null ||
      new Date(stored.expires_at).getTime() <= at.getTime() ||
      !sameHash(hashToken(cookie), stored.browser_hash)
    ) {
      return null;
    }
    return stored;
  };

  app.get("/connect/github/start", async (c) => {
    if (!google || !github) {
      return messagePage(c, "Connecting unavailable", NOT_CONNECTABLE, 400);
    }
    const at = now();
    const ticket = c.req.query("ticket");
    const invalid = () => messagePage(c, "Connect link not valid", INVALID_TICKET, 400);
    if (!ticket) {
      return invalid();
    }
    const row = await db
      .selectFrom("connect_tickets")
      .selectAll()
      .where("ticket_hash", "=", hashToken(ticket))
      .where("provider", "=", "github")
      .executeTakeFirst();
    if (!row || row.used_at !== null || new Date(row.expires_at).getTime() <= at.getTime()) {
      return invalid();
    }
    const used = await db
      .updateTable("connect_tickets")
      .set({ used_at: at.toISOString() })
      .where("id", "=", row.id)
      .where("used_at", "is", null)
      .executeTakeFirst();
    if (Number(used.numUpdatedRows) === 0) {
      return invalid();
    }
    const identity = await db
      .selectFrom("identities")
      .select("id")
      .where("user_id", "=", row.user_id)
      .where("provider", "=", "google")
      .executeTakeFirst();
    if (!identity) {
      return messagePage(c, "Connecting refused", "Run `storage login` with Google first, then connect GitHub.", 403);
    }
    const state = token();
    const verifier = token();
    const nonce = token();
    await db
      .insertInto("connect_states")
      .values({
        id: newId("cst"),
        state_hash: hashToken(state),
        browser_hash: hashToken(nonce),
        user_id: row.user_id,
        provider: "github",
        step: "google",
        code_verifier: verifier,
        created_at: at.toISOString(),
        expires_at: addSeconds(at, CONNECT_STATE_TTL_SECONDS).toISOString(),
        used_at: null,
      })
      .execute();
    setConnectCookie(c, nonce, CONNECT_STATE_TTL_SECONDS);
    return c.redirect(
      google.authorizeUrl({
        state,
        redirectUri: `${publicUrl}/connect/google/callback`,
        codeChallenge: codeChallenge(verifier),
      }),
      302,
    );
  });

  app.get("/connect/google/callback", async (c) => {
    if (!google || !github) {
      return messagePage(c, "Connecting unavailable", NOT_CONNECTABLE, 400);
    }
    const invalid = () => messagePage(c, "Connect link not valid", INVALID_STATE, 400);
    const at = now();
    const code = c.req.query("code");
    const providerError = c.req.query("error");
    if (providerError === undefined && !code) {
      return invalid();
    }
    const stored = await loadState(c, "google", at);
    if (!stored) {
      return invalid();
    }
    // The state ends here on any failure; only a successful Google check advances it.
    const end = async (response: () => Response) => {
      await markUsed(stored.id, at);
      setConnectCookie(c, "", 0);
      return response();
    };
    if (providerError !== undefined) {
      return end(() => messagePage(c, "Connecting cancelled", "Connecting GitHub was cancelled.", 400));
    }

    let identity: ProviderIdentity;
    try {
      identity = await google.exchange({
        code: code as string,
        redirectUri: `${publicUrl}/connect/google/callback`,
        codeVerifier: stored.code_verifier,
      });
    } catch (error) {
      if (error instanceof SignInError) {
        return end(() => messagePage(c, "Connecting refused", error.message, 403));
      }
      onError(error);
      return end(() => messagePage(c, "Connecting failed", "Connecting GitHub failed. Try again.", 502));
    }

    const known = await db
      .selectFrom("identities")
      .select("user_id")
      .where("provider", "=", "google")
      .where("subject", "=", identity.subject)
      .executeTakeFirst();
    if (known?.user_id !== stored.user_id) {
      const user = await db.selectFrom("users").select("email").where("id", "=", stored.user_id).executeTakeFirst();
      return end(() =>
        messagePage(
          c,
          "Connecting refused",
          `Sign in with the Google account you use for Storage (${user?.email ?? "unknown"}).`,
          403,
        ),
      );
    }

    const state = token();
    const verifier = token();
    const advanced = await db
      .updateTable("connect_states")
      .set({
        state_hash: hashToken(state),
        code_verifier: verifier,
        step: "github",
        expires_at: addSeconds(at, CONNECT_STATE_TTL_SECONDS).toISOString(),
      })
      .where("id", "=", stored.id)
      .where("state_hash", "=", stored.state_hash)
      .where("step", "=", "google")
      .where("used_at", "is", null)
      .executeTakeFirst();
    if (Number(advanced.numUpdatedRows) === 0) {
      return invalid();
    }
    return c.redirect(
      github.authorizeUrl({
        state,
        redirectUri: `${publicUrl}/connect/github/callback`,
        codeChallenge: codeChallenge(verifier),
      }),
      302,
    );
  });

  app.get("/connect/github/callback", async (c) => {
    if (!google || !github) {
      return messagePage(c, "Connecting unavailable", NOT_CONNECTABLE, 400);
    }
    const invalid = () => messagePage(c, "Connect link not valid", INVALID_STATE, 400);
    const at = now();
    const code = c.req.query("code");
    const providerError = c.req.query("error");
    if (providerError === undefined && !code) {
      return invalid();
    }
    const stored = await loadState(c, "github", at);
    if (!stored) {
      return invalid();
    }
    if (!(await markUsed(stored.id, at))) {
      return invalid();
    }
    setConnectCookie(c, "", 0);
    if (providerError !== undefined) {
      return messagePage(c, "Connecting cancelled", "Connecting GitHub was cancelled.", 400);
    }

    let account: GitHubAccount;
    try {
      account = await github.exchange({
        code: code as string,
        redirectUri: `${publicUrl}/connect/github/callback`,
        codeVerifier: stored.code_verifier,
      });
    } catch (error) {
      if (error instanceof SignInError) {
        return messagePage(c, "Connecting refused", error.message, 403);
      }
      onError(error);
      return messagePage(c, "Connecting failed", "Connecting GitHub failed. Try again.", 502);
    }

    const userId = stored.user_id;
    const conflict = await retryOnUniqueViolation(() =>
      db.transaction().execute(async (trx): Promise<string | null> => {
        const stamp = at.toISOString();
        const bySubject = await trx
          .selectFrom("connected_accounts")
          .select(["id", "user_id"])
          .where("provider", "=", "github")
          .where("subject", "=", account.id)
          .executeTakeFirst();
        if (bySubject && bySubject.user_id !== userId) {
          return "This GitHub account is already connected to another Storage account.";
        }
        if (bySubject) {
          await trx
            .updateTable("connected_accounts")
            .set({ login: account.login, updated_at: stamp })
            .where("id", "=", bySubject.id)
            .execute();
        } else {
          const byUser = await trx
            .selectFrom("connected_accounts")
            .select("login")
            .where("user_id", "=", userId)
            .where("provider", "=", "github")
            .executeTakeFirst();
          if (byUser) {
            return `Your Storage account is already connected to GitHub account ${byUser.login}. Run \`storage disconnect github\` first.`;
          }
          await trx
            .insertInto("connected_accounts")
            .values({
              id: newId("cac"),
              user_id: userId,
              provider: "github",
              subject: account.id,
              login: account.login,
              created_at: stamp,
              updated_at: stamp,
            })
            .execute();
        }
        await recordAuditAs(trx, `user:${userId}`, null, at, {
          orgId: null,
          action: "account.connect",
          target: `user:${userId}`,
          detail: { provider: "github", id: account.id, login: account.login },
        });
        return null;
      }),
    );
    if (conflict !== null) {
      return messagePage(c, "Connecting refused", conflict, 409);
    }
    return messagePage(
      c,
      "GitHub connected",
      `Connected GitHub account ${account.login}. You can close this tab.`,
      200,
    );
  });
}
