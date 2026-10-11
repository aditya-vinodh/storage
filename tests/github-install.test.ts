import { runOperation } from "@storage/client";
import { ops, StorageError } from "@storage/core";
import { SignInError } from "@storage/server";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeGitHubApp, fakeGitHubApp } from "./fake-github-app.js";
import { fakeProvider, signInWithGoogle } from "./fake-idp.js";
import { createHarness, type Harness, SERVER_URL } from "./harness.js";

const MINUTE = 60_000;
const ORG = "storage://acme/";
const C = "storage://acme/c/";
const COOKIE = "storage_github_install";

const googleAccounts = {
  alice: { provider: "google" as const, subject: "g-A", email: "alice@gmail.com", name: "Alice" },
  bob: { provider: "google" as const, subject: "g-B", email: "bob@gmail.com", name: "Bob" },
  refused: new SignInError("Account can't sign in."),
};

const ACME = { id: "1001", account_login: "acme", account_type: "Organization" as const };

let h: Harness | undefined;
let app: FakeGitHubApp;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

/** A server with Google sign-in and the fake GitHub App; alice (acme admin) and bob (acme writer) have signed in. */
async function setup(options: { githubApp?: boolean } = {}) {
  app = fakeGitHubApp({
    codes: { "code-alice": "utok-alice", "code-other": "utok-other" },
    installations: { "utok-alice": [ACME], "utok-other": [{ ...ACME, id: "2002", account_login: "other" }] },
  });
  h = await createHarness({
    signIn: { providers: [fakeProvider("google", googleAccounts)] },
    ...(options.githubApp === false ? {} : { githubApp: app }),
  });
  await runOperation(ops.create, { uri: C }, h.runner());
  await h.addUser("alice@gmail.com", "admin");
  await h.addUser("bob@gmail.com", "writer");
  const alice = await signInWithGoogle(h, "alice");
  const bob = await signInWithGoogle(h, "bob");
  return { h, alice, bob };
}

async function expectError(promise: Promise<unknown>, code: string): Promise<StorageError> {
  const error = await promise.then(
    () => {
      throw new Error(`Expected a ${code} error`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StorageError);
  expect((error as StorageError).code).toBe(code);
  return error as StorageError;
}

async function startUrl(harness: Harness, token: string): Promise<string> {
  return (await runOperation(ops.githubInstallStart, { uri: ORG }, harness.runner(token))).url;
}

interface InstallBrowser {
  cookie: string;
  state: string;
}

function browserFrom(response: Response, cookie: string): InstallBrowser {
  const location = response.headers.get("location");
  const state = location ? new URL(location).searchParams.get("state") : null;
  if (response.status !== 302 || !state) {
    throw new Error(`Expected a redirect with a state, got ${response.status}`);
  }
  return { cookie, state };
}

/** Opens the start link; throws unless it redirects to Google with the install cookie. */
async function openStart(harness: Harness, url: string): Promise<InstallBrowser> {
  const response = await harness.fetch(url, { redirect: "manual" });
  const setCookie = response.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`));
  if (!setCookie) {
    throw new Error(`No ${COOKIE} cookie from the start link (status ${response.status})`);
  }
  return browserFrom(response, setCookie.split(";")[0] as string);
}

function googleCallback(harness: Harness, browser: InstallBrowser, code: string, options: { cookie?: boolean } = {}) {
  const query = new URLSearchParams({ state: browser.state, code });
  return harness.fetch(`${SERVER_URL}/github/install/google/callback?${query}`, {
    redirect: "manual",
    headers: options.cookie === false ? {} : { cookie: browser.cookie },
  });
}

function githubCallback(
  harness: Harness,
  browser: InstallBrowser,
  params: { code: string; installationId: string },
  options: { cookie?: boolean } = {},
) {
  const query = new URLSearchParams({
    code: params.code,
    installation_id: params.installationId,
    state: browser.state,
  });
  return harness.fetch(`${SERVER_URL}/github/install/callback?${query}`, {
    redirect: "manual",
    headers: options.cookie === false ? {} : { cookie: browser.cookie },
  });
}

/** Completes Google as `googleCode` and returns the browser positioned at GitHub, with the redirect URL. */
async function throughGoogle(harness: Harness, browser: InstallBrowser, googleCode: string) {
  const response = await googleCallback(harness, browser, googleCode);
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) {
    throw new Error(`Google install callback returned ${response.status}: ${await response.text()}`);
  }
  return { browser: browserFrom(response, browser.cookie), location };
}

/** Plays the whole flow as `token`'s user (signed in with `googleCode`), installing `installationId`. */
async function install(
  harness: Harness,
  token: string,
  googleCode = "alice",
  installationId = "1001",
  githubCode = "code-alice",
): Promise<Response> {
  const start = await openStart(harness, await startUrl(harness, token));
  const { browser } = await throughGoogle(harness, start, googleCode);
  return githubCallback(harness, browser, { code: githubCode, installationId });
}

function installations(harness: Harness, token?: string) {
  return runOperation(ops.githubInstallationList, { uri: ORG }, harness.runner(token));
}

async function auditEvents(harness: Harness, action: string) {
  const { events } = await runOperation(ops.audit, { uri: ORG, limit: 100 }, harness.runner());
  return events.filter((e) => e.action === action);
}

describe("github_install_start", () => {
  it("gives an org admin with an unscoped token a single-use start link", async () => {
    const { h: harness, alice } = await setup();
    const started = await runOperation(ops.githubInstallStart, { uri: ORG }, harness.runner(alice));
    expect(started.url).toMatch(new RegExp(`^${SERVER_URL}/github/install/start\\?ticket=[\\w-]+$`));
    expect(Date.parse(started.expires_at)).toBeGreaterThan(Date.now());
  });

  it("refuses scoped tokens, org writers and share links, and is unavailable without the app", async () => {
    const { h: harness, alice, bob } = await setup();
    const scoped = await harness.createToken(alice, { scopes: [{ collection: "acme/*", role: "admin" }] });
    const link = await harness.runner().api.call(ops.linkCreate, { uri: C, expires_in_days: 1 });
    for (const token of [scoped, bob, link.secret]) {
      await expectError(runOperation(ops.githubInstallStart, { uri: ORG }, harness.runner(token)), "forbidden");
    }

    await harness.cleanup();
    const { h: without, alice: aliceWithout } = await setup({ githubApp: false });
    await expectError(runOperation(ops.githubInstallStart, { uri: ORG }, without.runner(aliceWithout)), "unavailable");
  });
});

describe("the install flow", () => {
  it("links the installation after Google as the same user and GitHub, and audits github.install", async () => {
    const { h: harness, alice } = await setup();
    const start = await openStart(harness, await startUrl(harness, alice));
    const { browser, location } = await throughGoogle(harness, start, "alice");
    expect(location).toBe(app.installUrl(browser.state));

    const response = await githubCallback(harness, browser, { code: "code-alice", installationId: "1001" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Linked acme to storage://acme/");

    const listed = await installations(harness, alice);
    expect(listed.uri).toBe(ORG);
    expect(listed.installations).toHaveLength(1);
    expect(listed.installations[0]).toMatchObject({
      installation_id: "1001",
      account_login: "acme",
      account_type: "Organization",
    });
    const events = await auditEvents(harness, "github.install");
    expect(events).toHaveLength(1);
    expect(events[0]?.target).toBe(ORG);
    expect(events[0]?.detail).toMatchObject({ installation_id: "1001", account: "acme" });
  });

  it("answers 403 and links nothing when the user can't see the installation", async () => {
    const { h: harness, alice } = await setup();
    const response = await install(harness, alice, "alice", "9999");
    expect(response.status).toBe(403);
    expect((await response.text()).replaceAll("&#39;", "'")).toContain(
      "Your GitHub account can't see that installation.",
    );
    // An installation the user's token lists for a different id is no use either.
    const other = await install(harness, alice, "alice", "2002", "code-alice");
    expect(other.status).toBe(403);

    expect((await installations(harness, alice)).installations).toEqual([]);
    expect(await harness.db.selectFrom("github_installations").selectAll().execute()).toEqual([]);
    expect(await auditEvents(harness, "github.install")).toEqual([]);
  });

  it("stops at the Google callback with 403 when a different Storage user signs in", async () => {
    const { h: harness, alice } = await setup();
    const start = await openStart(harness, await startUrl(harness, alice));
    const response = await googleCallback(harness, start, "bob");
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();

    // The flow is over: even the right user can't continue with that state.
    expect((await googleCallback(harness, start, "alice")).status).toBe(400);
    expect((await installations(harness, alice)).installations).toEqual([]);
  });

  it("refuses a reused ticket, an expired ticket and an unknown ticket with 400", async () => {
    const { h: harness, alice } = await setup();
    const url = await startUrl(harness, alice);
    expect((await harness.fetch(url, { redirect: "manual" })).status).toBe(302);
    expect((await harness.fetch(url, { redirect: "manual" })).status).toBe(400);

    const late = await startUrl(harness, alice);
    harness.advance(10 * MINUTE + 1000);
    expect((await harness.fetch(late, { redirect: "manual" })).status).toBe(400);

    const unknown = await harness.fetch(`${SERVER_URL}/github/install/start?ticket=nope`, { redirect: "manual" });
    expect(unknown.status).toBe(400);
    expect((await installations(harness, alice)).installations).toEqual([]);
  });

  it("refuses callbacks without the cookie, and replayed states, with 400", async () => {
    const { h: harness, alice } = await setup();

    const first = await openStart(harness, await startUrl(harness, alice));
    expect((await googleCallback(harness, first, "alice", { cookie: false })).status).toBe(400);

    const second = await openStart(harness, await startUrl(harness, alice));
    const { browser } = await throughGoogle(harness, second, "alice");
    const params = { code: "code-alice", installationId: "1001" };
    expect((await githubCallback(harness, browser, params, { cookie: false })).status).toBe(400);
    expect((await installations(harness, alice)).installations).toEqual([]);

    // The Google state is spent, so it can't be replayed at Google or used at GitHub.
    expect((await googleCallback(harness, second, "alice")).status).toBe(400);
    expect((await githubCallback(harness, second, params)).status).toBe(400);

    expect((await githubCallback(harness, browser, params)).status).toBe(200);
    expect((await githubCallback(harness, browser, params)).status).toBe(400);
    expect((await installations(harness, alice)).installations).toHaveLength(1);
    expect(await auditEvents(harness, "github.install")).toHaveLength(1);
  });

  it("says so when the installation is already linked, adding no row or audit event", async () => {
    const { h: harness, alice } = await setup();
    expect((await install(harness, alice)).status).toBe(200);
    const again = await install(harness, alice);
    expect(again.status).toBe(200);
    expect((await again.text()).toLowerCase()).toContain("already linked");

    expect((await installations(harness, alice)).installations).toHaveLength(1);
    expect(await harness.db.selectFrom("github_installations").selectAll().execute()).toHaveLength(1);
    expect(await auditEvents(harness, "github.install")).toHaveLength(1);
  });
});

describe("github_installation_remove", () => {
  it("unlinks an installation and audits github.uninstall; unknown ids are not_found", async () => {
    const { h: harness, alice } = await setup();
    await install(harness, alice);

    const removed = await runOperation(
      ops.githubInstallationRemove,
      { uri: ORG, installation_id: "1001" },
      harness.runner(alice),
    );
    expect(removed.uri).toBe(ORG);
    expect(removed.removed).toMatchObject({ installation_id: "1001", account_login: "acme" });
    expect((await installations(harness, alice)).installations).toEqual([]);
    const events = await auditEvents(harness, "github.uninstall");
    expect(events).toHaveLength(1);
    expect(events[0]?.target).toBe(ORG);

    await expectError(
      runOperation(ops.githubInstallationRemove, { uri: ORG, installation_id: "1001" }, harness.runner(alice)),
      "not_found",
    );
    await expectError(
      runOperation(ops.githubInstallationRemove, { uri: ORG, installation_id: "404" }, harness.runner(alice)),
      "not_found",
    );
  });

  it("forbids an org writer from removing or starting, and still lets them list", async () => {
    const { h: harness, alice, bob } = await setup();
    await install(harness, alice);

    await expectError(
      runOperation(ops.githubInstallationRemove, { uri: ORG, installation_id: "1001" }, harness.runner(bob)),
      "forbidden",
    );
    expect((await installations(harness, bob)).installations).toHaveLength(1);
    expect(await auditEvents(harness, "github.uninstall")).toEqual([]);
  });
});
