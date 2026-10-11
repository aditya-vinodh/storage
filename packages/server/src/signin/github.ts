import { type ClientOptions, formBody, readJson, SignInError, text } from "./providers.js";

export interface GitHubAccount {
  /** GitHub's numeric user id, as a string. It survives renames. */
  id: string;
  login: string;
}

export interface GitHubConnector {
  /** GitHub authorize URL, scope "read:user", PKCE S256. */
  authorizeUrl(params: { state: string; redirectUri: string; codeChallenge: string }): string;
  /** Code exchange, then GET https://api.github.com/user. Throws SignInError when GitHub refuses the code. */
  exchange(params: { code: string; redirectUri: string; codeVerifier: string }): Promise<GitHubAccount>;
  /** GET https://api.github.com/users/<login> with basic auth (client id:secret). Null on 404; throws on anything else. */
  lookupUser(login: string): Promise<GitHubAccount | null>;
}

function account(body: Record<string, unknown> | null, url: string): GitHubAccount {
  const id = typeof body?.id === "number" || typeof body?.id === "string" ? String(body.id) : "";
  const login = text(body?.login);
  if (id === "" || login === undefined) {
    throw new Error(`GitHub ${url} returned no account id and login.`);
  }
  return { id, login };
}

export function githubConnector(options: ClientOptions): GitHubConnector {
  const doFetch = options.fetch ?? fetch;
  const apiHeaders = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "storage-server",
  };

  return {
    authorizeUrl({ state, redirectUri, codeChallenge }) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", "read:user");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
    async exchange({ code, redirectUri, codeVerifier }) {
      const response = await doFetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: formBody({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });
      const body = await readJson(response);
      const accessToken = text(body?.access_token);
      if (body === null || body.error !== undefined || accessToken === undefined) {
        const reason = text(body?.error_description) ?? text(body?.error) ?? `HTTP ${response.status}`;
        throw new SignInError(`Connecting GitHub failed: ${reason}.`);
      }
      const url = "https://api.github.com/user";
      const user = await doFetch(url, { headers: { ...apiHeaders, authorization: `Bearer ${accessToken}` } });
      if (!user.ok) {
        throw new Error(`GitHub ${url} returned ${user.status}.`);
      }
      return account(await readJson(user), url);
    },
    async lookupUser(login) {
      const url = `https://api.github.com/users/${encodeURIComponent(login)}`;
      const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64");
      const response = await doFetch(url, { headers: { ...apiHeaders, authorization: `Basic ${basic}` } });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`GitHub ${url} returned ${response.status}.`);
      }
      return account(await readJson(response), url);
    },
  };
}
