import { ApiClient, runOperation } from "@storage/client";
import { ops, StorageError } from "@storage/core";
import { GitHubTokenRevoked, type Group } from "@storage/server";
import { afterEach, describe, expect, it } from "vitest";
import { connectInBrowser, type FakeGitHub, fakeGitHub, fakeProvider, signInWithGoogle } from "./fake-idp.js";
import { createHarness, type Harness, SERVER_URL } from "./harness.js";

let h: Harness | undefined;
let github: FakeGitHub;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const SECOND = 1000;
const TTL_SECONDS = 600;
const TTL = TTL_SECONDS * SECOND;
const C = "storage://acme/c/";
const OTHER = "storage://acme/other/";

const ACME: Group = { principal: "github-org:100", name: "acme" };
const FRONTEND: Group = { principal: "github-team:200", name: "acme/frontend" };

const googleAccounts = {
  alice: { provider: "google" as const, subject: "g-A", email: "alice@gmail.com", name: "Alice" },
  bob: { provider: "google" as const, subject: "g-B", email: "bob@gmail.com", name: "Bob" },
  carol: { provider: "google" as const, subject: "g-C", email: "carol@gmail.com", name: "Carol" },
  dave: { provider: "google" as const, subject: "g-D", email: "dave@gmail.com", name: "Dave" },
  erin: { provider: "google" as const, subject: "g-E", email: "erin@gmail.com", name: "Erin" },
};

// GitHub codes. alice (42) and dave (45) are in acme; bob (43) is also in the frontend team; carol (44) is in no org.
const githubAccounts = {
  alice: { id: "42", login: "alice-gh" },
  "alice-lite": { id: "42", login: "alice-gh" },
  bob: { id: "43", login: "bob-gh" },
  carol: { id: "44", login: "carol-gh" },
  dave: { id: "45", login: "dave-gh" },
  "dave-lite": { id: "45", login: "dave-gh" },
};

async function setup(): Promise<Harness> {
  github = fakeGitHub(
    githubAccounts,
    {},
    {
      orgs: { acme: "100" },
      teams: { "acme/frontend": "200", "acme/secret": "300" },
      memberships: { "42": [ACME], "43": [ACME, FRONTEND], "45": [ACME] },
      scopes: { "alice-lite": ["read:user"], "dave-lite": ["read:user"] },
    },
  );
  h = await createHarness({
    signIn: { providers: [fakeProvider("google", googleAccounts)], github },
    config: { githubMembershipTtlSeconds: TTL_SECONDS },
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
const list = (harness: Harness, token: string, uri = C) => runOperation(ops.list, { uri }, harness.runner(token));
const share = (harness: Harness, uri: string, principal: string, role: "reader" | "admin" = "reader", token?: string) =>
  runOperation(ops.share, { uri, principal, role }, harness.runner(token));

async function createCollection(harness: Harness, uri = C): Promise<void> {
  await runOperation(ops.create, { uri }, harness.runner());
}

/** Signs `name` in with Google and connects the GitHub account for `githubCode` (default: the same name). */
async function connected(harness: Harness, name: keyof typeof googleAccounts, githubCode: string = name) {
  const token = await signInWithGoogle(harness, name);
  const started = await runOperation(ops.connectStart, { provider: "github" }, harness.runner(token));
  const response = await connectInBrowser(harness, started.url, { googleCode: name, githubCode });
  expect(response.status).toBe(200);
  return token;
}

/** Reconnects an already signed-in user to a GitHub code. */
async function reconnect(harness: Harness, token: string, googleCode: string, githubCode: string): Promise<void> {
  const started = await runOperation(ops.connectStart, { provider: "github" }, harness.runner(token));
  const response = await connectInBrowser(harness, started.url, { googleCode, githubCode });
  expect(response.status).toBe(200);
}

/** Gives the Google account with this email a collection admin grant (before they sign in). */
async function makeAdmin(harness: Harness, email: string, uri = C): Promise<void> {
  await share(harness, uri, `user:${email}`, "admin");
}

async function grantPrincipals(harness: Harness, uri = C): Promise<string[]> {
  const out = await runOperation(ops.grants, { uri }, harness.runner());
  return out.grants.map((g) => g.principal);
}

describe("github-org and github-team principals", () => {
  it("11. gives a connected org member access to an org-shared collection and shows the group in whoami", async () => {
    const harness = await setup();
    await createCollection(harness);
    await share(harness, C, "github-org:acme");

    const token = await connected(harness, "dave");
    expect((await list(harness, token)).uri).toBe(C);

    const me = await whoami(harness, token);
    expect(me.groups).toContainEqual({ principal: "github-org:100", name: "acme" });
    expect(me.connected[0]?.org_access).toBe(true);
  });

  it("12. stores a team grant by id with its name, and only team members get access", async () => {
    const harness = await setup();
    await createCollection(harness);
    await makeAdmin(harness, "alice@gmail.com");
    const aliceToken = await connected(harness, "alice");

    const shared = await share(harness, C, "github-team:acme/frontend", "reader", aliceToken);
    expect(shared.grant).toMatchObject({ principal: "github-team:200", name: "acme/frontend", role: "reader" });
    const rows = await harness.db
      .selectFrom("grants")
      .select("principal")
      .where("principal", "like", "github-team:%")
      .execute();
    expect(rows).toEqual([{ principal: "github-team:200" }]);
    const grants = await runOperation(ops.grants, { uri: C }, harness.runner());
    expect(grants.grants.find((g) => g.principal === "github-team:200")).toMatchObject({ name: "acme/frontend" });

    const bobToken = await connected(harness, "bob");
    expect((await list(harness, bobToken)).uri).toBe(C);

    // dave is in acme but not in the team, and has no other grant.
    const daveToken = await connected(harness, "dave");
    await expectError(list(harness, daveToken), "not_found");
  });

  it("13. refuses a team share from a caller with no connected account, no org access, or no view of the team", async () => {
    const harness = await setup();
    await createCollection(harness);
    for (const email of ["alice@gmail.com", "carol@gmail.com", "erin@gmail.com"]) {
      await makeAdmin(harness, email);
    }

    // erin has never connected GitHub.
    const erin = await signInWithGoogle(harness, "erin");
    await expectError(share(harness, C, "github-team:acme/frontend", "reader", erin), "invalid_argument");

    // alice connected without read:org.
    const alice = await connected(harness, "alice", "alice-lite");
    expect((await whoami(harness, alice)).connected[0]?.org_access).toBe(false);
    await expectError(share(harness, C, "github-team:acme/frontend", "reader", alice), "invalid_argument");

    // carol has org access, but the fake doesn't show acme's teams to her.
    const carol = await connected(harness, "carol");
    expect((await whoami(harness, carol)).connected[0]?.org_access).toBe(true);
    await expectError(share(harness, C, "github-team:acme/frontend", "reader", carol), "invalid_argument");

    expect((await grantPrincipals(harness)).filter((p) => p.startsWith("github-team:"))).toEqual([]);
  });

  it("14. rejects an unknown org, and answers unavailable with no grant when lookups fail", async () => {
    const harness = await setup();
    await createCollection(harness);

    await expectError(share(harness, C, "github-org:nobody"), "invalid_argument");

    github.orgLookupError = new Error("GitHub is down");
    await expectError(share(harness, C, "github-org:acme"), "unavailable");

    expect((await grantPrincipals(harness)).filter((p) => p.startsWith("github-org:"))).toEqual([]);
  });

  it("15. caches memberships for the TTL and applies a change after it", async () => {
    const harness = await setup();
    await createCollection(harness);
    await share(harness, C, "github-org:acme");
    const token = await connected(harness, "dave");

    expect((await list(harness, token)).uri).toBe(C);
    expect((await list(harness, token)).uri).toBe(C);
    expect(github.membershipCalls).toBe(1);

    // Removed from the org, but the cache still holds within the TTL.
    github.accountGroups.set("45", []);
    harness.advance(TTL - 10 * SECOND);
    expect((await list(harness, token)).uri).toBe(C);
    expect(github.membershipCalls).toBe(1);

    harness.advance(20 * SECOND);
    await expectError(list(harness, token), "not_found");
    expect(github.membershipCalls).toBe(2);
  });

  it("16. fails closed when a refresh fails, retries after 60 seconds, and recovers", async () => {
    const harness = await setup();
    await createCollection(harness);
    await share(harness, C, "github-org:acme");
    const token = await connected(harness, "dave");
    expect((await list(harness, token)).uri).toBe(C);
    expect(github.membershipCalls).toBe(1);

    harness.advance(TTL + SECOND);
    github.membershipsError = new Error("GitHub is down");
    await expectError(list(harness, token), "not_found");
    expect(github.membershipCalls).toBe(2);

    harness.advance(30 * SECOND);
    await expectError(list(harness, token), "not_found");
    expect(github.membershipCalls).toBe(2);

    harness.advance(31 * SECOND);
    await expectError(list(harness, token), "not_found");
    expect(github.membershipCalls).toBe(3);

    github.membershipsError = null;
    harness.advance(61 * SECOND);
    expect((await list(harness, token)).uri).toBe(C);
    expect(github.membershipCalls).toBe(4);
  });

  it("17. clears the token when GitHub says it was revoked and stops calling GitHub", async () => {
    const harness = await setup();
    await createCollection(harness);
    await share(harness, C, "github-org:acme");
    const token = await connected(harness, "dave");
    expect((await list(harness, token)).uri).toBe(C);
    expect(github.membershipCalls).toBe(1);

    harness.advance(TTL + SECOND);
    github.membershipsError = new GitHubTokenRevoked("revoked");
    await expectError(list(harness, token), "not_found");
    expect(github.membershipCalls).toBe(2);
    expect((await whoami(harness, token)).connected[0]?.org_access).toBe(false);

    github.membershipsError = null;
    harness.advance(2 * TTL);
    await expectError(list(harness, token), "not_found");
    expect(github.membershipCalls).toBe(2);
  });

  it("18. gives no org groups without read:org, and turns them on when the same account reconnects with it", async () => {
    const harness = await setup();
    await createCollection(harness);
    await share(harness, C, "github-org:acme");
    const token = await connected(harness, "dave", "dave-lite");

    const before = await whoami(harness, token);
    expect(before.connected[0]?.org_access).toBe(false);
    expect(before.groups.filter((g) => g.principal.startsWith("github-org:"))).toEqual([]);
    await expectError(list(harness, token), "not_found");
    expect(github.membershipCalls).toBe(0);

    await reconnect(harness, token, "dave", "dave");
    expect((await whoami(harness, token)).connected[0]?.org_access).toBe(true);
    expect((await list(harness, token)).uri).toBe(C);
    expect(github.membershipCalls).toBe(1);
  });

  it("19. ignores a stored token that doesn't open and makes no membership call", async () => {
    const harness = await setup();
    await createCollection(harness);
    await share(harness, C, "github-org:acme");
    const token = await connected(harness, "dave");

    await harness.db.updateTable("connected_accounts").set({ access_token: "junk" }).execute();

    await expectError(list(harness, token), "not_found");
    const me = await whoami(harness, token);
    expect(me.groups.filter((g) => g.principal.startsWith("github-org:"))).toEqual([]);
    expect(github.membershipCalls).toBe(0);
  });

  it("20. unshares org and team grants by numeric id without a lookup", async () => {
    const harness = await setup();
    await createCollection(harness);
    const collection = await harness.db
      .selectFrom("collections")
      .select(["id", "org_id"])
      .where("slug", "=", "c")
      .executeTakeFirstOrThrow();
    for (const principal of ["github-org:100", "github-team:200"]) {
      await harness.db
        .insertInto("grants")
        .values({
          id: `grt_${principal.replace(/\W/g, "_")}`,
          principal,
          role: "reader",
          org_id: collection.org_id,
          collection_id: collection.id,
          created_at: new Date().toISOString(),
        })
        .execute();
    }

    github.orgLookupError = new Error("GitHub is down");
    for (const principal of ["github-org:100", "github-team:200"]) {
      const out = await runOperation(ops.unshare, { uri: C, principal }, harness.runner());
      expect(out.removed.principal).toBe(principal);
    }
    expect((await grantPrincipals(harness)).filter((p) => p.startsWith("github-"))).toEqual([]);
  });

  it("21. keeps a share link made through an org grant working until the creator's membership lapses", async () => {
    const harness = await setup();
    await createCollection(harness);
    await share(harness, C, "github-org:acme", "admin");
    const token = await connected(harness, "dave");

    const link = await api(harness, token).call(ops.linkCreate, { uri: C, expires_in_days: 1 });
    expect(link.secret.startsWith("storage_link_")).toBe(true);
    expect((await list(harness, link.secret)).uri).toBe(C);

    github.accountGroups.set("45", []);
    harness.advance(TTL + SECOND);
    await expectError(list(harness, link.secret), "unauthenticated");
  });

  it("22. still caps tokens by their scopes for org grants", async () => {
    const harness = await setup();
    await createCollection(harness);
    await createCollection(harness, OTHER);
    await share(harness, C, "github-org:acme", "admin");
    await share(harness, OTHER, "github-org:acme");
    const token = await connected(harness, "dave");

    const scopedOther = await harness.createToken(token, { scopes: [{ collection: "acme/other", role: "reader" }] });
    expect((await list(harness, scopedOther, OTHER)).uri).toBe(OTHER);
    await expectError(list(harness, scopedOther, C), "forbidden");

    // The grant is admin, but the token only reads.
    const scopedReader = await harness.createToken(token, { scopes: [{ collection: "acme/c", role: "reader" }] });
    expect((await list(harness, scopedReader, C)).uri).toBe(C);
    await expectError(share(harness, C, "user:x@gmail.com", "reader", scopedReader), "forbidden");
    expect((await share(harness, C, "user:x@gmail.com", "reader", token)).grant.role).toBe("reader");
  });

  it("unshares github-org:<login> through a lookup", async () => {
    const harness = await setup();
    await createCollection(harness);
    await share(harness, C, "github-org:acme");
    const out = await runOperation(ops.unshare, { uri: C, principal: "github-org:acme" }, harness.runner());
    expect(out.removed.principal).toBe("github-org:100");
    expect((await grantPrincipals(harness)).filter((p) => p.startsWith("github-org:"))).toEqual([]);
  });

  it("refuses to share with all-digit org and team ids", async () => {
    const harness = await setup();
    await createCollection(harness);
    await expectError(share(harness, C, "github-org:100"), "invalid_argument");
    await expectError(share(harness, C, "github-team:200"), "invalid_argument");
    expect((await grantPrincipals(harness)).filter((p) => p.startsWith("github-"))).toEqual([]);
  });

  it("answers unavailable and clears the token when a team lookup finds it revoked", async () => {
    const harness = await setup();
    await createCollection(harness);
    await makeAdmin(harness, "alice@gmail.com");
    const alice = await connected(harness, "alice");
    expect((await whoami(harness, alice)).connected[0]?.org_access).toBe(true);

    github.teamLookupError = new GitHubTokenRevoked("revoked");
    await expectError(share(harness, C, "github-team:acme/frontend", "reader", alice), "unavailable");
    expect((await whoami(harness, alice)).connected[0]?.org_access).toBe(false);
    expect((await grantPrincipals(harness)).filter((p) => p.startsWith("github-team:"))).toEqual([]);
  });

  it("clears cached memberships on reconnect, so the next request refreshes within the TTL", async () => {
    const harness = await setup();
    await createCollection(harness);
    await share(harness, C, "github-org:acme");
    const token = await connected(harness, "dave");
    expect((await list(harness, token)).uri).toBe(C);
    expect(github.membershipCalls).toBe(1);

    await reconnect(harness, token, "dave", "dave");
    expect((await list(harness, token)).uri).toBe(C);
    expect(github.membershipCalls).toBe(2);
  });

  it("connects again after a disconnect", async () => {
    const harness = await setup();
    await createCollection(harness);
    await share(harness, C, "github-org:acme");
    const token = await connected(harness, "dave");
    await runOperation(ops.disconnect, { provider: "github" }, harness.runner(token));
    await expectError(list(harness, token), "not_found");

    await reconnect(harness, token, "dave", "dave");
    expect((await whoami(harness, token)).connected[0]?.org_access).toBe(true);
    expect((await list(harness, token)).uri).toBe(C);
  });
});
