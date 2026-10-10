import { createHash } from "node:crypto";
import type { IdentityProvider, ProviderIdentity, SignInError } from "@storage/server";
import { type Harness, SERVER_URL } from "./harness.js";

/**
 * An identity provider that never touches the network. `accounts` maps an authorization code to the identity the
 * provider returns for it, or to a SignInError to throw. It enforces PKCE and the redirect URI like a real provider.
 */
export function fakeProvider(
  id: "github" | "google",
  accounts: Record<string, ProviderIdentity | SignInError>,
): IdentityProvider {
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
      if (redirectUri !== `${SERVER_URL}/auth/${id}/callback`) {
        throw new Error(`Unexpected redirect_uri ${redirectUri}`);
      }
      const account = accounts[code];
      if (!account) {
        throw new Error(`Unknown authorization code ${code}`);
      }
      if (account instanceof Error) {
        throw account;
      }
      return account;
    },
  };
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
