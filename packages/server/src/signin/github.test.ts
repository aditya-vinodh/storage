import { describe, expect, it } from "vitest";
import { GitHubTokenRevoked, githubConnector } from "./github.js";
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
  it("builds an authorize URL with PKCE S256 and the read:user read:org scope", () => {
    const url = new URL(githubConnector(base).authorizeUrl({ state: "st", redirectUri, codeChallenge: "chal" }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("gh-id");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("scope")).toBe("read:user read:org");
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
        if (url === "https://github.com/login/oauth/access_token")
          return json({ access_token: "gho_x", scope: "read:user,read:org" });
        if (url === "https://api.github.com/user") return json({ id: 4242, login: "octo", name: null });
        return json({}, 404);
      }),
    });
    expect(await connector.exchange(exchangeParams)).toEqual({
      id: "4242",
      login: "octo",
      accessToken: "gho_x",
      scopes: ["read:user", "read:org"],
    });
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

  it("parses the scope field of the token response, including an empty or missing one", async () => {
    const exchangeWith = (tokenBody: Record<string, unknown>) =>
      githubConnector({
        ...base,
        fetch: mockFetch((url) =>
          url === "https://github.com/login/oauth/access_token" ? json(tokenBody) : json({ id: 1, login: "octo" }),
        ),
      }).exchange(exchangeParams);
    expect((await exchangeWith({ access_token: "t", scope: "read:user" })).scopes).toEqual(["read:user"]);
    expect((await exchangeWith({ access_token: "t", scope: "" })).scopes).toEqual([]);
    expect((await exchangeWith({ access_token: "t" })).scopes).toEqual([]);
  });

  describe("lookupOrg", () => {
    it("returns the org principal by id and the org's login, using basic auth", async () => {
      let seen: { url: string; authorization: string | null } | undefined;
      const connector = githubConnector({
        ...base,
        fetch: mockFetch((url, init) => {
          seen = { url, authorization: new Headers(init?.headers).get("authorization") };
          return json({ id: 100, login: "Acme" });
        }),
      });
      expect(await connector.lookupOrg("acme")).toEqual({ principal: "github-org:100", name: "Acme" });
      expect(seen?.url).toBe("https://api.github.com/orgs/acme");
      expect(seen?.authorization).toBe(`Basic ${Buffer.from("gh-id:gh-secret").toString("base64")}`);
    });

    it("returns null for a 404 and throws for anything else", async () => {
      const missing = githubConnector({ ...base, fetch: mockFetch(() => json({}, 404)) });
      expect(await missing.lookupOrg("nobody")).toBeNull();
      const broken = githubConnector({ ...base, fetch: mockFetch(() => json({}, 500)) });
      await expect(broken.lookupOrg("acme")).rejects.toThrow("500");
    });
  });

  describe("lookupTeam", () => {
    it("returns the team principal and org/slug name using the user's token", async () => {
      let seen: { url: string; authorization: string | null } | undefined;
      const connector = githubConnector({
        ...base,
        fetch: mockFetch((url, init) => {
          seen = { url, authorization: new Headers(init?.headers).get("authorization") };
          return json({ id: 200, slug: "frontend", organization: { login: "Acme" } });
        }),
      });
      expect(await connector.lookupTeam("gho_tok", "acme", "frontend")).toEqual({
        principal: "github-team:200",
        name: "Acme/frontend",
      });
      expect(seen?.url).toBe("https://api.github.com/orgs/acme/teams/frontend");
      expect(seen?.authorization).toBe("Bearer gho_tok");
    });

    it("returns null for 404 and for 403", async () => {
      for (const status of [404, 403]) {
        const connector = githubConnector({ ...base, fetch: mockFetch(() => json({}, status)) });
        expect(await connector.lookupTeam("gho_tok", "acme", "frontend")).toBeNull();
      }
    });

    it("throws GitHubTokenRevoked for 401 and a plain error for anything else", async () => {
      const revoked = githubConnector({ ...base, fetch: mockFetch(() => json({}, 401)) });
      await expect(revoked.lookupTeam("gho_tok", "acme", "frontend")).rejects.toBeInstanceOf(GitHubTokenRevoked);
      const broken = githubConnector({ ...base, fetch: mockFetch(() => json({}, 500)) });
      const error = await broken.lookupTeam("gho_tok", "acme", "frontend").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(GitHubTokenRevoked);
      expect((error as Error).message).toContain("500");
    });
  });

  describe("memberships", () => {
    const orgsUrl = "https://api.github.com/user/memberships/orgs?state=active&per_page=100";
    const teamsUrl = "https://api.github.com/user/teams?per_page=100";
    const org = (id: number, login: string, state = "active") => ({ state, organization: { id, login } });
    const team = (id: number, slug: string, orgLogin: string) => ({ id, slug, organization: { login: orgLogin } });
    const link = (next: string) => ({ link: `<${next}>; rel="next", <${next}>; rel="last"` });
    const jsonWith = (body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

    it("returns org and team groups, sending the user's token", async () => {
      const auth = new Set<string | null>();
      const connector = githubConnector({
        ...base,
        fetch: mockFetch((url, init) => {
          auth.add(new Headers(init?.headers).get("authorization"));
          if (url === orgsUrl) return jsonWith([org(100, "acme")]);
          if (url === teamsUrl) return jsonWith([team(200, "frontend", "acme")]);
          return json({}, 404);
        }),
      });
      const groups = await connector.memberships("gho_tok");
      expect(groups).toHaveLength(2);
      expect(groups).toContainEqual({ principal: "github-org:100", name: "acme" });
      expect(groups).toContainEqual({ principal: "github-team:200", name: "acme/frontend" });
      expect([...auth]).toEqual(["Bearer gho_tok"]);
    });

    it("follows Link rel=next for both orgs and teams", async () => {
      const orgsNext = "https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=2";
      const teamsNext = "https://api.github.com/user/teams?per_page=100&page=2";
      const seen: string[] = [];
      const connector = githubConnector({
        ...base,
        fetch: mockFetch((url) => {
          seen.push(url);
          if (url === orgsUrl) return jsonWith([org(1, "a")], link(orgsNext));
          if (url === orgsNext) return jsonWith([org(2, "b")]);
          if (url === teamsUrl) return jsonWith([team(10, "x", "a")], link(teamsNext));
          if (url === teamsNext) return jsonWith([team(11, "y", "b")]);
          return json({}, 404);
        }),
      });
      const groups = await connector.memberships("gho_tok");
      expect(groups.map((g) => g.principal).sort()).toEqual([
        "github-org:1",
        "github-org:2",
        "github-team:10",
        "github-team:11",
      ]);
      expect(seen).toEqual(expect.arrayContaining([orgsUrl, orgsNext, teamsUrl, teamsNext]));
    });

    it("stops following Link after 10 pages", async () => {
      let orgCalls = 0;
      const connector = githubConnector({
        ...base,
        fetch: mockFetch((url) => {
          if (url.includes("/user/teams")) return jsonWith([]);
          orgCalls += 1;
          return jsonWith([org(orgCalls, `o${orgCalls}`)], link(`${orgsUrl}&page=${orgCalls + 1}`));
        }),
      });
      const groups = await connector.memberships("gho_tok");
      expect(orgCalls).toBe(10);
      expect(groups).toHaveLength(10);
    });

    it("refuses a next page off api.github.com, without sending the token there", async () => {
      const seen: string[] = [];
      const connector = githubConnector({
        ...base,
        fetch: mockFetch((url) => {
          seen.push(url);
          if (url === orgsUrl) return jsonWith([org(1, "a")], link("https://evil.test/user/memberships/orgs?page=2"));
          return jsonWith([]);
        }),
      });
      const error = await connector.memberships("gho_tok").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(GitHubTokenRevoked);
      expect(seen.some((url) => url.startsWith("https://evil.test"))).toBe(false);
    });

    it("skips org entries whose state isn't active", async () => {
      const connector = githubConnector({
        ...base,
        fetch: mockFetch((url) =>
          url === orgsUrl ? jsonWith([org(1, "active-org"), org(2, "invited-org", "pending")]) : jsonWith([]),
        ),
      });
      expect(await connector.memberships("gho_tok")).toEqual([{ principal: "github-org:1", name: "active-org" }]);
    });

    it("throws GitHubTokenRevoked on 401 from either endpoint", async () => {
      for (const failing of [orgsUrl, teamsUrl]) {
        const connector = githubConnector({
          ...base,
          fetch: mockFetch((url) => (url === failing ? json({}, 401) : jsonWith([]))),
        });
        await expect(connector.memberships("gho_tok")).rejects.toBeInstanceOf(GitHubTokenRevoked);
      }
    });

    it("throws a plain error on any other failure", async () => {
      const connector = githubConnector({ ...base, fetch: mockFetch(() => json({}, 500)) });
      const error = await connector.memberships("gho_tok").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(GitHubTokenRevoked);
    });
  });
});
