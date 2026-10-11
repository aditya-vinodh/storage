import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SignInError } from "../signin/providers.js";
import { githubAppClient } from "./app.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const config = {
  appId: "12345",
  slug: "storage-test",
  privateKey,
  clientId: "Iv1.test",
  clientSecret: "secret",
  webhookSecret: "test-webhook-secret-1234",
};

const START = new Date("2026-01-01T00:00:00.000Z");
const MINUTE = 60_000;

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: string | null;
}

const PULL = {
  state: "closed",
  closed_at: "2026-01-01T00:00:00.000Z",
  merged_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:01.000Z",
};

/** A fetch that answers from `respond` and records every request. */
function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : null,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, doFetch };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

function tokenResponse(token: string, expiresAt: Date) {
  return json({ token, expires_at: expiresAt.toISOString() }, { status: 201 });
}

describe("installUrl", () => {
  it("points at the app's install page with the state", () => {
    const app = githubAppClient(config, fakeFetch(() => json({})).doFetch);
    expect(app.installUrl("abc 123")).toBe("https://github.com/apps/storage-test/installations/new?state=abc%20123");
  });
});

describe("installation tokens", () => {
  it("signs an RS256 app JWT with iss, iat 60s back and exp 9 minutes ahead, verifiable with the public key", async () => {
    const { calls, doFetch } = fakeFetch((call) =>
      call.url.endsWith("/access_tokens")
        ? tokenResponse("ghs_1", new Date(START.getTime() + 60 * MINUTE))
        : json(PULL),
    );
    const app = githubAppClient(config, doFetch, () => START);
    await app.pull("77", "acme", "web", 482);

    const request = calls[0];
    expect(request?.url).toBe("https://api.github.com/app/installations/77/access_tokens");
    expect(request?.method).toBe("POST");
    const jwt = (request?.authorization ?? "").replace(/^Bearer /, "");
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({ alg: "RS256" });
    const seconds = Math.floor(START.getTime() / 1000);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.iss).toBe("12345");
    expect(claims.iat).toBe(seconds - 60);
    expect(claims.exp).toBe(seconds + 9 * 60);
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(createPublicKey(publicKey), Buffer.from(signature, "base64url"));
    expect(verified).toBe(true);
  });

  it("serves two pulls with one token request, and asks again 5 minutes before the token expires", async () => {
    let now = START;
    const expiresAt = new Date(START.getTime() + 60 * MINUTE);
    let issued = 0;
    const { calls, doFetch } = fakeFetch((call) => {
      if (call.url.endsWith("/access_tokens")) {
        issued += 1;
        return tokenResponse(`ghs_${issued}`, issued === 1 ? expiresAt : new Date(now.getTime() + 60 * MINUTE));
      }
      return json(PULL);
    });
    const app = githubAppClient(config, doFetch, () => now);
    const tokenRequests = () => calls.filter((c) => c.url.endsWith("/access_tokens")).length;

    const first = await app.pull("77", "acme", "web", 1);
    await app.pull("77", "acme", "web", 2);
    expect(tokenRequests()).toBe(1);
    const pulls = calls.filter((c) => c.url.includes("/repos/"));
    expect(pulls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/web/pulls/1",
      "https://api.github.com/repos/acme/web/pulls/2",
    ]);
    expect(pulls.every((c) => c.authorization === "Bearer ghs_1")).toBe(true);
    expect(first).toEqual({ ok: true, pull: PULL });

    now = new Date(expiresAt.getTime() - 5 * MINUTE - 1000);
    await app.pull("77", "acme", "web", 3);
    expect(tokenRequests()).toBe(1);

    now = new Date(expiresAt.getTime() - 5 * MINUTE);
    await app.pull("77", "acme", "web", 4);
    expect(tokenRequests()).toBe(2);
    expect(calls.at(-1)?.authorization).toBe("Bearer ghs_2");
  });

  it("drops the cached token on a 401 from the pulls endpoint and retries once", async () => {
    let issued = 0;
    const { calls, doFetch } = fakeFetch((call) => {
      if (call.url.endsWith("/access_tokens")) {
        issued += 1;
        return tokenResponse(`ghs_${issued}`, new Date(START.getTime() + 60 * MINUTE));
      }
      return call.authorization === "Bearer ghs_1" ? json({ message: "Bad credentials" }, { status: 401 }) : json(PULL);
    });
    const app = githubAppClient(config, doFetch, () => START);

    expect(await app.pull("77", "acme", "web", 1)).toEqual({ ok: true, pull: PULL });
    expect(issued).toBe(2);
    expect(calls.filter((c) => c.url.includes("/repos/")).map((c) => c.authorization)).toEqual([
      "Bearer ghs_1",
      "Bearer ghs_2",
    ]);
  });

  it("gives up after one retry when the 401 persists", async () => {
    let issued = 0;
    const { calls, doFetch } = fakeFetch((call) => {
      if (call.url.endsWith("/access_tokens")) {
        issued += 1;
        return tokenResponse(`ghs_${issued}`, new Date(START.getTime() + 60 * MINUTE));
      }
      return json({}, { status: 401 });
    });
    const app = githubAppClient(config, doFetch, () => START);
    expect(await app.pull("77", "acme", "web", 1)).toEqual({ ok: false, status: 401 });
    expect(calls.filter((c) => c.url.includes("/repos/"))).toHaveLength(2);
  });

  it("throws when GitHub refuses the installation token request", async () => {
    const { doFetch } = fakeFetch(() => json({ message: "Bad credentials" }, { status: 401 }));
    const app = githubAppClient(config, doFetch, () => START);
    await expect(app.pull("77", "acme", "web", 1)).rejects.toThrow();
  });
});

describe("pull", () => {
  it("returns the status of a non-2xx answer", async () => {
    for (const status of [403, 404, 500]) {
      const { doFetch } = fakeFetch((call) =>
        call.url.endsWith("/access_tokens")
          ? tokenResponse("ghs_1", new Date(START.getTime() + 60 * MINUTE))
          : json({ message: "no" }, { status }),
      );
      const app = githubAppClient(config, doFetch, () => START);
      expect(await app.pull("77", "acme", "web", 1)).toEqual({ ok: false, status });
    }
  });
});

describe("userInstallations", () => {
  const entry = (id: number, login: string, type = "Organization") => ({ id, account: { login, type } });

  it("follows Link rel=next, lowercases logins and sends the user's token", async () => {
    const { calls, doFetch } = fakeFetch((call) => {
      if (call.url.includes("page=2")) {
        return json({ installations: [entry(3, "Octo-User", "User")] });
      }
      return json(
        { installations: [entry(1, "Acme"), entry(2, "OtherCo")] },
        { headers: { link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"' } },
      );
    });
    const app = githubAppClient(config, doFetch, () => START);
    const installations = await app.userInstallations("gho_user");

    expect(installations).toEqual([
      { id: "1", account_login: "acme", account_type: "Organization" },
      { id: "2", account_login: "otherco", account_type: "Organization" },
      { id: "3", account_login: "octo-user", account_type: "User" },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.authorization === "Bearer gho_user")).toBe(true);
  });
});

describe("exchangeCode", () => {
  it("returns the user access token", async () => {
    const { calls, doFetch } = fakeFetch(() => json({ access_token: "gho_abc", token_type: "bearer" }));
    const app = githubAppClient(config, doFetch, () => START);
    expect(await app.exchangeCode("the-code")).toBe("gho_abc");
    expect(calls[0]?.body).toContain("code=the-code");
  });

  it("throws SignInError when GitHub answers with an error body", async () => {
    const { doFetch } = fakeFetch(() => json({ error: "bad_verification_code", error_description: "expired" }));
    const app = githubAppClient(config, doFetch, () => START);
    await expect(app.exchangeCode("old")).rejects.toBeInstanceOf(SignInError);
  });
});
