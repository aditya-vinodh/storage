import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runOperation } from "@storage/client";
import { ops, StorageError } from "@storage/core";
import { SignInError } from "@storage/server";
import { afterEach, describe, expect, it } from "vitest";
import { approveInBrowser, authorizeInBrowser, fakeProvider, startAuthorizeInBrowser } from "./fake-idp.js";
import { createHarness, type Harness, SERVER_URL } from "./harness.js";

let h: Harness | undefined;
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await h?.cleanup();
  h = undefined;
});

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REDIRECT = "https://client.example/callback";
const LOOPBACK = "http://127.0.0.1:33418/cb";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

const accounts = {
  alice: { provider: "google" as const, subject: "g-1001", email: "alice@gmail.com", name: "Alice" },
  "alice-other-sub": { provider: "google" as const, subject: "g-2001", email: "alice@gmail.com", name: "Alice" },
  refused: new SignInError("Account can't sign in."),
};

async function setup(): Promise<Harness> {
  h = await createHarness({
    signIn: { providers: [fakeProvider("google", accounts)] },
  });
  return h;
}

function form(body: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  };
}

interface Json {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

async function postJson(harness: Harness, path: string, body: unknown): Promise<Json> {
  const response = await harness.fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, unknown>,
  };
}

const register = (harness: Harness, body: Record<string, unknown>) => postJson(harness, "/oauth/register", body);

async function registerClient(
  harness: Harness,
  extra: Record<string, unknown> = {},
  redirectUris: string[] = [REDIRECT, LOOPBACK],
): Promise<string> {
  const result = await register(harness, { redirect_uris: redirectUris, client_name: "Cursor", ...extra });
  expect(result.status).toBe(201);
  return result.body.client_id as string;
}

function authorizeUrl(clientId: string, overrides: Record<string, string | undefined> = {}): string {
  const params: Record<string, string | undefined> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "client-state-1",
    ...overrides,
  };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  return `${SERVER_URL}/oauth/authorize?${query}`;
}

/** Runs authorize, consent and sign-in as alice, and returns the code from the redirect back to the client. */
async function getCode(
  harness: Harness,
  clientId: string,
  overrides: Record<string, string | undefined> = {},
): Promise<{ code: string; state: string | null; iss: string | null; response: Response }> {
  const response = await authorizeInBrowser(harness, authorizeUrl(clientId, overrides), {
    provider: "google",
    code: "alice",
  });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") as string);
  const code = location.searchParams.get("code");
  expect(code).toEqual(expect.any(String));
  return {
    code: code as string,
    state: location.searchParams.get("state"),
    iss: location.searchParams.get("iss"),
    response,
  };
}

async function tokenRequest(harness: Harness, body: Record<string, string>): Promise<Json> {
  const response = await harness.fetch(`${SERVER_URL}/oauth/token`, form(body));
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, unknown>,
  };
}

const exchange = (harness: Harness, clientId: string, code: string, extra: Record<string, string> = {}) =>
  tokenRequest(harness, {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    ...extra,
  });

const refresh = (harness: Harness, clientId: string, refreshToken: string) =>
  tokenRequest(harness, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });

interface Grant {
  clientId: string;
  access: string;
  refreshToken: string;
}

async function grant(harness: Harness): Promise<Grant> {
  const clientId = await registerClient(harness);
  const { code } = await getCode(harness, clientId);
  const token = await exchange(harness, clientId, code);
  expect(token.status).toBe(200);
  return {
    clientId,
    access: token.body.access_token as string,
    refreshToken: token.body.refresh_token as string,
  };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

async function mcpPost(harness: Harness, token?: string): Promise<Response> {
  return harness.fetch(`${SERVER_URL}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(INITIALIZE),
  });
}

async function mcpStatus(harness: Harness, token: string): Promise<number> {
  const response = await mcpPost(harness, token);
  await response.text();
  return response.status;
}

async function mcpWhoami(harness: Harness, token: string): Promise<string> {
  const transport = new StreamableHTTPClientTransport(new URL(`${SERVER_URL}/mcp`), {
    fetch: harness.fetch,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(transport);
  clients.push(c);
  const result = (await c.callTool({ name: "whoami", arguments: {} })) as { structuredContent?: { principal: string } };
  return result.structuredContent?.principal as string;
}

/** A device-flow login for alice: an unscoped user token for the same account. */
async function loginToken(harness: Harness): Promise<string> {
  const start = await harness.fetch(`${SERVER_URL}/oauth/device_authorization`, form({ client_id: "storage-cli" }));
  const device = (await start.json()) as { device_code: string; user_code: string };
  const callback = await approveInBrowser(harness, device.user_code, { provider: "google", code: "alice" });
  expect(callback.status).toBe(200);
  harness.advance(6_000);
  const token = await tokenRequest(harness, {
    grant_type: DEVICE_GRANT,
    client_id: "storage-cli",
    device_code: device.device_code,
  });
  expect(token.status).toBe(200);
  return token.body.access_token as string;
}

async function expectError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error(`Expected a ${code} error`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StorageError);
  expect((error as StorageError).code).toBe(code);
}

describe("discovery", () => {
  it("serves protected resource metadata at both well-known paths", async () => {
    const harness = await setup();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await harness.fetch(`${SERVER_URL}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        resource: `${SERVER_URL}/mcp`,
        authorization_servers: [SERVER_URL],
        bearer_methods_supported: ["header"],
      });
    }
  });

  it("serves authorization server metadata", async () => {
    const harness = await setup();
    const response = await harness.fetch(`${SERVER_URL}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issuer: SERVER_URL,
      authorization_endpoint: `${SERVER_URL}/oauth/authorize`,
      token_endpoint: `${SERVER_URL}/oauth/token`,
      registration_endpoint: `${SERVER_URL}/oauth/register`,
      device_authorization_endpoint: `${SERVER_URL}/oauth/device_authorization`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("answers 404 on all discovery URLs when sign-in isn't configured", async () => {
    h = await createHarness();
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
    ]) {
      const response = await h.fetch(`${SERVER_URL}${path}`);
      expect(response.status).toBe(404);
    }
  });

  it("points unauthenticated /mcp callers at the resource metadata only when sign-in is configured", async () => {
    const harness = await setup();
    const response = await mcpPost(harness);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${SERVER_URL}/.well-known/oauth-protected-resource"`,
    );
    await harness.cleanup();

    h = await createHarness();
    const plain = await mcpPost(h);
    expect(plain.status).toBe(401);
    expect(plain.headers.get("www-authenticate")).not.toContain("resource_metadata");
  });

  it("allows cross-origin access to the OAuth endpoints", async () => {
    const harness = await setup();
    const preflight = await harness.fetch(`${SERVER_URL}/oauth/token`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    const metadata = await harness.fetch(`${SERVER_URL}/.well-known/oauth-authorization-server`);
    expect(metadata.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("dynamic client registration", () => {
  it("registers a public client", async () => {
    const harness = await setup();
    const result = await register(harness, { redirect_uris: [REDIRECT], client_name: "Cursor" });
    expect(result.status).toBe(201);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.body.client_id).toMatch(/^mcp_/);
    expect(result.body.redirect_uris).toEqual([REDIRECT]);
    expect(result.body.token_endpoint_auth_method).toBe("none");
    expect(result.body.grant_types).toEqual(["authorization_code", "refresh_token"]);
  });

  it("rejects unsafe or malformed redirect URIs with invalid_redirect_uri", async () => {
    const harness = await setup();
    const bodies: unknown[] = [
      { redirect_uris: ["http://evil.example/cb"] },
      { redirect_uris: ["javascript:alert(1)"] },
      { redirect_uris: ["https://a.example/cb#frag"] },
      { redirect_uris: [] },
      {},
    ];
    for (const body of bodies) {
      const result = await register(harness, body as Record<string, unknown>);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(result.body.error, JSON.stringify(body)).toBe("invalid_redirect_uri");
    }
  });

  it("accepts loopback and private-use scheme redirect URIs", async () => {
    const harness = await setup();
    for (const uri of [
      "http://localhost:8080/cb",
      "http://[::1]:9/cb",
      "cursor://anysphere.cursor-retrieval/oauth/callback",
    ]) {
      const result = await register(harness, { redirect_uris: [uri] });
      expect(result.status, uri).toBe(201);
      expect(result.body.redirect_uris).toEqual([uri]);
    }
  });

  it("rejects client authentication methods other than none", async () => {
    const harness = await setup();
    const result = await register(harness, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_client_metadata");
  });
});

describe("authorization endpoint", () => {
  it("shows an error page instead of redirecting for an unknown client or unregistered redirect_uri", async () => {
    const harness = await setup();
    const unknown = await harness.fetch(authorizeUrl("mcp_nope"), { redirect: "manual" });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("location")).toBeNull();
    expect(unknown.headers.get("content-type")).toContain("text/html");

    const clientId = await registerClient(harness);
    const wrongUri = await harness.fetch(authorizeUrl(clientId, { redirect_uri: "https://evil.example/callback" }), {
      redirect: "manual",
    });
    expect(wrongUri.status).toBe(400);
    expect(wrongUri.headers.get("location")).toBeNull();
  });

  it("redirects request errors to the client with its state and the issuer", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ code_challenge: undefined }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ resource: "https://other.example/mcp" }, "invalid_target"],
    ];
    for (const [overrides, error] of cases) {
      const response = await harness.fetch(authorizeUrl(clientId, overrides), { redirect: "manual" });
      expect(response.status, error).toBe(302);
      const location = new URL(response.headers.get("location") as string);
      expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
      expect(location.searchParams.get("error")).toBe(error);
      expect(location.searchParams.get("state")).toBe("client-state-1");
      expect(location.searchParams.get("iss")).toBe(SERVER_URL);
    }
  });

  it("renders a consent page that escapes the client name and offers only Google", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness, { client_name: "<b>Evil</b>" });
    const response = await harness.fetch(authorizeUrl(clientId), { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await response.text();
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>Evil");
    expect(html).toContain("client.example");
    expect(html).toMatch(/\/oauth\/authorize\/start\?request=[^"]*provider=google/);
    expect(html).not.toMatch(/provider=github/);
  });
});

describe("authorization code flow", () => {
  it("issues a code, exchanges it for tokens, and the access token works at /mcp as the signed-in user", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const { code, state, iss, response } = await getCode(harness, clientId);
    expect(state).toBe("client-state-1");
    expect(iss).toBe(SERVER_URL);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const token = await exchange(harness, clientId, code);
    expect(token.status).toBe(200);
    expect(token.body.access_token).toMatch(/^storage_pat_/);
    expect(token.body.refresh_token).toMatch(/^storage_rt_/);
    expect(token.body.token_type).toBe("Bearer");
    expect(token.body.expires_in).toBe(3600);

    expect(await mcpStatus(harness, token.body.access_token as string)).toBe(200);
    const login = await loginToken(harness);
    const me = await runOperation(ops.whoami, {}, harness.runner(login));
    expect(await mcpWhoami(harness, token.body.access_token as string)).toBe(me.principal);
  });

  it("supports a loopback redirect URI", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const response = await authorizeInBrowser(harness, authorizeUrl(clientId, { redirect_uri: LOOPBACK }), {
      provider: "google",
      code: "alice",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") as string);
    expect(location.origin + location.pathname).toBe(LOOPBACK);
    expect(location.searchParams.get("code")).toEqual(expect.any(String));
  });

  it("rejects the access token on /v1/ops", async () => {
    const harness = await setup();
    const { access } = await grant(harness);
    await expectError(runOperation(ops.whoami, {}, harness.runner(access)), "unauthenticated");
  });

  it("accepts a code only once and revokes the token issued from a replayed code", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const { code } = await getCode(harness, clientId);
    const first = await exchange(harness, clientId, code);
    expect(first.status).toBe(200);
    const access = first.body.access_token as string;
    expect(await mcpStatus(harness, access)).toBe(200);

    const second = await exchange(harness, clientId, code);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe("invalid_grant");
    expect(await mcpStatus(harness, access)).toBe(401);
  });

  it("rejects a wrong code_verifier", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const { code } = await getCode(harness, clientId);
    const result = await exchange(harness, clientId, code, { code_verifier: `${VERIFIER.slice(1)}x` });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_grant");
  });

  it("rejects a different redirect_uri at the token endpoint", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const { code } = await getCode(harness, clientId);
    const result = await exchange(harness, clientId, code, { redirect_uri: LOOPBACK });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_grant");
  });

  it("rejects a code presented by another registered client", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const other = await registerClient(harness, { client_name: "Other" });
    const { code } = await getCode(harness, clientId);
    const result = await exchange(harness, other, code);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_grant");
  });

  it("rejects an unknown client_id with 401 invalid_client", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const { code } = await getCode(harness, clientId);
    const result = await exchange(harness, "mcp_unknown", code);
    expect(result.status).toBe(401);
    expect(result.body.error).toBe("invalid_client");
  });

  it("rejects a code used after 60 seconds", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const { code } = await getCode(harness, clientId);
    harness.advance(61_000);
    const result = await exchange(harness, clientId, code);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_grant");
  });

  it("redirects access_denied to the client when the provider reports an error", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const response = await authorizeInBrowser(harness, authorizeUrl(clientId), {
      provider: "google",
      error: "access_denied",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") as string);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("client-state-1");
  });

  it("redirects access_denied with a description when the account can't sign in", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const response = await authorizeInBrowser(harness, authorizeUrl(clientId), { provider: "google", code: "refused" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") as string);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toEqual(expect.any(String));
    expect(location.searchParams.get("state")).toBe("client-state-1");
  });
});

/** Renders the consent page and returns its provider link and consent cookie without following the link. */
async function openConsent(harness: Harness, clientId: string, provider = "google") {
  const page = await harness.fetch(authorizeUrl(clientId), { redirect: "manual" });
  expect(page.status).toBe(200);
  const cookie = page.headers
    .getSetCookie()
    .find((c) => c.startsWith("storage_consent="))
    ?.split(";")[0];
  const html = await page.text();
  const hrefs = [...html.matchAll(/href="([^"]*\/oauth\/authorize\/start\?[^"]*)"/g)].map((m) =>
    new URL((m[1] as string).replaceAll("&amp;", "&"), SERVER_URL).toString(),
  );
  const href = hrefs.find((u) => new URL(u).searchParams.get("provider") === provider) as string;
  expect(href).toBeDefined();
  return { href, cookie };
}

describe("account linking", () => {
  it("redirects access_denied and issues no token when another Google account holds the email", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    await getCode(harness, clientId);
    const response = await authorizeInBrowser(harness, authorizeUrl(clientId), {
      provider: "google",
      code: "alice-other-sub",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") as string);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
    const rows = await harness.db.selectFrom("identities").select("subject").execute();
    expect(rows).toEqual([{ subject: "g-1001" }]);
  });
});

describe("consent binding", () => {
  it("rejects the start link without the consent cookie", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const { href } = await openConsent(harness, clientId);
    const response = await harness.fetch(href, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects a consent cookie from a different authorization request", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const a = await openConsent(harness, clientId);
    const b = await openConsent(harness, clientId);
    expect(a.cookie).toBeDefined();
    const response = await harness.fetch(a.href, {
      redirect: "manual",
      headers: { cookie: b.cookie as string },
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects the consent link after the request expires", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const { href, cookie } = await openConsent(harness, clientId);
    harness.advance(601_000);
    const response = await harness.fetch(href, { redirect: "manual", headers: cookie ? { cookie } : {} });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects replaying the provider callback", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const started = await startAuthorizeInBrowser(harness, authorizeUrl(clientId), "google");
    const url = started.callbackUrl({ code: "alice" });
    const init = { redirect: "manual", headers: { cookie: started.cookie } } as const;
    expect((await harness.fetch(url, init)).status).toBe(302);
    expect((await harness.fetch(url, init)).status).toBe(400);
  });
});

describe("resource, grants and size limits", () => {
  it("accepts the MCP resource at authorize and rejects another at the token endpoint", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness);
    const page = await harness.fetch(authorizeUrl(clientId, { resource: `${SERVER_URL}/mcp` }), {
      redirect: "manual",
    });
    expect(page.status).toBe(200);
    await page.text();

    const { code } = await getCode(harness, clientId);
    const result = await exchange(harness, clientId, code, { resource: "https://other.example/mcp" });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_target");
  });

  it("rejects the refresh_token grant for a client registered without it", async () => {
    const harness = await setup();
    const clientId = await registerClient(harness, { grant_types: ["authorization_code"] });
    const result = await refresh(harness, clientId, "storage_rt_whatever");
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("unauthorized_client");
  });

  it("rejects a registration body over 16 KiB with 413", async () => {
    const harness = await setup();
    const response = await harness.fetch(`${SERVER_URL}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "x".repeat(17 * 1024) }),
    });
    expect(response.status).toBe(413);
  });
});

describe("refresh tokens", () => {
  it("rotates both tokens in place, keeping one token row", async () => {
    const harness = await setup();
    const login = await loginToken(harness);
    const first = await grant(harness);
    const listBefore = await runOperation(ops.tokenList, {}, harness.runner(login));
    const before = listBefore.tokens.filter((t) => t.name?.startsWith("MCP: "));
    expect(before).toHaveLength(1);
    expect(before[0]?.name).toBe("MCP: Cursor");

    const result = await refresh(harness, first.clientId, first.refreshToken);
    expect(result.status).toBe(200);
    expect(result.body.access_token).toMatch(/^storage_pat_/);
    expect(result.body.refresh_token).toMatch(/^storage_rt_/);
    expect(result.body.access_token).not.toBe(first.access);
    expect(result.body.refresh_token).not.toBe(first.refreshToken);

    expect(await mcpStatus(harness, first.access)).toBe(401);
    expect(await mcpStatus(harness, result.body.access_token as string)).toBe(200);

    const listAfter = await runOperation(ops.tokenList, {}, harness.runner(login));
    const after = listAfter.tokens.filter((t) => t.name?.startsWith("MCP: "));
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
  });

  it("revokes the whole grant when a used refresh token is replayed", async () => {
    const harness = await setup();
    const first = await grant(harness);
    const rotated = await refresh(harness, first.clientId, first.refreshToken);
    expect(rotated.status).toBe(200);

    const replay = await refresh(harness, first.clientId, first.refreshToken);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");

    expect(await mcpStatus(harness, rotated.body.access_token as string)).toBe(401);
    const newest = await refresh(harness, first.clientId, rotated.body.refresh_token as string);
    expect(newest.status).toBe(400);
    expect(newest.body.error).toBe("invalid_grant");
  });

  it("expires the access token after an hour but still refreshes", async () => {
    const harness = await setup();
    const first = await grant(harness);
    harness.advance(3601_000);
    expect(await mcpStatus(harness, first.access)).toBe(401);
    const result = await refresh(harness, first.clientId, first.refreshToken);
    expect(result.status).toBe(200);
    expect(await mcpStatus(harness, result.body.access_token as string)).toBe(200);
  });

  it("stops refreshing once the user revokes the grant's token", async () => {
    const harness = await setup();
    const login = await loginToken(harness);
    const first = await grant(harness);
    const list = await runOperation(ops.tokenList, {}, harness.runner(login));
    const row = list.tokens.find((t) => t.name?.startsWith("MCP: "));
    expect(row).toBeDefined();
    await runOperation(ops.tokenRevoke, { id: row?.id as string }, harness.runner(login));

    const result = await refresh(harness, first.clientId, first.refreshToken);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_grant");
    expect(await mcpStatus(harness, first.access)).toBe(401);
  });
});

describe("device flow", () => {
  it("still issues tokens that work on /v1/ops", async () => {
    const harness = await setup();
    const login = await loginToken(harness);
    const me = await runOperation(ops.whoami, {}, harness.runner(login));
    expect(me.principal).toMatch(/^user:usr_/);
  });
});

describe("audit", () => {
  it("records user.sign_in via mcp and token.create via oauth", async () => {
    const harness = await setup();
    const { clientId } = await grant(harness);
    const rows = await harness.db.selectFrom("audit_events").selectAll().execute();
    const details = (action: string) =>
      rows.filter((r) => r.action === action).map((r) => JSON.parse(r.detail ?? "{}") as Record<string, unknown>);
    expect(details("user.sign_in")).toContainEqual(expect.objectContaining({ via: "mcp", provider: "google" }));
    expect(details("token.create")).toContainEqual(expect.objectContaining({ via: "oauth", client_id: clientId }));
  });
});
