import { createSign } from "node:crypto";
import type { GitHubAppConfig } from "../config.js";
import { formBody, readJson, SignInError, text } from "../signin/providers.js";
import { type PullResult, readPullRequest } from "./pulls.js";

/** The server's GitHub App: install links, the installer's user authorization, and reads as an installation. */

export interface Installation {
  id: string;
  /** Lowercased. */
  account_login: string;
  account_type: "User" | "Organization";
}

export interface GitHubApp {
  /** https://github.com/apps/<slug>/installations/new?state=<state> */
  installUrl(state: string): string;
  /** Exchanges the install callback's code for a user access token. Throws SignInError when GitHub refuses it. */
  exchangeCode(code: string): Promise<string>;
  /** GET /user/installations with the user's token, following pages (up to 10). */
  userInstallations(userToken: string): Promise<Installation[]>;
  /**
   * GET /repos/<owner>/<repo>/pulls/<number> as the installation. A non-2xx response is `{ ok: false, status }`;
   * network failures and a refused installation token throw.
   */
  pull(installationId: string, owner: string, repo: string, number: number): Promise<PullResult>;
}

const MAX_PAGES = 10;
/** Installation tokens are reused until this long before they expire. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

const apiHeaders = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "storage-server",
};

function nextLink(header: string | null): string | null {
  for (const part of (header ?? "").split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (match) {
      return match[1] as string;
    }
  }
  return null;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function githubAppClient(
  config: GitHubAppConfig,
  doFetch: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): GitHubApp {
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  const inFlight = new Map<string, Promise<string>>();

  /** The app's own JWT, valid for ten minutes (backdated a minute for clock drift). */
  const appJwt = (): string => {
    const seconds = Math.floor(now().getTime() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: config.appId }));
    const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(config.privateKey);
    return `${header}.${payload}.${base64url(signature)}`;
  };

  const requestToken = async (installationId: string): Promise<string> => {
    const url = `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
    const response = await doFetch(url, {
      method: "POST",
      headers: { ...apiHeaders, authorization: `Bearer ${appJwt()}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub ${url} returned ${response.status}.`);
    }
    const body = await readJson(response);
    const token = text(body?.token);
    const expiresAt = Date.parse(text(body?.expires_at) ?? "");
    if (token === undefined || Number.isNaN(expiresAt)) {
      throw new Error(`GitHub ${url} returned no installation token.`);
    }
    tokens.set(installationId, { token, expiresAt: expiresAt - TOKEN_MARGIN_MS });
    return token;
  };

  const installationToken = (installationId: string): Promise<string> => {
    const cached = tokens.get(installationId);
    if (cached !== undefined && now().getTime() < cached.expiresAt) {
      return Promise.resolve(cached.token);
    }
    let pending = inFlight.get(installationId);
    if (pending === undefined) {
      pending = requestToken(installationId).finally(() => inFlight.delete(installationId));
      inFlight.set(installationId, pending);
    }
    return pending;
  };

  return {
    installUrl(state) {
      return `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
    },
    async exchangeCode(code) {
      const response = await doFetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: formBody({ client_id: config.clientId, client_secret: config.clientSecret, code }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`GitHub https://github.com/login/oauth/access_token returned ${response.status}.`);
      }
      const body = await readJson(response);
      const accessToken = text(body?.access_token);
      if (body === null || body.error !== undefined || accessToken === undefined) {
        throw new SignInError("GitHub refused the authorization.");
      }
      return accessToken;
    },
    async userInstallations(userToken) {
      const installations: Installation[] = [];
      let url: string | null = "https://api.github.com/user/installations?per_page=100";
      for (let page = 0; url !== null && page < MAX_PAGES; page++) {
        const response: Response = await doFetch(url, {
          headers: { ...apiHeaders, authorization: `Bearer ${userToken}` },
        });
        if (response.status === 401) {
          await response.body?.cancel();
          throw new SignInError("GitHub no longer honors that authorization. Try installing again.");
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`GitHub ${url} returned ${response.status}.`);
        }
        const body = await readJson(response);
        const items: unknown[] = Array.isArray(body?.installations) ? body.installations : [];
        for (const entry of items) {
          const item = entry as Record<string, unknown> | null;
          const account = item?.account as Record<string, unknown> | null | undefined;
          const id = typeof item?.id === "number" || typeof item?.id === "string" ? String(item.id) : undefined;
          const login = text(account?.login);
          if (id === undefined || login === undefined) {
            continue;
          }
          installations.push({
            id,
            account_login: login.toLowerCase(),
            account_type: account?.type === "Organization" ? "Organization" : "User",
          });
        }
        url = nextLink(response.headers.get("link"));
        // The next request carries the user's token, so it only ever goes to GitHub's API.
        if (url !== null && !url.startsWith("https://api.github.com/")) {
          throw new Error(`GitHub returned a next page outside https://api.github.com/: ${url}`);
        }
      }
      return installations;
    },
    async pull(installationId, owner, repo, number) {
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(String(number))}`;
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await installationToken(installationId);
        response = await doFetch(url, { headers: { ...apiHeaders, authorization: `Bearer ${token}` } });
        if (response.status !== 401 || attempt === 1) {
          break;
        }
        // The token was revoked before it expired.
        await response.body?.cancel();
        tokens.delete(installationId);
      }
      const final = response as Response;
      if (!final.ok) {
        await final.body?.cancel();
        return { ok: false, status: final.status };
      }
      const pull = readPullRequest(await final.json());
      if (pull === null) {
        throw new Error(`GitHub ${url} returned an unexpected pull request.`);
      }
      return { ok: true, pull };
    },
  };
}
