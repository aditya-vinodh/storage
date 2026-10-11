import { describe, expect, it } from "vitest";
import { googleProvider, isTrustedGoogleEmail, SignInError } from "./providers.js";

type Handler = (url: string, init: RequestInit | undefined) => Response;

function mockFetch(handler: Handler): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const redirectUri = "http://storage.test/auth/github/callback";
const exchangeParams = { code: "c", redirectUri, codeVerifier: "v" };

describe("googleProvider", () => {
  const NOW = new Date("2026-01-01T00:00:00Z");
  const nowSeconds = Math.floor(NOW.getTime() / 1000);
  const base = { clientId: "g-id", clientSecret: "g-secret", allowedDomains: null, now: () => NOW };

  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const idToken = (claims: Record<string, unknown>) =>
    `${b64({ alg: "none" })}.${b64({
      iss: "https://accounts.google.com",
      aud: "g-id",
      exp: nowSeconds + 300,
      sub: "g-sub-1",
      email: "Pat@Gmail.com",
      email_verified: true,
      name: "Pat",
      ...claims,
    })}.sig`;

  const googleFetch = (token: string) => mockFetch(() => json({ id_token: token }));

  const exchange = (claims: Record<string, unknown>, options: { allowedDomains?: string[] | null } = {}) =>
    googleProvider({ ...base, ...options, fetch: googleFetch(idToken(claims)) }).exchange(exchangeParams);

  it("returns the identity from a valid ID token", async () => {
    const identity = await exchange({});
    expect(identity).toMatchObject({ provider: "google", subject: "g-sub-1", name: "Pat" });
    expect(identity.email.toLowerCase()).toBe("pat@gmail.com");
  });

  it("rejects a wrong audience", async () => {
    await expect(exchange({ aud: "someone-else" })).rejects.toBeInstanceOf(SignInError);
  });

  it("rejects a wrong issuer", async () => {
    await expect(exchange({ iss: "https://evil.example" })).rejects.toBeInstanceOf(SignInError);
  });

  it("rejects an expired token", async () => {
    await expect(exchange({ exp: nowSeconds - 1 })).rejects.toBeInstanceOf(SignInError);
  });

  it("rejects an unverified email", async () => {
    await expect(exchange({ email_verified: false })).rejects.toBeInstanceOf(SignInError);
  });

  it("accepts the allowed hosted domain", async () => {
    const identity = await exchange({ hd: "acme.com" }, { allowedDomains: ["acme.com"] });
    expect(identity.subject).toBe("g-sub-1");
  });

  it("rejects another or a missing hosted domain when domains are restricted", async () => {
    await expect(exchange({ hd: "other.com" }, { allowedDomains: ["acme.com"] })).rejects.toBeInstanceOf(SignInError);
    await expect(exchange({}, { allowedDomains: ["acme.com"] })).rejects.toBeInstanceOf(SignInError);
  });

  it("adds an hd hint to the authorize URL for exactly one allowed domain", () => {
    const params = { state: "st", redirectUri, codeChallenge: "chal" };
    const one = new URL(googleProvider({ ...base, allowedDomains: ["acme.com"] }).authorizeUrl(params));
    expect(one.searchParams.get("hd")).toBe("acme.com");
    expect(one.searchParams.get("code_challenge_method")).toBe("S256");
    const none = new URL(googleProvider(base).authorizeUrl(params));
    expect(none.searchParams.has("hd")).toBe(false);
  });

  it("refuses a Google account on an address Google doesn't manage", async () => {
    const error = await exchange({ email: "bob@acme.com" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignInError);
    expect((error as Error).message).toContain("Gmail or Google Workspace");
  });

  it("accepts a non-Gmail address with an hd claim when domains aren't restricted", async () => {
    const identity = await exchange({ email: "bob@acme.com", hd: "acme.com" }, { allowedDomains: null });
    expect(identity).toMatchObject({ provider: "google", subject: "g-sub-1", email: "bob@acme.com" });
  });
});

describe("isTrustedGoogleEmail", () => {
  it.each([
    ["alice@gmail.com", null, true],
    ["Alice@GoogleMail.com", null, true],
    ["alice@acme.com", "acme.com", true],
    ["alice@acme.co.uk", "acme.com", true],
    ["bob@acme.com", null, false],
    ["alice@gmail.com", "acme.com", true],
  ] as const)("(%s, %s) -> %s", (email, hd, expected) => {
    expect(isTrustedGoogleEmail(email, hd)).toBe(expected);
  });
});
