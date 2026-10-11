import type { ServerConfig } from "../config.js";

export type ProviderId = "github" | "google";

export interface ProviderIdentity {
  provider: ProviderId;
  /** Stable account id at the provider: GitHub's numeric user id as a string, Google's `sub`. */
  subject: string;
  /** A verified email address, lowercased. */
  email: string;
  name: string | null;
}

export interface SignInProvider {
  id: ProviderId;
  /** Button label, e.g. "GitHub". */
  label: string;
  authorizeUrl(params: { state: string; redirectUri: string; codeChallenge: string }): string;
  /** Throws SignInError (message safe to show the user) when this account can't sign in; other errors are unexpected. */
  exchange(params: { code: string; redirectUri: string; codeVerifier: string }): Promise<ProviderIdentity>;
}

/** A sign-in the provider completed but this server refuses. The message is safe to show the user. */
export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

export interface ClientOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

export function formBody(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

export async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** A Google email is trusted when Google manages the address: a Workspace account (`hd` claim) or a Gmail address. */
export function isTrustedGoogleEmail(email: string, hd: string | null): boolean {
  if (hd !== null && hd !== "") {
    return true;
  }
  const lower = email.toLowerCase();
  return lower.endsWith("@gmail.com") || lower.endsWith("@googlemail.com");
}

function rejectedIdToken(): SignInError {
  return new SignInError("Google returned an ID token this server can't accept.");
}

export function googleProvider(
  options: ClientOptions & { allowedDomains: string[] | null; now?: () => Date },
): SignInProvider {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const { allowedDomains } = options;

  return {
    id: "google",
    label: "Google",
    authorizeUrl({ state, redirectUri, codeChallenge }) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("prompt", "select_account");
      // A hint only; the hd claim is checked after sign-in.
      if (allowedDomains?.length === 1) {
        url.searchParams.set("hd", allowedDomains[0] as string);
      }
      return url.toString();
    },
    async exchange({ code, redirectUri, codeVerifier }) {
      const response = await doFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: formBody({
          code,
          client_id: options.clientId,
          client_secret: options.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: codeVerifier,
        }),
      });
      const body = await readJson(response);
      const idToken = text(body?.id_token);
      if (!response.ok || idToken === undefined) {
        const reason = text(body?.error_description) ?? text(body?.error) ?? String(response.status);
        throw new SignInError(`Google sign-in failed: ${reason}.`);
      }

      // The ID token comes straight from Google's token endpoint over TLS, so its signature isn't checked
      // (OpenID Connect Core §3.1.3.7). The claims are still validated.
      let claims: Record<string, unknown>;
      try {
        const payload = idToken.split(".")[1];
        const parsed: unknown = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw rejectedIdToken();
        }
        claims = parsed as Record<string, unknown>;
      } catch {
        throw rejectedIdToken();
      }

      const { aud, azp, exp, sub, email } = claims;
      const audienceOk = Array.isArray(aud)
        ? aud.includes(options.clientId) && azp === options.clientId
        : aud === options.clientId;
      if (
        !GOOGLE_ISSUERS.includes(claims.iss as string) ||
        !audienceOk ||
        typeof exp !== "number" ||
        exp * 1000 <= now().getTime() ||
        typeof sub !== "string" ||
        sub === "" ||
        typeof email !== "string"
      ) {
        throw rejectedIdToken();
      }
      if (claims.email_verified !== true) {
        throw new SignInError("Your Google account's email address isn't verified.");
      }
      const hd = typeof claims.hd === "string" && claims.hd !== "" ? claims.hd : null;
      if (!isTrustedGoogleEmail(email, hd)) {
        throw new SignInError(
          `Sign in with a Gmail or Google Workspace account. ${email.toLowerCase()} is a Google account on an address Google doesn't manage.`,
        );
      }
      if (allowedDomains !== null) {
        if (hd === null || !allowedDomains.includes(hd.toLowerCase())) {
          throw new SignInError(`Sign-in is limited to Google Workspace accounts on ${allowedDomains.join(", ")}.`);
        }
      }
      return {
        provider: "google",
        subject: sub,
        email: email.toLowerCase(),
        name: typeof claims.name === "string" && claims.name !== "" ? claims.name : null,
      };
    },
  };
}

/** The providers users can sign in with: Google only, when configured. */
export function providersFromConfig(signIn: ServerConfig["signIn"]): SignInProvider[] {
  return signIn.google ? [googleProvider(signIn.google)] : [];
}
