import { createHash } from "node:crypto";
import type {
  GitHubAccount,
  GitHubConnector,
  Group,
  ProviderIdentity,
  SignInError,
  SignInProvider,
} from "@storage/server";
import { type Harness, SERVER_URL } from "./harness.js";

/**
 * A sign-in provider that never touches the network. `accounts` maps an authorization code to the identity the
 * provider returns for it, or to a SignInError to throw. It enforces PKCE and the redirect URI like a real provider.
 */
export function fakeProvider(
  id: "github" | "google",
  accounts: Record<string, (Omit<ProviderIdentity, "hd"> & { hd?: string | null }) | SignInError>,
): SignInProvider {
  const challenges = new Set<string>();
  return {
    id,
    label: id === "github" ? "GitHub" : "Google",
    authorizeUrl({ state, redirectUri, codeChallenge }) {
      challenges.add(codeChallenge);
      const params = new URLSearchParams({ state, redirect_uri: redirectUri, code_challenge: codeChallenge });
      return `http://idp.test/${id}/authorize?${params}`;
    },
    async exchange({ code, redirectUri, codeVerifier }) {
      const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
      if (!challenges.has(challenge)) {
        throw new Error("PKCE verification failed: code_verifier doesn't match any code_challenge");
      }
      if (
        redirectUri !== `${SERVER_URL}/auth/${id}/callback` &&
        redirectUri !== `${SERVER_URL}/connect/${id}/callback`
      ) {
        throw new Error(`Unexpected redirect_uri ${redirectUri}`);
      }
      const account = accounts[code];
      if (!account) {
        throw new Error(`Unknown authorization code ${code}`);
      }
      if (account instanceof Error) {
        throw account;
      }
      return { hd: null, ...account };
    },
  };
}

export interface FakeGitHub extends GitHubConnector {
  /** login (lowercase) -> id, answered by lookupUser; a missing login is a 404 (null). */
  users: Map<string, string>;
  /** When set, lookupUser throws this. */
  lookupError: Error | null;
  /** org login (lowercase) -> id, answered by lookupOrg; a missing org is a 404 (null). */
  orgs: Map<string, string>;
  /** `org/slug` (lowercase) -> team id, answered by lookupTeam for members of that org only. */
  teams: Map<string, string>;
  /** GitHub account id -> the groups `memberships` returns for that account's token. */
  accountGroups: Map<string, Group[]>;
  /** When set, `memberships` throws this (a GitHubTokenRevoked instance simulates a revoked token). */
  membershipsError: Error | null;
  /** How many times `memberships` was called. */
  membershipCalls: number;
  /** When set, lookupOrg and lookupTeam throw this. */
  orgLookupError: Error | null;
  /** When set, lookupTeam throws this (checked after orgLookupError). */
  teamLookupError: Error | null;
  /** Authorization code -> token scopes returned by exchange. Codes not listed get `defaultScopes`. */
  scopes: Map<string, string[]>;
}

const DEFAULT_SCOPES = ["read:org", "read:user"];

/**
 * A GitHub connector that never touches the network. `accounts` maps an authorization code to the account GitHub
 * returns for it, or to a SignInError to throw. `users` seeds what `lookupUser` answers. It enforces PKCE and the
 * redirect URI like a real provider. `exchange` returns the access token `gho_<code>` and the scopes in `scopes`
 * (default read:org and read:user); the fake remembers which account each token belongs to.
 */
export function fakeGitHub(
  accounts: Record<string, GitHubAccount | SignInError>,
  users: Record<string, string> = {},
  options: {
    orgs?: Record<string, string>;
    teams?: Record<string, string>;
    memberships?: Record<string, Group[]>;
    scopes?: Record<string, string[]>;
  } = {},
): FakeGitHub {
  const challenges = new Set<string>();
  const lower = (record: Record<string, string>) =>
    new Map(Object.entries(record).map(([key, id]) => [key.toLowerCase(), id]));
  const tokenAccounts = new Map<string, string>();
  const fake: FakeGitHub = {
    users: lower(users),
    lookupError: null,
    orgs: lower(options.orgs ?? {}),
    teams: lower(options.teams ?? {}),
    accountGroups: new Map(Object.entries(options.memberships ?? {})),
    membershipsError: null,
    membershipCalls: 0,
    orgLookupError: null,
    teamLookupError: null,
    scopes: new Map(Object.entries(options.scopes ?? {})),
    authorizeUrl({ state, redirectUri, codeChallenge }) {
      challenges.add(codeChallenge);
      const params = new URLSearchParams({ state, redirect_uri: redirectUri, code_challenge: codeChallenge });
      return `http://idp.test/github/authorize?${params}`;
    },
    async exchange({ code, redirectUri, codeVerifier }) {
      const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
      if (!challenges.has(challenge)) {
        throw new Error("PKCE verification failed: code_verifier doesn't match any code_challenge");
      }
      if (redirectUri !== `${SERVER_URL}/connect/github/callback`) {
        throw new Error(`Unexpected redirect_uri ${redirectUri}`);
      }
      const account = accounts[code];
      if (!account) {
        throw new Error(`Unknown authorization code ${code}`);
      }
      if (account instanceof Error) {
        throw account;
      }
      const accessToken = `gho_${code}`;
      tokenAccounts.set(accessToken, account.id);
      return { ...account, accessToken, scopes: fake.scopes.get(code) ?? DEFAULT_SCOPES };
    },
    async lookupUser(login) {
      if (fake.lookupError) {
        throw fake.lookupError;
      }
      const id = fake.users.get(login.toLowerCase());
      return id === undefined ? null : { id, login: login.toLowerCase() };
    },
    async lookupOrg(login) {
      if (fake.orgLookupError) {
        throw fake.orgLookupError;
      }
      const id = fake.orgs.get(login.toLowerCase());
      return id === undefined ? null : { principal: `github-org:${id}`, name: login.toLowerCase() };
    },
    async lookupTeam(accessToken, org, slug) {
      if (fake.orgLookupError) {
        throw fake.orgLookupError;
      }
      if (fake.teamLookupError) {
        throw fake.teamLookupError;
      }
      const accountId = tokenAccounts.get(accessToken);
      const orgId = fake.orgs.get(org.toLowerCase());
      const teamId = fake.teams.get(`${org}/${slug}`.toLowerCase());
      if (accountId === undefined || orgId === undefined || teamId === undefined) {
        return null;
      }
      const visible = (fake.accountGroups.get(accountId) ?? []).some((g) => g.principal === `github-org:${orgId}`);
      return visible ? { principal: `github-team:${teamId}`, name: `${org}/${slug}`.toLowerCase() } : null;
    },
    async memberships(accessToken) {
      fake.membershipCalls += 1;
      if (fake.membershipsError) {
        throw fake.membershipsError;
      }
      const accountId = tokenAccounts.get(accessToken);
      if (accountId === undefined) {
        throw new Error(`Unknown access token ${accessToken}`);
      }
      return [...(fake.accountGroups.get(accountId) ?? [])];
    },
  };
  return fake;
}

export interface BrowserStart {
  /** The `name=value` pair to send back as the cookie header. */
  cookie: string;
  state: string;
  /** The raw set-cookie header from /device/start. */
  setCookie: string;
  /** Builds the provider callback URL for this flow. */
  callbackUrl(params: { code?: string; error?: string }, provider?: string): string;
}

/** Opens the verification page, picks a provider, and returns what the provider would redirect back with. */
export async function startInBrowser(h: Harness, userCode: string, provider: string): Promise<BrowserStart> {
  const page = await h.fetch(`${SERVER_URL}/device?user_code=${encodeURIComponent(userCode)}`, { redirect: "manual" });
  if (page.status !== 200) {
    throw new Error(`GET /device returned ${page.status}`);
  }
  await page.text();
  const letters = userCode.toUpperCase().replace(/[^A-Z]/g, "");
  const start = await h.fetch(`${SERVER_URL}/device/start?user_code=${letters}&provider=${provider}`, {
    redirect: "manual",
  });
  const location = start.headers.get("location");
  const setCookie = start.headers.get("set-cookie");
  if (start.status !== 302 || !location || !setCookie) {
    throw new Error(`GET /device/start returned ${start.status} without a redirect and cookie`);
  }
  const state = new URL(location).searchParams.get("state");
  if (!state) {
    throw new Error(`No state in ${location}`);
  }
  return {
    cookie: setCookie.split(";")[0] as string,
    state,
    setCookie,
    callbackUrl(params, callbackProvider = provider) {
      const query = new URLSearchParams({ state });
      if (params.code !== undefined) query.set("code", params.code);
      if (params.error !== undefined) query.set("error", params.error);
      return `${SERVER_URL}/auth/${callbackProvider}/callback?${query}`;
    },
  };
}

/** Plays the browser through the whole approval and returns the response to the provider callback. */
export async function approveInBrowser(
  h: Harness,
  userCode: string,
  options: { provider: string; code: string; cookie?: boolean },
): Promise<Response> {
  const started = await startInBrowser(h, userCode, options.provider);
  return h.fetch(started.callbackUrl({ code: options.code }), {
    redirect: "manual",
    headers: options.cookie === false ? {} : { cookie: started.cookie },
  });
}

/**
 * Opens the OAuth consent page for `authorizeUrl`, follows the link for `provider`, and returns what the provider
 * would redirect back with, like `startInBrowser` does for the device flow.
 */
export async function startAuthorizeInBrowser(
  h: Harness,
  authorizeUrl: string,
  provider: string,
  options: { consentCookie?: boolean } = {},
): Promise<BrowserStart> {
  const page = await h.fetch(authorizeUrl, { redirect: "manual" });
  if (page.status !== 200) {
    throw new Error(`GET /oauth/authorize returned ${page.status}`);
  }
  const consentCookie = page.headers.getSetCookie().find((c) => c.startsWith("storage_consent="));
  const html = await page.text();
  const hrefs = [...html.matchAll(/href="([^"]*\/oauth\/authorize\/start\?[^"]*)"/g)].map((m) =>
    (m[1] as string).replaceAll("&amp;", "&"),
  );
  const href = hrefs.find((candidate) => new URL(candidate, SERVER_URL).searchParams.get("provider") === provider);
  if (!href) {
    throw new Error(`No /oauth/authorize/start link for ${provider} on the consent page`);
  }
  const sendConsent = options.consentCookie !== false && consentCookie !== undefined;
  const start = await h.fetch(new URL(href, SERVER_URL).toString(), {
    redirect: "manual",
    headers: sendConsent ? { cookie: (consentCookie as string).split(";")[0] as string } : {},
  });
  const location = start.headers.get("location");
  const setCookie = start.headers.getSetCookie().find((c) => c.startsWith("storage_signin=")) ?? null;
  if (start.status !== 302 || !location || !setCookie) {
    throw new Error(`GET /oauth/authorize/start returned ${start.status} without a redirect and cookie`);
  }
  const state = new URL(location).searchParams.get("state");
  if (!state) {
    throw new Error(`No state in ${location}`);
  }
  return {
    cookie: setCookie.split(";")[0] as string,
    state,
    setCookie,
    callbackUrl(params, callbackProvider = provider) {
      const query = new URLSearchParams({ state });
      if (params.code !== undefined) query.set("code", params.code);
      if (params.error !== undefined) query.set("error", params.error);
      return `${SERVER_URL}/auth/${callbackProvider}/callback?${query}`;
    },
  };
}

/** Plays the browser through consent and sign-in and returns the response to the provider callback. */
export async function authorizeInBrowser(
  h: Harness,
  authorizeUrl: string,
  options: { provider: string; code?: string; error?: string },
): Promise<Response> {
  const started = await startAuthorizeInBrowser(h, authorizeUrl, options.provider);
  return h.fetch(started.callbackUrl({ code: options.code, error: options.error }), {
    redirect: "manual",
    headers: { cookie: started.cookie },
  });
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** Signs a user in with Google through the device flow and returns their user token. */
export async function signInWithGoogle(h: Harness, code: string): Promise<string> {
  const form = (body: Record<string, string>): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const started = await h.fetch(`${SERVER_URL}/oauth/device_authorization`, form({ client_id: "storage-cli" }));
  const device = (await started.json()) as { device_code: string; user_code: string };
  const callback = await approveInBrowser(h, device.user_code, { provider: "google", code });
  if (callback.status !== 200) {
    throw new Error(`Google sign-in returned ${callback.status}`);
  }
  const token = await h.fetch(
    `${SERVER_URL}/oauth/token`,
    form({ grant_type: DEVICE_GRANT, client_id: "storage-cli", device_code: device.device_code }),
  );
  const body = (await token.json()) as { access_token?: string };
  if (token.status !== 200 || !body.access_token) {
    throw new Error(`Device token request returned ${token.status}`);
  }
  return body.access_token;
}

export interface ConnectBrowser {
  /** The `name=value` pair of the `storage_connect` cookie. */
  cookie: string;
  /** The raw set-cookie header from /connect/github/start. */
  setCookie: string;
  /** The current `state` parameter: the one sent to Google, then the one sent to GitHub. */
  state: string;
  /** Builds the callback URL for `provider` (`google` or `github`) with the current state. */
  callbackUrl(provider: "google" | "github", params: { code?: string; error?: string }): string;
}

function connectBrowser(cookie: string, setCookie: string, location: string): ConnectBrowser {
  const state = new URL(location).searchParams.get("state");
  if (!state) {
    throw new Error(`No state in ${location}`);
  }
  return {
    cookie,
    setCookie,
    state,
    callbackUrl(provider, params) {
      const query = new URLSearchParams({ state });
      if (params.code !== undefined) query.set("code", params.code);
      if (params.error !== undefined) query.set("error", params.error);
      return `${SERVER_URL}/connect/${provider}/callback?${query}`;
    },
  };
}

/** Opens a connect link and returns what Google would redirect back with. Throws unless the link redirects. */
export async function startConnectInBrowser(h: Harness, url: string): Promise<ConnectBrowser> {
  const response = await h.fetch(url, { redirect: "manual" });
  const location = response.headers.get("location");
  const setCookie = response.headers.getSetCookie().find((c) => c.startsWith("storage_connect="));
  if (response.status !== 302 || !location || !setCookie) {
    throw new Error(`GET connect link returned ${response.status} without a redirect and cookie`);
  }
  return connectBrowser(setCookie.split(";")[0] as string, setCookie, location);
}

/** Calls a connect callback as the browser would, with the flow's cookie unless `cookie` is false. */
export function connectCallback(
  h: Harness,
  browser: ConnectBrowser,
  provider: "google" | "github",
  params: { code?: string; error?: string },
  options: { cookie?: boolean } = {},
): Promise<Response> {
  return h.fetch(browser.callbackUrl(provider, params), {
    redirect: "manual",
    headers: options.cookie === false ? {} : { cookie: browser.cookie },
  });
}

/** Completes the Google step and returns the browser positioned at the GitHub step. Throws unless it redirects. */
export async function completeGoogleStep(h: Harness, browser: ConnectBrowser, code: string): Promise<ConnectBrowser> {
  const response = await connectCallback(h, browser, "google", { code });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) {
    throw new Error(`Google connect callback returned ${response.status}: ${await response.text()}`);
  }
  return connectBrowser(browser.cookie, browser.setCookie, location);
}

/**
 * Plays the browser through a whole connect: opens the link, completes Google, then GitHub. Returns the response to
 * the GitHub callback, or the first response that didn't redirect on the way there.
 */
export async function connectInBrowser(
  h: Harness,
  url: string,
  options: { googleCode: string; githubCode: string },
): Promise<Response> {
  const start = await h.fetch(url, { redirect: "manual" });
  const setCookie = start.headers.getSetCookie().find((c) => c.startsWith("storage_connect="));
  const location = start.headers.get("location");
  if (start.status !== 302 || !setCookie || !location) {
    return start;
  }
  const first = connectBrowser(setCookie.split(";")[0] as string, setCookie, location);
  const google = await connectCallback(h, first, "google", { code: options.googleCode });
  const next = google.headers.get("location");
  if (google.status !== 302 || !next) {
    return google;
  }
  const second = connectBrowser(first.cookie, first.setCookie, next);
  return connectCallback(h, second, "github", { code: options.githubCode });
}
