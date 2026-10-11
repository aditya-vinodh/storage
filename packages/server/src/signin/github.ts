import type { Group } from "../memberships.js";
import { type ClientOptions, formBody, readJson, SignInError, text } from "./providers.js";

export interface GitHubAccount {
  /** GitHub's numeric user id, as a string. It survives renames. */
  id: string;
  login: string;
}

/** A completed GitHub connect: the account and the token GitHub issued for it. */
export interface GitHubConnection extends GitHubAccount {
  accessToken: string;
  /** The scopes GitHub granted, from the token response. */
  scopes: string[];
}

/** GitHub no longer honors the user's token (revoked, or the app was removed). */
export class GitHubTokenRevoked extends Error {}

const MAX_PAGES = 10;

export interface GitHubConnector {
  /** GitHub authorize URL, scope "read:user read:org", PKCE S256. */
  authorizeUrl(params: { state: string; redirectUri: string; codeChallenge: string }): string;
  /** Code exchange, then GET https://api.github.com/user. Throws SignInError when GitHub refuses the code. */
  exchange(params: { code: string; redirectUri: string; codeVerifier: string }): Promise<GitHubConnection>;
  /** GET https://api.github.com/users/<login> with basic auth (client id:secret). Null on 404; throws on anything else. */
  lookupUser(login: string): Promise<GitHubAccount | null>;
  /** GET /orgs/<login>, basic auth (client id:secret). Null on 404; throws on anything else. */
  lookupOrg(login: string): Promise<Group | null>;
  /** GET /orgs/<org>/teams/<slug> with the user's token. Null on 403 or 404; GitHubTokenRevoked on 401; throws on anything else. */
  lookupTeam(accessToken: string, org: string, slug: string): Promise<Group | null>;
  /**
   * GET /user/memberships/orgs?state=active&per_page=100 and GET /user/teams?per_page=100 with the user's token,
   * following Link rel="next" up to 10 pages each. Org entries with state other than "active" are skipped.
   * GitHubTokenRevoked on 401; throws on any other failure.
   */
  memberships(accessToken: string): Promise<Group[]>;
}

function numericId(value: unknown): string | undefined {
  return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
}

function nextLink(header: string | null): string | null {
  for (const part of (header ?? "").split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (match) {
      return match[1] as string;
    }
  }
  return null;
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

  const basicAuth = () => `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`;
  const bearer = (accessToken: string) => ({ ...apiHeaders, authorization: `Bearer ${accessToken}` });

  /** Every item of a paginated list endpoint, following Link rel="next" up to MAX_PAGES pages. */
  const listPages = async (start: string, accessToken: string): Promise<unknown[]> => {
    const items: unknown[] = [];
    let url: string | null = start;
    for (let page = 0; url !== null && page < MAX_PAGES; page++) {
      const response = await doFetch(url, { headers: bearer(accessToken) });
      if (response.status === 401) {
        throw new GitHubTokenRevoked(`GitHub ${url} returned 401.`);
      }
      if (!response.ok) {
        throw new Error(`GitHub ${url} returned ${response.status}.`);
      }
      const body: unknown = await response.json();
      if (!Array.isArray(body)) {
        throw new Error(`GitHub ${url} returned an unexpected body.`);
      }
      items.push(...body);
      url = nextLink(response.headers.get("link"));
      // The next request carries the user's token, so it only ever goes to GitHub's API.
      if (url !== null && !url.startsWith("https://api.github.com/")) {
        throw new Error(`GitHub returned a next page outside https://api.github.com/: ${url}`);
      }
    }
    return items;
  };

  return {
    authorizeUrl({ state, redirectUri, codeChallenge }) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", "read:user read:org");
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
      const scopes = (text(body.scope) ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope !== "");
      return { ...account(await readJson(user), url), accessToken, scopes };
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
    async lookupOrg(login) {
      const url = `https://api.github.com/orgs/${encodeURIComponent(login)}`;
      const response = await doFetch(url, { headers: { ...apiHeaders, authorization: basicAuth() } });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`GitHub ${url} returned ${response.status}.`);
      }
      const found = account(await readJson(response), url);
      return { principal: `github-org:${found.id}`, name: found.login };
    },
    async lookupTeam(accessToken, org, slug) {
      const url = `https://api.github.com/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}`;
      const response = await doFetch(url, { headers: bearer(accessToken) });
      if (response.status === 401) {
        throw new GitHubTokenRevoked(`GitHub ${url} returned 401.`);
      }
      if (response.status === 403 || response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`GitHub ${url} returned ${response.status}.`);
      }
      const body = await readJson(response);
      const id = numericId(body?.id);
      const teamSlug = text(body?.slug);
      const orgLogin = text((body?.organization as Record<string, unknown> | undefined)?.login);
      if (id === undefined || teamSlug === undefined || orgLogin === undefined) {
        throw new Error(`GitHub ${url} returned no team id, slug and organization.`);
      }
      return { principal: `github-team:${id}`, name: `${orgLogin}/${teamSlug}` };
    },
    async memberships(accessToken) {
      const groups = new Map<string, Group>();
      const orgs = await listPages(
        "https://api.github.com/user/memberships/orgs?state=active&per_page=100",
        accessToken,
      );
      for (const entry of orgs) {
        const item = entry as Record<string, unknown> | null;
        const org = item?.organization as Record<string, unknown> | undefined;
        const id = numericId(org?.id);
        const login = text(org?.login);
        if (item?.state !== "active" || id === undefined || login === undefined) {
          continue;
        }
        groups.set(`github-org:${id}`, { principal: `github-org:${id}`, name: login });
      }
      const teams = await listPages("https://api.github.com/user/teams?per_page=100", accessToken);
      for (const entry of teams) {
        const item = entry as Record<string, unknown> | null;
        const id = numericId(item?.id);
        const slug = text(item?.slug);
        const orgLogin = text((item?.organization as Record<string, unknown> | undefined)?.login);
        if (id === undefined || slug === undefined || orgLogin === undefined) {
          continue;
        }
        groups.set(`github-team:${id}`, { principal: `github-team:${id}`, name: `${orgLogin}/${slug}` });
      }
      return [...groups.values()];
    },
  };
}
