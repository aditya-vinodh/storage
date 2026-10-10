import { join } from "node:path";
import { runCli } from "@storage/cli";
import { runOperation } from "@storage/client";
import { ops } from "@storage/core";
import { SignInError } from "@storage/server";
import { afterEach, describe, expect, it } from "vitest";
import { approveInBrowser, fakeProvider, startInBrowser } from "./fake-idp.js";
import { captureStream, createHarness, type Harness, SERVER_URL } from "./harness.js";

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

const accounts = {
  github: {
    alice: { provider: "github" as const, subject: "1001", email: "alice@example.com", name: "Alice" },
    "alice-new-email": { provider: "github" as const, subject: "1001", email: "alice@new.example", name: "Alice" },
    bob: { provider: "github" as const, subject: "1002", email: "bob@acme.com", name: "Bob" },
    carol: { provider: "github" as const, subject: "1003", email: "carol@example.com", name: null },
    refused: new SignInError("Account <b>bold</b> can't sign in."),
  },
  google: {
    "alice-google": { provider: "google" as const, subject: "g-77", email: "alice@example.com", name: "Alice" },
  },
};

async function setup(): Promise<Harness> {
  h = await createHarness({
    signIn: { providers: [fakeProvider("github", accounts.github), fakeProvider("google", accounts.google)] },
  });
  return h;
}

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

function form(body: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  };
}

async function startDevice(harness: Harness): Promise<DeviceStart> {
  const response = await harness.fetch(`${SERVER_URL}/oauth/device_authorization`, form({ client_id: "storage-cli" }));
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceStart;
}

async function poll(harness: Harness, deviceCode: string, extra: Record<string, string> = {}) {
  const response = await harness.fetch(
    `${SERVER_URL}/oauth/token`,
    form({ grant_type: DEVICE_GRANT, client_id: "storage-cli", device_code: deviceCode, ...extra }),
  );
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** Runs the whole flow in the "browser" and returns the issued token. */
async function signIn(harness: Harness, provider: "github" | "google", code: string) {
  const device = await startDevice(harness);
  const callback = await approveInBrowser(harness, device.user_code, { provider, code });
  expect(callback.status).toBe(200);
  const token = await poll(harness, device.device_code);
  expect(token.status).toBe(200);
  const accessToken = token.body.access_token as string;
  const me = await runOperation(ops.whoami, {}, harness.runner(accessToken));
  return { device, accessToken, me, callback };
}

describe("device authorization", () => {
  it("returns a device code, a formatted user code and the verification URLs", async () => {
    const harness = await setup();
    const response = await harness.fetch(
      `${SERVER_URL}/oauth/device_authorization`,
      form({ client_id: "storage-cli" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as DeviceStart;
    expect(body.device_code).toEqual(expect.any(String));
    expect(body.user_code).toMatch(USER_CODE);
    expect(body.verification_uri).toBe(`${SERVER_URL}/device`);
    expect(body.verification_uri_complete).toBe(`${SERVER_URL}/device?user_code=${body.user_code}`);
    expect(body.expires_in).toBe(600);
    expect(body.interval).toBe(5);
  });

  it("rejects an unknown client_id with 401 invalid_client", async () => {
    const harness = await setup();
    const response = await harness.fetch(`${SERVER_URL}/oauth/device_authorization`, form({ client_id: "other" }));
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_client");
  });

  it("answers 400 invalid_request when sign-in isn't configured", async () => {
    h = await createHarness();
    const response = await h.fetch(`${SERVER_URL}/oauth/device_authorization`, form({ client_id: "storage-cli" }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("rejects other grant types with 400 unsupported_grant_type", async () => {
    const harness = await setup();
    const device = await startDevice(harness);
    const result = await poll(harness, device.device_code, { grant_type: "authorization_code" });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("unsupported_grant_type");
  });
});

describe("polling", () => {
  it("answers authorization_pending, then slow_down when polling too fast, then pending again", async () => {
    const harness = await setup();
    const device = await startDevice(harness);

    const first = await poll(harness, device.device_code);
    expect(first.status).toBe(400);
    expect(first.body.error).toBe("authorization_pending");
    expect(first.headers.get("cache-control")).toBe("no-store");

    expect((await poll(harness, device.device_code)).body.error).toBe("slow_down");

    harness.advance(11_000);
    expect((await poll(harness, device.device_code)).body.error).toBe("authorization_pending");
  });

  it("answers expired_token after the code expires and rejects the verification page", async () => {
    const harness = await setup();
    const device = await startDevice(harness);
    harness.advance(601_000);
    const result = await poll(harness, device.device_code);
    expect(result.body.error).toBe("expired_token");
    const page = await harness.fetch(`${SERVER_URL}/device?user_code=${device.user_code}`);
    expect(page.status).toBe(400);
  });

  it("answers invalid_grant for an unknown device code", async () => {
    const harness = await setup();
    const result = await poll(harness, "storage_dev_nope");
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_grant");
  });
});

describe("browser sign-in", () => {
  it("signs in through GitHub, issues a token once, and shows the email", async () => {
    const harness = await setup();
    const { device, accessToken, me, callback } = await signIn(harness, "github", "alice");
    expect(await callback.text()).toContain("alice@example.com");
    expect(accessToken).toMatch(/^storage_pat_/);
    expect(me.principal).toMatch(/^user:usr_/);

    const again = await poll(harness, device.device_code);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
  });

  it("returns a Bearer token in the token response", async () => {
    const harness = await setup();
    const device = await startDevice(harness);
    await approveInBrowser(harness, device.user_code, { provider: "github", code: "alice" });
    const token = await poll(harness, device.device_code);
    expect(token.headers.get("cache-control")).toBe("no-store");
    expect(token.body.token_type).toBe("Bearer");
    expect(token.body.expires_in).toEqual(expect.any(Number));
  });

  it("links the sign-in to a user who was granted access by email before signing in", async () => {
    const harness = await setup();
    await runOperation(ops.create, { uri: "storage://acme/shared/" }, harness.runner());
    await runOperation(
      ops.share,
      { uri: "storage://acme/shared/", principal: "user:bob@acme.com", role: "reader" },
      harness.runner(),
    );
    const bob = await harness.db
      .selectFrom("users")
      .select("id")
      .where("email", "=", "bob@acme.com")
      .executeTakeFirstOrThrow();

    const { accessToken, me } = await signIn(harness, "github", "bob");
    expect(me.principal).toBe(`user:${bob.id}`);
    const listing = await runOperation(ops.list, { uri: "storage://acme/shared/" }, harness.runner(accessToken));
    expect(listing.uri).toBe("storage://acme/shared/");
  });

  it("keeps the same user when the GitHub account later has a different email", async () => {
    const harness = await setup();
    const first = await signIn(harness, "github", "alice");
    const second = await signIn(harness, "github", "alice-new-email");
    expect(second.me.principal).toBe(first.me.principal);
  });

  it("keeps the same user when the same email signs in through Google", async () => {
    const harness = await setup();
    const first = await signIn(harness, "github", "alice");
    const second = await signIn(harness, "google", "alice-google");
    expect(second.me.principal).toBe(first.me.principal);
  });

  it("creates a new user with no orgs for a new email", async () => {
    const harness = await setup();
    const alice = await signIn(harness, "github", "alice");
    const carol = await signIn(harness, "github", "carol");
    expect(carol.me.principal).not.toBe(alice.me.principal);
    expect(carol.me.orgs).toEqual([]);
  });

  it("rejects a callback without the browser cookie and leaves the device code pending", async () => {
    const harness = await setup();
    const device = await startDevice(harness);
    const response = await approveInBrowser(harness, device.user_code, {
      provider: "github",
      code: "alice",
      cookie: false,
    });
    expect(response.status).toBe(400);
    harness.advance(6_000);
    expect((await poll(harness, device.device_code)).body.error).toBe("authorization_pending");
  });

  it("rejects replaying the same callback URL", async () => {
    const harness = await setup();
    const device = await startDevice(harness);
    const started = await startInBrowser(harness, device.user_code, "github");
    const url = started.callbackUrl({ code: "alice" });
    const init = { redirect: "manual", headers: { cookie: started.cookie } } as const;
    expect((await harness.fetch(url, init)).status).toBe(200);
    expect((await harness.fetch(url, init)).status).toBe(400);
  });

  it("denies the device code when the provider reports an error", async () => {
    const harness = await setup();
    const device = await startDevice(harness);
    const started = await startInBrowser(harness, device.user_code, "github");
    const response = await harness.fetch(started.callbackUrl({ error: "access_denied" }), {
      redirect: "manual",
      headers: { cookie: started.cookie },
    });
    expect(response.status).toBe(400);
    expect((await poll(harness, device.device_code)).body.error).toBe("access_denied");
  });

  it("shows an escaped 403 page and denies the device code when the account can't sign in", async () => {
    const harness = await setup();
    const device = await startDevice(harness);
    const response = await approveInBrowser(harness, device.user_code, { provider: "github", code: "refused" });
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
    expect((await poll(harness, device.device_code)).body.error).toBe("access_denied");
  });

  it("accepts a lowercase user code with the hyphen on the verification page", async () => {
    const harness = await setup();
    const device = await startDevice(harness);
    const response = await harness.fetch(`${SERVER_URL}/device?user_code=${device.user_code.toLowerCase()}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(device.user_code);
  });

  it("sends restrictive security headers on pages", async () => {
    const harness = await setup();
    const device = await startDevice(harness);
    const response = await harness.fetch(`${SERVER_URL}/device?user_code=${device.user_code}`);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("answers 400 for a provider that isn't configured and 404 for an unknown callback provider", async () => {
    h = await createHarness({ signIn: { providers: [fakeProvider("github", accounts.github)] } });
    const device = await startDevice(h);
    const letters = device.user_code.replace("-", "");
    const start = await h.fetch(`${SERVER_URL}/device/start?user_code=${letters}&provider=google`, {
      redirect: "manual",
    });
    expect(start.status).toBe(400);
    const callback = await h.fetch(`${SERVER_URL}/auth/nope/callback?code=x&state=y`, { redirect: "manual" });
    expect(callback.status).toBe(404);
  });

  it("records user.sign_in and token.create audit events", async () => {
    const harness = await setup();
    const { accessToken, me } = await signIn(harness, "github", "alice");

    const signInRows = await harness.db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "user.sign_in")
      .execute();
    expect(signInRows).toHaveLength(1);
    expect(signInRows[0]?.actor).toBe(me.principal);
    expect(JSON.parse(signInRows[0]?.detail ?? "{}")).toMatchObject({ provider: "github" });

    const tokenRows = await harness.db
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "=", "token.create")
      .where("actor", "=", me.principal)
      .execute();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]?.token_id).toBe(me.token.id);
    expect(accessToken).toMatch(/^storage_pat_/);
  });
});

describe("storage login (device flow)", () => {
  async function loginCli(
    harness: Harness,
    args: string[],
    onSleep?: (stderr: string) => Promise<void>,
    env: Record<string, string | undefined> = {},
  ) {
    const stdout = captureStream();
    const stderr = captureStream();
    let sleeps = 0;
    const code = await runCli(args, {
      env: {
        STORAGE_HOME: join(harness.dir, "home"),
        STORAGE_CONFIG_DIR: join(harness.dir, "config"),
        ...env,
      },
      cwd: harness.dir,
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetch: harness.fetch,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) {
          await onSleep?.(stderr.text());
        }
      },
    });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }

  const approve = (harness: Harness) => async (stderr: string) => {
    const userCode = /shows the code ([A-Z]{4}-[A-Z]{4})/.exec(stderr)?.[1];
    expect(userCode).toBeDefined();
    const response = await approveInBrowser(harness, userCode as string, { provider: "github", code: "alice" });
    expect(response.status).toBe(200);
  };

  it("signs in through the browser flow and saves the profile", async () => {
    const harness = await setup();
    const login = await loginCli(harness, ["login", "--server", SERVER_URL], approve(harness));
    expect(login.code).toBe(0);
    expect(login.stderr).toContain(`${SERVER_URL}/device?user_code=`);
    expect(login.stdout).toMatch(/Logged in to .* as user:usr_/);

    const whoami = await loginCli(harness, ["whoami"]);
    expect(whoami.code).toBe(0);
    expect(whoami.stdout).toMatch(/user:usr_/);
  });

  it("prints exactly one JSON line with --json", async () => {
    const harness = await setup();
    const login = await loginCli(harness, ["login", "--server", SERVER_URL, "--json"], approve(harness));
    expect(login.code).toBe(0);
    const lines = login.stdout.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toBeTypeOf("object");
  });

  it("fails and points to --with-token when the server has no browser sign-in", async () => {
    h = await createHarness();
    const login = await loginCli(h, ["login", "--server", SERVER_URL]);
    expect(login.code).not.toBe(0);
    expect(login.stderr).toContain("--with-token");
  });
});
