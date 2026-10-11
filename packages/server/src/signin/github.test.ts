import { describe, expect, it } from "vitest";
import { githubConnector } from "./github.js";
import { SignInError } from "./providers.js";

type Handler = (url: string, init: RequestInit | undefined) => Response;

function mockFetch(handler: Handler): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const redirectUri = "http://storage.test/connect/github/callback";
const exchangeParams = { code: "c", redirectUri, codeVerifier: "v" };
const base = { clientId: "gh-id", clientSecret: "gh-secret" };

describe("githubConnector", () => {
  it("builds an authorize URL with PKCE S256 and the read:user scope", () => {
    const url = new URL(githubConnector(base).authorizeUrl({ state: "st", redirectUri, codeChallenge: "chal" }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("gh-id");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("scope")).toBe("read:user");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges a code for the account id and login without reading emails", async () => {
    const urls: string[] = [];
    const connector = githubConnector({
      ...base,
      fetch: mockFetch((url) => {
        urls.push(url);
        if (url === "https://github.com/login/oauth/access_token") return json({ access_token: "gho_x" });
        if (url === "https://api.github.com/user") return json({ id: 4242, login: "octo", name: null });
        return json({}, 404);
      }),
    });
    expect(await connector.exchange(exchangeParams)).toEqual({ id: "4242", login: "octo" });
    expect(urls).not.toContain("https://api.github.com/user/emails");
  });

  it("rejects a token response with an error", async () => {
    const connector = githubConnector({
      ...base,
      fetch: mockFetch(() => json({ error: "bad_verification_code", error_description: "The code is bad." })),
    });
    const error = await connector.exchange(exchangeParams).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignInError);
    expect((error as Error).message).toContain("The code is bad.");
  });

  describe("lookupUser", () => {
    it("returns the account for a 200", async () => {
      const connector = githubConnector({ ...base, fetch: mockFetch(() => json({ id: 42, login: "Octo" })) });
      expect(await connector.lookupUser("octo")).toEqual({ id: "42", login: "Octo" });
    });

    it("returns null for a 404", async () => {
      const connector = githubConnector({ ...base, fetch: mockFetch(() => json({ message: "Not Found" }, 404)) });
      expect(await connector.lookupUser("nobody")).toBeNull();
    });

    it("throws for any other failure", async () => {
      const connector = githubConnector({ ...base, fetch: mockFetch(() => json({}, 500)) });
      await expect(connector.lookupUser("octo")).rejects.toThrow("500");
    });

    it("sends basic auth with the client id and secret", async () => {
      let seen: { url: string; authorization: string | null } | undefined;
      const connector = githubConnector({
        ...base,
        fetch: mockFetch((url, init) => {
          seen = { url, authorization: new Headers(init?.headers).get("authorization") };
          return json({ id: 42, login: "octo" });
        }),
      });
      await connector.lookupUser("octo");
      expect(seen?.url).toBe("https://api.github.com/users/octo");
      expect(seen?.authorization).toBe(`Basic ${Buffer.from("gh-id:gh-secret").toString("base64")}`);
    });
  });
});
