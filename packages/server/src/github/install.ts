import { formatUri } from "@storage/core";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { recordAuditAs } from "../audit.js";
import { hashToken } from "../auth.js";
import type { ConnectStatesTable } from "../db/schema.js";
import type { AppOptions } from "../http/app.js";
import { newId } from "../ids.js";
import { retryOnUniqueViolation } from "../service/grants.js";
import { messagePage } from "../signin/pages.js";
import { type ProviderIdentity, SignInError } from "../signin/providers.js";
import { addSeconds, codeChallenge, type SignInOptions, sameHash, signInEnv, token } from "../signin/shared.js";
import type { GitHubApp, Installation } from "./app.js";

const INSTALL_COOKIE = "storage_github_install";
const INSTALL_COOKIE_PATH = "/github/install/";
const INSTALL_STATE_TTL_SECONDS = 600;
const PROVIDER = "github-app";

const NOT_INSTALLABLE = "Installing the GitHub App isn't available on this server.";
const INVALID_TICKET = "This install link is invalid or has expired.";
const INVALID_STATE = "This install link is invalid or has expired. Run `storage github install` again.";

type InstallState = ConnectStatesTable;

/** Mounts the browser side of linking a GitHub App installation to an org (docs/specs/bindings.md). */
export function addGitHubInstallRoutes(
  app: Hono,
  options: AppOptions & { signIn?: SignInOptions },
  githubApp: GitHubApp,
  now: () => Date,
  onError: (error: unknown) => void,
): void {
  const env = signInEnv(options);
  const { db, publicUrl } = env;
  const google = env.providers.find((provider) => provider.id === "google");
  const googleRedirect = `${publicUrl}/github/install/google/callback`;

  const setInstallCookie = (c: Context, value: string, maxAge: number) =>
    setCookie(c, INSTALL_COOKIE, value, {
      path: INSTALL_COOKIE_PATH,
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
  const loadState = async (c: Context, step: InstallState["step"], at: Date): Promise<InstallState | null> => {
    const state = c.req.query("state");
    const cookie = getCookie(c, INSTALL_COOKIE);
    if (!state || !cookie) {
      return null;
    }
    const stored = await db
      .selectFrom("connect_states")
      .selectAll()
      .where("state_hash", "=", hashToken(state))
      .where("provider", "=", PROVIDER)
      .executeTakeFirst();
    if (
      !stored ||
      stored.step !== step ||
      stored.org_id === null ||
      stored.used_at !== null ||
      new Date(stored.expires_at).getTime() <= at.getTime() ||
      !sameHash(hashToken(cookie), stored.browser_hash)
    ) {
      return null;
    }
    return stored;
  };

  app.get("/github/install/start", async (c) => {
    if (!google) {
      return messagePage(c, "Installing unavailable", NOT_INSTALLABLE, 400);
    }
    const at = now();
    const ticket = c.req.query("ticket");
    const invalid = () => messagePage(c, "Install link not valid", INVALID_TICKET, 400);
    if (!ticket) {
      return invalid();
    }
    const row = await db
      .selectFrom("connect_tickets")
      .selectAll()
      .where("ticket_hash", "=", hashToken(ticket))
      .where("provider", "=", PROVIDER)
      .executeTakeFirst();
    if (!row || row.org_id === null || row.used_at !== null || new Date(row.expires_at).getTime() <= at.getTime()) {
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
      return messagePage(c, "Installing refused", "Run `storage login` with Google first, then install the app.", 403);
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
        provider: PROVIDER,
        org_id: row.org_id,
        step: "google",
        code_verifier: verifier,
        created_at: at.toISOString(),
        expires_at: addSeconds(at, INSTALL_STATE_TTL_SECONDS).toISOString(),
        used_at: null,
      })
      .execute();
    setInstallCookie(c, nonce, INSTALL_STATE_TTL_SECONDS);
    return c.redirect(
      google.authorizeUrl({ state, redirectUri: googleRedirect, codeChallenge: codeChallenge(verifier) }),
      302,
    );
  });

  app.get("/github/install/google/callback", async (c) => {
    if (!google) {
      return messagePage(c, "Installing unavailable", NOT_INSTALLABLE, 400);
    }
    const invalid = () => messagePage(c, "Install link not valid", INVALID_STATE, 400);
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
      setInstallCookie(c, "", 0);
      return response();
    };
    if (providerError !== undefined) {
      return end(() => messagePage(c, "Installing cancelled", "Installing the GitHub App was cancelled.", 400));
    }

    let identity: ProviderIdentity;
    try {
      identity = await google.exchange({
        code: code as string,
        redirectUri: googleRedirect,
        codeVerifier: stored.code_verifier,
      });
    } catch (error) {
      if (error instanceof SignInError) {
        return end(() => messagePage(c, "Installing refused", error.message, 403));
      }
      onError(error);
      return end(() => messagePage(c, "Installing failed", "Installing the GitHub App failed. Try again.", 502));
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
          "Installing refused",
          `Sign in with the Google account you use for Storage (${user?.email ?? "unknown"}).`,
          403,
        ),
      );
    }

    const state = token();
    const advanced = await db
      .updateTable("connect_states")
      .set({
        state_hash: hashToken(state),
        step: "github",
        expires_at: addSeconds(at, INSTALL_STATE_TTL_SECONDS).toISOString(),
      })
      .where("id", "=", stored.id)
      .where("state_hash", "=", stored.state_hash)
      .where("step", "=", "google")
      .where("used_at", "is", null)
      .executeTakeFirst();
    if (Number(advanced.numUpdatedRows) === 0) {
      return invalid();
    }
    return c.redirect(githubApp.installUrl(state), 302);
  });

  app.get("/github/install/callback", async (c) => {
    if (!google) {
      return messagePage(c, "Installing unavailable", NOT_INSTALLABLE, 400);
    }
    const invalid = () => messagePage(c, "Install link not valid", INVALID_STATE, 400);
    const at = now();
    const stored = await loadState(c, "github", at);
    if (!stored) {
      return invalid();
    }
    if (!(await markUsed(stored.id, at))) {
      return invalid();
    }
    setInstallCookie(c, "", 0);
    const installationId = c.req.query("installation_id");
    if (!installationId) {
      return messagePage(
        c,
        "Installing failed",
        "GitHub didn't say which installation to link. Install the app again with storage github install.",
        400,
      );
    }
    const code = c.req.query("code");
    if (!code) {
      return invalid();
    }

    let visible: Installation[];
    try {
      visible = await githubApp.userInstallations(await githubApp.exchangeCode(code));
    } catch (error) {
      if (error instanceof SignInError) {
        return messagePage(c, "Installing refused", error.message, 403);
      }
      onError(error);
      return messagePage(c, "Installing failed", "Installing the GitHub App failed. Try again.", 502);
    }
    const installation = visible.find((candidate) => candidate.id === installationId);
    if (!installation) {
      return messagePage(c, "Installing refused", "Your GitHub account can't see that installation.", 403);
    }

    const userId = stored.user_id;
    const orgId = stored.org_id as string;
    const org = await db.selectFrom("orgs").select("slug").where("id", "=", orgId).executeTakeFirst();
    if (!org) {
      return invalid();
    }
    const orgUri = formatUri({ org: org.slug });
    const added = await retryOnUniqueViolation(() =>
      db.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom("github_installations")
          .select("id")
          .where("org_id", "=", orgId)
          .where("installation_id", "=", installation.id)
          .executeTakeFirst();
        if (existing) {
          return false;
        }
        await trx
          .insertInto("github_installations")
          .values({
            id: newId("ghi"),
            org_id: orgId,
            installation_id: installation.id,
            account_login: installation.account_login.toLowerCase(),
            account_type: installation.account_type,
            created_by: `user:${userId}`,
            created_at: at.toISOString(),
          })
          .execute();
        await recordAuditAs(trx, `user:${userId}`, null, at, {
          orgId,
          action: "github.install",
          target: orgUri,
          detail: { installation_id: installation.id, account: installation.account_login.toLowerCase() },
        });
        return true;
      }),
    );
    const account = installation.account_login.toLowerCase();
    if (!added) {
      return messagePage(c, "Already linked", `${account} is already linked to ${orgUri}.`, 200);
    }
    return messagePage(c, "GitHub App linked", `Linked ${account} to ${orgUri}. You can close this tab.`, 200);
  });
}
