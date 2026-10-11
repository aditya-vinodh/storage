import { ApiClient, runOperation } from "@storage/client";
import { ops, StorageError } from "@storage/core";
import { SignInError } from "@storage/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeGoogleStep,
  connectCallback,
  connectInBrowser,
  type FakeGitHub,
  fakeGitHub,
  fakeProvider,
  signInWithGoogle,
  startConnectInBrowser,
} from "./fake-idp.js";
import { createHarness, type Harness, SERVER_URL } from "./harness.js";

let h: Harness | undefined;
let github: FakeGitHub;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const MINUTE = 60_000;
const C = "storage://acme/c/";
const OTHER = "storage://acme/other/";

const googleAccounts = {
  alice: { provider: "google" as const, subject: "g-A", email: "alice@gmail.com", name: "Alice" },
  bob: { provider: "google" as const, subject: "g-B", email: "bob@gmail.com", name: "Bob" },
  stranger: { provider: "google" as const, subject: "g-Z", email: "stranger@gmail.com", name: null },
  refused: new SignInError("Account can't sign in."),
};

const githubAccounts = {
  octo: { id: "42", login: "octo" },
  "octo-renamed": { id: "42", login: "octocat" },
  other: { id: "43", login: "other" },
};

async function setup(options: { github?: boolean } = {}): Promise<Harness> {
  github = fakeGitHub(githubAccounts, { octo: "42", other: "43" });
  h = await createHarness({
    signIn: {
      providers: [fakeProvider("google", googleAccounts)],
      ...(options.github === false ? {} : { github }),
    },
  });
  return h;
}

function api(harness: Harness, token: string): ApiClient {
  return new ApiClient({ server: SERVER_URL, token, fetch: harness.fetch });
}

async function expectError(promise: Promise<unknown>, code: string, message?: string): Promise<StorageError> {
  const error = await promise.then(
    () => {
      throw new Error(`Expected a ${code} error`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StorageError);
  expect((error as StorageError).code).toBe(code);
  if (message !== undefined) {
    expect((error as StorageError).message).toContain(message);
  }
  return error as StorageError;
}

const whoami = (harness: Harness, token: string) => runOperation(ops.whoami, {}, harness.runner(token));

async function connectStartUrl(harness: Harness, token: string): Promise<string> {
  const started = await runOperation(ops.connectStart, { provider: "github" }, harness.runner(token));
  return started.url;
}

/** Runs the whole browser flow for the user holding `token` and returns the GitHub callback response. */
async function connect(harness: Harness, token: string, googleCode: string, githubCode: string): Promise<Response> {
  return connectInBrowser(harness, await connectStartUrl(harness, token), { googleCode, githubCode });
}

async function connectedAccounts(harness: Harness) {
  return harness.db.selectFrom("connected_accounts").selectAll().execute();
}

async function auditRows(harness: Harness, action: string) {
  return harness.db.selectFrom("audit_events").selectAll().where("action", "=", action).execute();
}

/** Signs alice in with Google and connects her to GitHub account octo (id 42). */
async function aliceConnected(harness: Harness): Promise<string> {
  const token = await signInWithGoogle(harness, "alice");
  const response = await connect(harness, token, "alice", "octo");
  expect(response.status).toBe(200);
  return token;
}

describe("connecting a GitHub account", () => {
  it("connects through Google and GitHub, shows it in whoami and audits account.connect", async () => {
    const harness = await setup();
    const token = await signInWithGoogle(harness, "alice");
    expect((await whoami(harness, token)).connected).toEqual([]);

    const started = await runOperation(ops.connectStart, { provider: "github" }, harness.runner(token));
    expect(started.url).toMatch(new RegExp(`^${SERVER_URL}/connect/github/start\\?ticket=[\\w-]+$`));
    expect(Date.parse(started.expires_at)).toBeGreaterThan(Date.now());

    const response = await connectInBrowser(harness, started.url, { googleCode: "alice", githubCode: "octo" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Connected GitHub account octo.");

    expect((await whoami(harness, token)).connected).toEqual([
      { provider: "github", id: "42", login: "octo", org_access: false },
    ]);

    const events = await auditRows(harness, "account.connect");
    expect(events).toHaveLength(1);
    expect(events[0]?.org_id).toBeNull();
    expect(events[0]?.actor).toBe((await whoami(harness, token)).principal);
    expect(JSON.parse(events[0]?.detail ?? "{}")).toMatchObject({ provider: "github", id: "42", login: "octo" });
  });

  it("refuses a Google step completed as a different account and connects nothing", async () => {
    const harness = await setup();
    const token = await signInWithGoogle(harness, "alice");
    // bob exists as a different Storage user with his own Google identity.
    await signInWithGoogle(harness, "bob");

    const response = await connect(harness, token, "bob", "octo");
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Sign in with the Google account you use for Storage");
    expect(await connectedAccounts(harness)).toEqual([]);
    expect((await whoami(harness, token)).connected).toEqual([]);
  });

  it("refuses a Google account that has never signed in to Storage", async () => {
    const harness = await setup();
    const token = await signInWithGoogle(harness, "alice");
    const response = await connect(harness, token, "stranger", "octo");
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Sign in with the Google account you use for Storage");
    expect(await connectedAccounts(harness)).toEqual([]);
  });

  it("answers 403 at the start link for a user with no Google identity", async () => {
    const harness = await setup();
    // The bootstrap admin never signed in with Google.
    const url = await connectStartUrl(harness, harness.adminToken);
    const response = await harness.fetch(url, { redirect: "manual" });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Run `storage login`");
    expect(await connectedAccounts(harness)).toEqual([]);
  });

  it("rejects a reused ticket", async () => {
    const harness = await setup();
    const token = await signInWithGoogle(harness, "alice");
    const url = await connectStartUrl(harness, token);
    expect((await harness.fetch(url, { redirect: "manual" })).status).toBe(302);
    const again = await harness.fetch(url, { redirect: "manual" });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("invalid or has expired");
  });

  it("rejects a ticket opened after 10 minutes, and an unknown ticket", async () => {
    const harness = await setup();
    const token = await signInWithGoogle(harness, "alice");
    const url = await connectStartUrl(harness, token);
    harness.advance(10 * MINUTE + 1000);
    const late = await harness.fetch(url, { redirect: "manual" });
    expect(late.status).toBe(400);
    expect(await late.text()).toContain("invalid or has expired");

    const unknown = await harness.fetch(`${SERVER_URL}/connect/github/start?ticket=nope`, { redirect: "manual" });
    expect(unknown.status).toBe(400);
    const missing = await harness.fetch(`${SERVER_URL}/connect/github/start`, { redirect: "manual" });
    expect(missing.status).toBe(400);
  });

  it("rejects callbacks without the storage_connect cookie and connects nothing", async () => {
    const harness = await setup();
    const token = await signInWithGoogle(harness, "alice");

    const first = await startConnectInBrowser(harness, await connectStartUrl(harness, token));
    const noCookieGoogle = await connectCallback(harness, first, "google", { code: "alice" }, { cookie: false });
    expect(noCookieGoogle.status).toBe(400);

    const second = await startConnectInBrowser(harness, await connectStartUrl(harness, token));
    const atGitHub = await completeGoogleStep(harness, second, "alice");
    const noCookieGitHub = await connectCallback(harness, atGitHub, "github", { code: "octo" }, { cookie: false });
    expect(noCookieGitHub.status).toBe(400);

    expect(await connectedAccounts(harness)).toEqual([]);
  });

  it("rejects replayed Google and GitHub callbacks", async () => {
    const harness = await setup();
    const token = await signInWithGoogle(harness, "alice");
    const start = await startConnectInBrowser(harness, await connectStartUrl(harness, token));

    const atGitHub = await completeGoogleStep(harness, start, "alice");
    const replayedGoogle = await connectCallback(harness, start, "google", { code: "alice" });
    expect(replayedGoogle.status).toBe(400);

    // The Google state is spent, so it can't be used at the GitHub step either.
    const wrongStep = await connectCallback(harness, start, "github", { code: "octo" });
    expect(wrongStep.status).toBe(400);
    expect(await connectedAccounts(harness)).toEqual([]);

    expect((await connectCallback(harness, atGitHub, "github", { code: "octo" })).status).toBe(200);
    const replayedGitHub = await connectCallback(harness, atGitHub, "github", { code: "octo" });
    expect(replayedGitHub.status).toBe(400);
    expect(await connectedAccounts(harness)).toHaveLength(1);
    expect(await auditRows(harness, "account.connect")).toHaveLength(1);
  });

  it("refuses a GitHub account already connected to another user and leaves that connection unchanged", async () => {
    const harness = await setup();
    const aliceToken = await aliceConnected(harness);
    const bobToken = await signInWithGoogle(harness, "bob");

    const response = await connect(harness, bobToken, "bob", "octo-renamed");
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("already connected to another Storage account");

    expect((await whoami(harness, aliceToken)).connected).toEqual([
      { provider: "github", id: "42", login: "octo", org_access: false },
    ]);
    expect((await whoami(harness, bobToken)).connected).toEqual([]);
    expect(await connectedAccounts(harness)).toHaveLength(1);
  });

  it("refuses a second, different GitHub account and updates the login when the same id reconnects", async () => {
    const harness = await setup();
    const token = await aliceConnected(harness);

    const different = await connect(harness, token, "alice", "other");
    expect(different.status).toBe(409);
    const html = await different.text();
    expect(html).toContain("already connected to GitHub account octo");
    expect(html).toContain("storage disconnect github");
    expect((await whoami(harness, token)).connected).toEqual([
      { provider: "github", id: "42", login: "octo", org_access: false },
    ]);

    const renamed = await connect(harness, token, "alice", "octo-renamed");
    expect(renamed.status).toBe(200);
    expect((await whoami(harness, token)).connected).toEqual([
      { provider: "github", id: "42", login: "octocat", org_access: false },
    ]);
    expect(await connectedAccounts(harness)).toHaveLength(1);
  });

  it("rejects connect_start from scoped, child, service and link tokens with forbidden", async () => {
    const harness = await setup();
    await runOperation(ops.create, { uri: C }, harness.runner());

    const scoped = await harness.createToken(harness.adminToken, {
      scopes: [{ collection: "acme/*", role: "reader" }],
    });
    const child = await harness.createToken(scoped, { scopes: [{ collection: "acme/c", role: "reader" }] });

    await api(harness, harness.adminToken).call(ops.serviceCreate, { org: "acme", name: "bot" });
    const service = await api(harness, harness.adminToken).call(ops.tokenCreate, {
      name: "bot",
      service: "acme/bot",
    });

    const link = await api(harness, harness.adminToken).call(ops.linkCreate, { uri: C, expires_in_days: 1 });

    for (const token of [scoped, child, service.token, link.secret]) {
      await expectError(runOperation(ops.connectStart, { provider: "github" }, harness.runner(token)), "forbidden");
    }
  });

  it("answers unavailable when GitHub isn't configured", async () => {
    const harness = await setup({ github: false });
    await expectError(
      runOperation(ops.connectStart, { provider: "github" }, harness.runner(harness.adminToken)),
      "unavailable",
    );
  });

  it("disconnects, audits account.disconnect once and answers disconnected: false the second time", async () => {
    const harness = await setup();
    const token = await aliceConnected(harness);

    const first = await runOperation(ops.disconnect, { provider: "github" }, harness.runner(token));
    expect(first).toEqual({ provider: "github", disconnected: true });
    expect((await whoami(harness, token)).connected).toEqual([]);
    expect(await connectedAccounts(harness)).toEqual([]);

    const events = await auditRows(harness, "account.disconnect");
    expect(events).toHaveLength(1);
    expect(events[0]?.org_id).toBeNull();
    expect(JSON.parse(events[0]?.detail ?? "{}")).toMatchObject({ provider: "github", id: "42", login: "octo" });

    const second = await runOperation(ops.disconnect, { provider: "github" }, harness.runner(token));
    expect(second).toEqual({ provider: "github", disconnected: false });
    expect(await auditRows(harness, "account.disconnect")).toHaveLength(1);
  });
});

describe("github-user principals", () => {
  it("shares to a login, stores the numeric id, and shows the login in grants only once connected", async () => {
    const harness = await setup();
    await runOperation(ops.create, { uri: C }, harness.runner());

    const shared = await runOperation(
      ops.share,
      { uri: C, principal: "github-user:octo", role: "reader" },
      harness.runner(),
    );
    expect(shared.grant).toMatchObject({
      principal: "github-user:42",
      github_login: "octo",
      email: null,
      role: "reader",
    });
    const rows = await harness.db
      .selectFrom("grants")
      .select("principal")
      .where("principal", "like", "github-user:%")
      .execute();
    expect(rows).toEqual([{ principal: "github-user:42" }]);

    const find = async () => {
      const out = await runOperation(ops.grants, { uri: C }, harness.runner());
      return out.grants.find((g) => g.principal === "github-user:42");
    };
    expect(await find()).toMatchObject({ github_login: null, email: null, role: "reader" });

    await aliceConnected(harness);
    expect(await find()).toMatchObject({ github_login: "octo" });
  });

  it("gives access only while the GitHub account is connected", async () => {
    const harness = await setup();
    await runOperation(ops.create, { uri: C }, harness.runner());
    await runOperation(ops.share, { uri: C, principal: "github-user:octo", role: "reader" }, harness.runner());

    const token = await signInWithGoogle(harness, "alice");
    await expectError(runOperation(ops.list, { uri: C }, harness.runner(token)), "not_found");

    expect((await connect(harness, token, "alice", "octo")).status).toBe(200);
    const listing = await runOperation(ops.list, { uri: C }, harness.runner(token));
    expect(listing.uri).toBe(C);

    await runOperation(ops.disconnect, { provider: "github" }, harness.runner(token));
    await expectError(runOperation(ops.list, { uri: C }, harness.runner(token)), "not_found");
  });

  it("rejects an unknown login, and fails closed when GitHub can't be reached", async () => {
    const harness = await setup();
    await runOperation(ops.create, { uri: C }, harness.runner());

    await expectError(
      runOperation(ops.share, { uri: C, principal: "github-user:nobody", role: "reader" }, harness.runner()),
      "invalid_argument",
      "No GitHub user nobody",
    );

    github.lookupError = new Error("GitHub is down");
    await expectError(
      runOperation(ops.share, { uri: C, principal: "github-user:octo", role: "reader" }, harness.runner()),
      "unavailable",
    );

    const grants = await runOperation(ops.grants, { uri: C }, harness.runner());
    expect(grants.grants.filter((g) => g.principal.startsWith("github-user:"))).toEqual([]);
  });

  it("unshares by numeric id", async () => {
    const harness = await setup();
    await runOperation(ops.create, { uri: C }, harness.runner());
    await runOperation(ops.share, { uri: C, principal: "github-user:octo", role: "reader" }, harness.runner());

    const out = await runOperation(ops.unshare, { uri: C, principal: "github-user:42" }, harness.runner());
    expect(out.removed.principal).toBe("github-user:42");

    const grants = await runOperation(ops.grants, { uri: C }, harness.runner());
    expect(grants.grants.filter((g) => g.principal.startsWith("github-user:"))).toEqual([]);
  });

  it("doesn't let a token scoped to another collection use a github-user grant", async () => {
    const harness = await setup();
    await runOperation(ops.create, { uri: C }, harness.runner());
    await runOperation(ops.create, { uri: OTHER }, harness.runner());
    await runOperation(ops.share, { uri: C, principal: "github-user:octo", role: "reader" }, harness.runner());
    await runOperation(ops.share, { uri: OTHER, principal: "user:alice@gmail.com", role: "reader" }, harness.runner());

    const token = await aliceConnected(harness);
    expect((await runOperation(ops.list, { uri: C }, harness.runner(token))).uri).toBe(C);

    const scoped = await harness.createToken(token, { scopes: [{ collection: "acme/other", role: "reader" }] });
    expect((await runOperation(ops.list, { uri: OTHER }, harness.runner(scoped))).uri).toBe(OTHER);
    await expectError(runOperation(ops.list, { uri: C }, harness.runner(scoped)), "forbidden");
  });

  it("lets a user who is admin only through a github-user grant create a working share link", async () => {
    const harness = await setup();
    await runOperation(ops.create, { uri: C }, harness.runner());
    await runOperation(ops.share, { uri: C, principal: "github-user:octo", role: "admin" }, harness.runner());
    const token = await aliceConnected(harness);

    const link = await api(harness, token).call(ops.linkCreate, { uri: C, expires_in_days: 1 });
    expect(link.secret.startsWith("storage_link_")).toBe(true);

    const listing = await runOperation(ops.list, { uri: C }, harness.runner(link.secret));
    expect(listing.uri).toBe(C);
  });
});
