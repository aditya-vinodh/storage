import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runOperation } from "@storage/client";
import { ops, StorageError } from "@storage/core";
import { bootstrapAdmin } from "@storage/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeGitHubApp, type FakePull, fakeGitHubApp } from "./fake-github-app.js";
import { createHarness, type Harness, SERVER_URL } from "./harness.js";

const ORG = "storage://acme/";
const PR = "gh-pr:acme/web#482/";
const COLLECTION = "storage://acme/web-pr-482/";
const TARGET = "github:acme/web#482";
const INSTALLATION = "1001";

let h: Harness;
let github: FakeGitHubApp;
const clients: Client[] = [];

beforeEach(async () => {
  github = fakeGitHubApp({
    pulls: { "acme/web#482": openPull() },
    branches: { "acme/web@feature/login": 482 },
  });
  h = await createHarness({ githubApp: github });
  await linkInstallation("acme");
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await h.cleanup();
});

function openPull(): FakePull {
  return { state: "open", merged_at: null, closed_at: null, updated_at: new Date().toISOString() };
}

/** Links a GitHub App installation to the org directly, as a completed install flow would. */
async function linkInstallation(orgSlug: string, installationId = INSTALLATION, login = "acme") {
  const org = await h.db.selectFrom("orgs").select("id").where("slug", "=", orgSlug).executeTakeFirstOrThrow();
  await h.db
    .insertInto("github_installations")
    .values({
      id: `ghi_${orgSlug}_${installationId}`,
      org_id: org.id,
      installation_id: installationId,
      account_login: login,
      account_type: "Organization",
      created_by: "user:test",
      created_at: h.now().toISOString(),
    })
    .execute();
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

async function put(uri: string, content: string, token?: string, org?: string) {
  const path = join(h.dir, `src-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(path, content);
  return runOperation(
    ops.put,
    { file: path, uri, content_type: "text/plain" },
    h.runner(token, org ? { org } : undefined),
  );
}

function list(uri: string, token?: string, org?: string) {
  return runOperation(ops.list, { uri }, h.runner(token, org ? { org } : undefined));
}

async function auditEvents(action: string) {
  const { events } = await runOperation(ops.audit, { uri: ORG, limit: 100 }, h.runner());
  return events.filter((e) => e.action === action);
}

async function slugs(): Promise<string[]> {
  const { collections } = await runOperation(ops.collections, {}, h.runner());
  return collections.map((c) => c.slug).sort();
}

/** Creates the org `beta` with its own admin and the same GitHub installation, and returns a user who writes in both orgs. */
async function twoOrgWriter(): Promise<string> {
  const email = "wes@acme.com";
  const token = await h.addUser(email, "writer");
  await bootstrapAdmin(h.db, { org: "beta", email: "admin@beta.com" });
  await linkInstallation("beta");
  const beta = await h.db.selectFrom("orgs").select("id").where("slug", "=", "beta").executeTakeFirstOrThrow();
  await h.db
    .insertInto("grants")
    .values({
      id: "grt_wes_beta",
      principal: `user:usr_${email.replace(/\W/g, "")}`,
      role: "writer",
      org_id: beta.id,
      collection_id: null,
      created_at: h.now().toISOString(),
    })
    .execute();
  return token;
}

describe("creating on first write", () => {
  it("creates and binds the collection with the org's default rules, and audits the binding", async () => {
    const defaults = [{ prefix: "tmp/", delete_after: "7d" }];
    await runOperation(ops.setLifecycle, { uri: ORG, rules: defaults }, h.runner());

    const out = await put("gh-pr:acme/web#482/shots/a.png", "png");
    expect(out.uri).toBe(`${COLLECTION}shots/a.png`);
    expect(out.version).toBe(1);

    const { collections } = await runOperation(ops.collections, {}, h.runner());
    expect(collections).toHaveLength(1);
    expect(collections[0]).toMatchObject({ uri: COLLECTION, slug: "web-pr-482", title: "acme/web#482" });
    const lifecycle = await runOperation(ops.lifecycle, { uri: COLLECTION }, h.runner());
    expect(lifecycle.binding).toMatchObject({ target: TARGET, state: "open" });
    expect(lifecycle.rules).toEqual(defaults);
    expect(github.calls).toContainEqual({ installationId: INSTALLATION, key: "acme/web#482" });

    const stat = await runOperation(ops.stat, { uri: `${COLLECTION}shots/a.png` }, h.runner());
    expect(stat.version).toBe(1);

    const bound = await auditEvents("binding.create");
    expect(bound).toHaveLength(1);
    expect(bound[0]?.target).toBe(COLLECTION);
    expect(bound[0]?.detail).toMatchObject({ target: TARGET });
    expect(bound[0]?.actor).toMatch(/^user:/);
  });

  it("reuses the collection on later writes and returns storage URIs from reads", async () => {
    await put("gh-pr:acme/web#482/shots/a.png", "one");
    await put("gh-pr:acme/web#482/shots/b.png", "two");
    expect(await auditEvents("binding.create")).toHaveLength(1);
    expect(await slugs()).toEqual(["web-pr-482"]);

    const listed = await list(PR);
    expect(listed.uri).toBe(COLLECTION);
    expect(listed.prefixes.map((p) => p.path)).toEqual(["shots/"]);
    const inFolder = await list("gh-pr:acme/web#482/shots/");
    expect(inFolder.objects.map((o) => o.uri).sort()).toEqual([`${COLLECTION}shots/a.png`, `${COLLECTION}shots/b.png`]);

    const stat = await runOperation(ops.stat, { uri: "gh-pr:acme/web#482/shots/a.png" }, h.runner());
    expect(stat.uri).toBe(`${COLLECTION}shots/a.png`);
    const got = await runOperation(ops.get, { uri: "gh-pr:acme/web#482/shots/a.png@1" }, h.runner());
    expect(got.uri).toBe(`${COLLECTION}shots/a.png`);
    expect(got.version).toBe(1);
  });

  it("lands in a collection that was bound by hand", async () => {
    await runOperation(ops.create, { uri: "storage://acme/screens/" }, h.runner());
    await runOperation(ops.bind, { uri: "storage://acme/screens/", target: "github:acme/web#482" }, h.runner());

    const out = await put("gh-pr:acme/web#482/a.txt", "x");
    expect(out.uri).toBe("storage://acme/screens/a.txt");
    expect(await slugs()).toEqual(["screens"]);
    expect((await list(PR)).uri).toBe("storage://acme/screens/");
    expect(await auditEvents("binding.create")).toHaveLength(1);
  });

  it("slugs the repo name, cutting a long repo to fit 64 characters", async () => {
    github.pulls.set("acme/my.web_app#7", openPull());
    const out = await put("gh-pr:Acme/My.Web_App#7/a.txt", "x");
    expect(out.uri).toBe("storage://acme/my-web-app-pr-7/a.txt");

    const longRepo = "a".repeat(70);
    github.pulls.set(`acme/${longRepo}#7`, openPull());
    const long = await put(`gh-pr:acme/${longRepo}#7/a.txt`, "x");
    expect(long.uri).toBe(`storage://acme/${"a".repeat(59)}-pr-7/a.txt`);
    expect(await slugs()).toEqual([`${"a".repeat(59)}-pr-7`, "my-web-app-pr-7"]);
  });

  it("leaves nothing behind when GitHub says the PR is not visible", async () => {
    github.pulls.delete("acme/web#482");
    const error = await expectError(put("gh-pr:acme/web#482/a.txt", "x"), "not_found");
    expect(error.message).toMatch(/isn't visible to the GitHub App/);
    expect(await slugs()).toEqual([]);
    expect(await auditEvents("binding.create")).toEqual([]);
    expect(await auditEvents("collection.create")).toEqual([]);

    github.pulls.set("acme/web#482", { status: 500 });
    await expectError(put("gh-pr:acme/web#482/a.txt", "x"), "unavailable");
    expect(await slugs()).toEqual([]);
  });
});

describe("resolving without creating", () => {
  it("is not_found with the bind hint on an unbound PR, and creates nothing", async () => {
    const error = await expectError(list(PR), "not_found");
    expect(error.message).toContain("is bound to github:acme/web#482");
    expect(error.hint).toContain("storage bind storage://acme/");
    expect(error.hint).toContain("github:acme/web#482");
    expect(await slugs()).toEqual([]);
    expect(await auditEvents("collection.create")).toEqual([]);
  });

  it("is a conflict with the bind hint when the slug is taken by an unbound collection", async () => {
    await runOperation(ops.create, { uri: COLLECTION }, h.runner());
    const error = await expectError(put("gh-pr:acme/web#482/a.txt", "x"), "conflict");
    expect(error.message).toContain("already exists and isn't bound to");
    expect(error.hint).toContain("storage bind storage://acme/web-pr-482/ github:acme/web#482");
    expect(await auditEvents("binding.create")).toEqual([]);
    expect((await list(COLLECTION)).objects).toEqual([]);
  });
});

describe("which org", () => {
  it("is not_found when no org has an installation for the owner", async () => {
    const error = await expectError(list("gh-pr:other/web#1/"), "not_found");
    expect(error.message).toContain("No org you can access has the GitHub App installed for other");
    expect(error.hint).toContain("storage github install");
    await expectError(put("gh-pr:other/web#1/a.txt", "x"), "not_found");
    expect(await slugs()).toEqual([]);
  });

  it("is not_found when an explicit org has no installation for the owner", async () => {
    await bootstrapAdmin(h.db, { org: "beta", email: "admin@beta.com" });
    const error = await expectError(list(PR, undefined, "beta"), "not_found");
    expect(error.message).toContain("has no GitHub installation for acme");
    expect(error.hint).toContain("storage github install storage://beta/");
  });

  it("is ambiguous across two orgs, and an explicit org picks one", async () => {
    const wes = await twoOrgWriter();
    const error = await expectError(put("gh-pr:acme/web#482/a.txt", "x", wes), "invalid_argument");
    expect(error.message).toContain("matches several orgs");
    expect(error.message).toContain("acme");
    expect(error.message).toContain("beta");
    expect(error.hint).toContain("storage set-default-org");

    const api = h.runner(wes).api;
    const direct = await expectError(
      api.call(ops.resolveShorthand, { uri: PR, operation: "list" }),
      "invalid_argument",
    );
    expect(direct.message).toContain("matches several orgs");
    expect(await slugs()).toEqual([]);

    const viaOrg = await put("gh-pr:acme/web#482/a.txt", "x", wes, "beta");
    expect(viaOrg.uri).toBe("storage://beta/web-pr-482/a.txt");

    const viaApi = await api.call(ops.resolveShorthand, { uri: PR, operation: "put", org: "acme" });
    expect(viaApi).toMatchObject({ collection: COLLECTION, target: TARGET, created: true, uri: COLLECTION });
  });

  it("uses the default org when several orgs match", async () => {
    const wes = await twoOrgWriter();
    await runOperation(ops.setDefaultOrg, { org: "beta" }, h.runner(wes));
    const out = await put("gh-pr:acme/web#482/a.txt", "x", wes);
    expect(out.uri).toBe("storage://beta/web-pr-482/a.txt");
    expect(await list("gh-pr:acme/web#482/", wes)).toMatchObject({ uri: "storage://beta/web-pr-482/" });
  });

  it("lets an explicit org override the default org, strictly", async () => {
    const wes = await twoOrgWriter();
    await runOperation(ops.setDefaultOrg, { org: "beta" }, h.runner(wes));
    const out = await put("gh-pr:acme/web#482/a.txt", "x", wes, "acme");
    expect(out.uri).toBe(`${COLLECTION}a.txt`);

    // An explicit org without an installation fails even though the default org would match.
    await bootstrapAdmin(h.db, { org: "gamma", email: "admin@gamma.com" });
    const gamma = await h.db.selectFrom("orgs").select("id").where("slug", "=", "gamma").executeTakeFirstOrThrow();
    await h.db
      .insertInto("grants")
      .values({
        id: "grt_wes_gamma",
        principal: "user:usr_wesacmecom",
        role: "writer",
        org_id: gamma.id,
        collection_id: null,
        created_at: h.now().toISOString(),
      })
      .execute();
    const error = await expectError(put("gh-pr:acme/web#482/b.txt", "x", wes, "gamma"), "not_found");
    expect(error.message).toContain("has no GitHub installation for acme");
  });

  it("ignores a default org that isn't a candidate", async () => {
    const wes = await twoOrgWriter();
    // gamma: wes can access it, but it has no installation.
    await bootstrapAdmin(h.db, { org: "gamma", email: "admin@gamma.com" });
    const gamma = await h.db.selectFrom("orgs").select("id").where("slug", "=", "gamma").executeTakeFirstOrThrow();
    await h.db
      .insertInto("grants")
      .values({
        id: "grt_wes_gamma",
        principal: "user:usr_wesacmecom",
        role: "writer",
        org_id: gamma.id,
        collection_id: null,
        created_at: h.now().toISOString(),
      })
      .execute();
    await runOperation(ops.setDefaultOrg, { org: "gamma" }, h.runner(wes));

    // Still ambiguous between acme and beta.
    const ambiguous = await expectError(put("gh-pr:acme/web#482/a.txt", "x", wes), "invalid_argument");
    expect(ambiguous.message).toContain("matches several orgs");
    expect(ambiguous.message).not.toContain("gamma");

    // No candidate at all stays a no-match.
    const none = await expectError(list("gh-pr:other/web#1/", wes), "not_found");
    expect(none.message).toContain("No org you can access has the GitHub App installed for other");
    expect(await slugs()).toEqual([]);
  });

  it("is ambiguous again after the default org is cleared", async () => {
    const wes = await twoOrgWriter();
    await runOperation(ops.setDefaultOrg, { org: "beta" }, h.runner(wes));
    await put("gh-pr:acme/web#482/a.txt", "x", wes);
    await runOperation(ops.setDefaultOrg, { clear: true }, h.runner(wes));
    const error = await expectError(put("gh-pr:acme/web#482/b.txt", "x", wes), "invalid_argument");
    expect(error.message).toContain("matches several orgs");
    expect(error.hint).toContain("storage set-default-org");
  });
});

describe("access", () => {
  it("lets an org reader read but not create, and a reader of only the bound collection read", async () => {
    await put("gh-pr:acme/web#482/a.txt", "x");
    const reader = await h.addUser("rita@acme.com", "reader");
    expect((await list(PR, reader)).objects.map((o) => o.path)).toEqual(["a.txt"]);

    const bare = await expectError(put("gh-pr:acme/web#482/b.txt", "y", reader), "forbidden");
    expect(bare.code).toBe("forbidden");

    github.pulls.set("acme/web#9", openPull());
    await expectError(put("gh-pr:acme/web#9/a.txt", "y", reader), "not_found");
    expect(await slugs()).toEqual(["web-pr-482"]);

    const scopedReader = await h.addUser("carl@acme.com", "reader", { collectionSlug: "web-pr-482" });
    expect((await list(PR, scopedReader)).objects.map((o) => o.path)).toEqual(["a.txt"]);
    await expectError(put("gh-pr:acme/web#9/a.txt", "y", scopedReader), "not_found");
  });

  it("checks allowed_tools against the operation being resolved for", async () => {
    await put("gh-pr:acme/web#482/a.txt", "x");
    const { token } = await h.runner().api.call(ops.tokenCreate, {
      name: "list-only",
      scopes: [{ collection: "acme/*", role: "writer" }],
      allowed_tools: ["list"],
    });
    expect((await list(PR, token)).uri).toBe(COLLECTION);
    const api = h.runner(token).api;
    expect(await api.call(ops.resolveShorthand, { uri: PR, operation: "list" })).toMatchObject({
      collection: COLLECTION,
    });
    await expectError(api.call(ops.resolveShorthand, { uri: PR, operation: "put" }), "forbidden");
    await expectError(put("gh-pr:acme/web#482/b.txt", "y", token), "forbidden");
    expect(await api.call(ops.list, { uri: "gh-pr:acme/web#482/shots/" })).toMatchObject({ objects: [] });
  });

  it("refuses a scoped token that can't write the new slug, and allows one that can", async () => {
    const outside = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/other-*", role: "writer" }] });
    const error = await put("gh-pr:acme/web#482/a.txt", "x", outside).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StorageError);
    expect(["forbidden", "not_found"]).toContain((error as StorageError).code);
    expect(await slugs()).toEqual([]);

    const inside = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/web-pr-*", role: "writer" }] });
    expect((await put("gh-pr:acme/web#482/a.txt", "x", inside)).uri).toBe(`${COLLECTION}a.txt`);
  });

  it("refuses share links", async () => {
    await put("gh-pr:acme/web#482/a.txt", "x");
    const { secret } = await h.runner().api.call(ops.linkCreate, { uri: COLLECTION, expires_in_days: 7 });
    await expectError(list(PR, secret), "forbidden");
    await expectError(h.runner(secret).api.call(ops.list, { uri: PR }), "forbidden");
    await expectError(h.runner(secret).api.call(ops.resolveShorthand, { uri: PR, operation: "list" }), "forbidden");
    expect((await list(COLLECTION, secret)).objects).toHaveLength(1);
  });
});

describe("branch form", () => {
  it("finds the open PR for the head branch and lands in its collection", async () => {
    const out = await put("gh-pr:acme/web@feature%2Flogin/x.txt", "x");
    expect(out.uri).toBe(`${COLLECTION}x.txt`);
    expect((await runOperation(ops.lifecycle, { uri: COLLECTION }, h.runner())).binding?.target).toBe(TARGET);
    expect((await list("gh-pr:acme/web@feature%2Flogin/")).uri).toBe(COLLECTION);
    // The number form lands in the same collection.
    expect((await list(PR)).objects.map((o) => o.path)).toEqual(["x.txt"]);
  });

  it("is not_found when no open PR has the head branch", async () => {
    const error = await expectError(put("gh-pr:acme/web@nope/x.txt", "x"), "not_found");
    expect(error.message).toContain("No open pull request in acme/web has the head branch nope");
    expect(await slugs()).toEqual([]);
    await expectError(list("gh-pr:acme/web@feature%2Flogin/"), "not_found");
  });
});

describe("operations without the shorthand", () => {
  it("rejects gh-pr: URIs on create and bind", async () => {
    const created = await expectError(runOperation(ops.create, { uri: PR }, h.runner()), "invalid_argument");
    expect(created.message).toContain("shorthand can't be used with this operation");
    await expectError(h.runner().api.call(ops.create, { uri: PR }), "invalid_argument");
    await expectError(runOperation(ops.bind, { uri: PR, target: TARGET }, h.runner()), "invalid_argument");
    await expectError(h.runner().api.call(ops.bind, { uri: PR, target: TARGET }), "invalid_argument");
    expect(await slugs()).toEqual([]);
  });

  it("rejects resolve_shorthand for an operation that doesn't take it, or doesn't exist", async () => {
    const api = h.runner().api;
    await expectError(api.call(ops.resolveShorthand, { uri: PR, operation: "create" }), "invalid_argument");
    await expectError(api.call(ops.resolveShorthand, { uri: PR, operation: "nope" }), "invalid_argument");
    await expectError(api.call(ops.resolveShorthand, { uri: "gh-pr:acme/web", operation: "list" }), "invalid_argument");
  });
});

describe("resolve_shorthand", () => {
  it("returns the storage URI, collection, target and whether it created the collection", async () => {
    const api = h.runner().api;
    const first = await api.call(ops.resolveShorthand, {
      uri: "gh-pr:acme/web#482/shots/a.png@2",
      operation: "put",
    });
    expect(first).toEqual({ uri: `${COLLECTION}shots/a.png@2`, collection: COLLECTION, target: TARGET, created: true });
    const second = await api.call(ops.resolveShorthand, { uri: PR, operation: "put" });
    expect(second).toEqual({ uri: COLLECTION, collection: COLLECTION, target: TARGET, created: false });
  });

  it("is rewritten server-side for direct API calls", async () => {
    const api = h.runner().api;
    await put("gh-pr:acme/web#482/a.txt", "x");
    const listed = await api.call(ops.list, { uri: PR });
    expect(listed.uri).toBe(COLLECTION);
    expect(listed.objects.map((o) => o.uri)).toEqual([`${COLLECTION}a.txt`]);
  });

  it("does not reach GitHub when the app isn't configured", async () => {
    await h.cleanup();
    h = await createHarness();
    await expectError(list(PR), "unavailable");
    await expectError(h.runner().api.call(ops.resolveShorthand, { uri: PR, operation: "list" }), "unavailable");
  });
});

describe("hosted MCP", () => {
  it("accepts a gh-pr: URI on the put tool", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${SERVER_URL}/mcp`), {
      fetch: h.fetch,
      requestInit: { headers: { authorization: `Bearer ${h.adminToken}` } },
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    clients.push(client);

    const result = (await client.callTool({
      name: "put",
      arguments: {
        uri: "gh-pr:acme/web#482/notes.txt",
        bytes: Buffer.from("hello").toString("base64"),
        content_type: "text/plain",
      },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ uri: `${COLLECTION}notes.txt`, version: 1 });
    expect(await slugs()).toEqual(["web-pr-482"]);
  });
});
