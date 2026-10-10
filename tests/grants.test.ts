import { join } from "node:path";
import { runCli } from "@storage/cli";
import { runOperation } from "@storage/client";
import { ops, StorageError } from "@storage/core";
import { createUserToken } from "@storage/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureStream, createHarness, type Harness, SERVER_URL } from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

async function expectError(promise: Promise<unknown>, code: string, message?: RegExp): Promise<StorageError> {
  const error = await promise.then(
    () => {
      throw new Error(`Expected a ${code} error`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StorageError);
  expect((error as StorageError).code).toBe(code);
  if (message) {
    expect((error as StorageError).message).toMatch(message);
  }
  return error as StorageError;
}

const ORG = "storage://acme/";
const C1 = "storage://acme/c1/";
const C2 = "storage://acme/c2/";

function create(uri: string, token?: string) {
  return runOperation(ops.create, { uri }, h.runner(token));
}

function grants(uri: string, token?: string) {
  return runOperation(ops.grants, { uri }, h.runner(token));
}

function share(uri: string, principal: string, role: "reader" | "writer" | "admin", token?: string) {
  return runOperation(ops.share, { uri, principal, role }, h.runner(token));
}

function unshare(uri: string, principal: string, token?: string) {
  return runOperation(ops.unshare, { uri, principal }, h.runner(token));
}

async function userRows(email: string) {
  return h.db.selectFrom("users").selectAll().where("email", "=", email).execute();
}

describe("grants", () => {
  it("lists org-level grants first, then collection grants, with emails", async () => {
    await create(C1);
    await h.addUser("bob@acme.com", "reader");
    await h.addUser("carol@acme.com", "writer", { collectionSlug: "c1" });

    const out = await grants(C1);
    expect(out.uri).toBe(C1);
    expect(out.grants.map((g) => [g.email, g.role, g.level, g.uri])).toEqual([
      ["admin@acme.com", "admin", "org", ORG],
      ["bob@acme.com", "reader", "org", ORG],
      ["carol@acme.com", "writer", "collection", C1],
    ]);
  });

  it("lists only org-level grants for an org URI", async () => {
    await create(C1);
    await h.addUser("bob@acme.com", "reader");
    await h.addUser("carol@acme.com", "writer", { collectionSlug: "c1" });

    const out = await grants(ORG);
    expect(out.grants.every((g) => g.level === "org" && g.uri === ORG)).toBe(true);
    expect(out.grants.map((g) => g.email).sort()).toEqual(["admin@acme.com", "bob@acme.com"]);
  });

  it("lets a collection-only reader list the collection but not the org", async () => {
    await create(C1);
    const carol = await h.addUser("carol@acme.com", "reader", { collectionSlug: "c1" });

    const out = await grants(C1, carol);
    expect(out.grants.map((g) => g.email)).toContain("carol@acme.com");
    await expectError(grants(ORG, carol), "not_found", /Org storage:\/\/acme\/ not found\./);
  });

  it("returns not_found for unreadable collections and unknown orgs", async () => {
    await create(C1);
    await create(C2);
    const carol = await h.addUser("carol@acme.com", "reader", { collectionSlug: "c1" });

    await expectError(grants(C2, carol), "not_found");
    await expectError(grants("storage://nope/"), "not_found");
  });

  it("rejects org-level listing for scoped tokens but allows collections", async () => {
    await create(C1);
    const scoped = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/*", role: "admin" }] });

    await expectError(grants(ORG, scoped), "forbidden");
    expect((await grants(C1, scoped)).grants.length).toBeGreaterThan(0);
  });

  it("rejects object URIs", async () => {
    await create(C1);
    await expectError(grants("storage://acme/c1/a.txt"), "invalid_argument");
  });
});

describe("share", () => {
  it("creates a user by email, grants the role, and lowercases the email", async () => {
    await create(C1);
    const out = await share(C1, "user:dave@example.com", "reader");
    expect(out.changed).toBe(true);
    expect(out.previous_role).toBeNull();
    expect(out.grant.principal).toMatch(/^user:usr_/);
    expect(out.grant.principal).not.toContain("@");
    expect(out.grant.email).toBe("dave@example.com");
    expect(out.grant.level).toBe("collection");
    expect(out.grant.role).toBe("reader");
    expect(await userRows("dave@example.com")).toHaveLength(1);

    const again = await share(C1, "user:Dave@Example.com", "reader");
    expect(again.changed).toBe(false);
    expect(again.previous_role).toBe("reader");
    expect(again.grant.principal).toBe(out.grant.principal);
  });

  it("changes the role of an existing grant", async () => {
    await create(C1);
    await share(C1, "user:dave@example.com", "reader");
    const out = await share(C1, "user:dave@example.com", "writer");
    expect(out.changed).toBe(true);
    expect(out.previous_role).toBe("reader");

    const dave = (await grants(C1)).grants.filter((g) => g.email === "dave@example.com");
    expect(dave).toHaveLength(1);
    expect(dave[0]).toMatchObject({ role: "writer", level: "collection" });
  });

  it("lets the shared user use the collection and no other", async () => {
    await create(C1);
    await create(C2);
    const out = await share(C1, "user:dave@example.com", "reader");
    const token = await createUserToken(h.db, { principal: out.grant.principal, expiresAt: null });

    await runOperation(ops.list, { uri: C1 }, h.runner(token));
    await expectError(runOperation(ops.list, { uri: C2 }, h.runner(token)), "not_found");
  });

  it("shares by user id and rejects unknown ids", async () => {
    // Harness-made users (usr_bobacmecom) don't have real ids, so use a user created by share.
    const first = await share(ORG, "user:dave@example.com", "reader");
    const out = await share(ORG, first.grant.principal, "writer");
    expect(out.changed).toBe(true);
    expect(out.previous_role).toBe("reader");
    expect(out.grant).toMatchObject({ principal: first.grant.principal, level: "org", role: "writer" });

    await expectError(share(ORG, `user:usr_${"0".repeat(20)}`, "writer"), "invalid_argument");
  });

  it("requires admin access, and an unscoped token for orgs", async () => {
    await create(C1);
    const writer = await h.addUser("carol@acme.com", "writer", { collectionSlug: "c1" });
    const reader = await h.addUser("bob@acme.com", "reader");
    const scoped = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/*", role: "admin" }] });

    await expectError(share(C1, "user:dave@example.com", "reader", writer), "forbidden");
    await expectError(share(ORG, "user:dave@example.com", "reader", reader), "forbidden");
    await expectError(share(ORG, "user:dave@example.com", "reader", scoped), "forbidden");
    expect((await share(C1, "user:dave@example.com", "reader", scoped)).changed).toBe(true);
  });

  it("doesn't create a user when unauthorized", async () => {
    await create(C1);
    const writer = await h.addUser("carol@acme.com", "writer", { collectionSlug: "c1" });
    await expectError(share(C1, "user:ghost@example.com", "reader", writer), "forbidden");
    expect(await userRows("ghost@example.com")).toHaveLength(0);
  });

  it("rejects invalid principals", async () => {
    await create(C1);
    for (const principal of ["bob", "group:x", "user:not-an-email"]) {
      await expectError(share(C1, principal, "reader"), "invalid_argument");
    }
  });

  it("refuses to demote the only org admin", async () => {
    await expectError(share(ORG, "user:admin@acme.com", "writer"), "precondition_failed");

    await share(ORG, "user:bob@acme.com", "admin");
    const out = await share(ORG, "user:admin@acme.com", "writer");
    expect(out.changed).toBe(true);
    expect(out.previous_role).toBe("admin");
  });
});

describe("unshare", () => {
  it("removes a collection grant", async () => {
    await create(C1);
    const carol = await h.addUser("carol@acme.com", "writer", { collectionSlug: "c1" });

    const out = await unshare(C1, "user:carol@acme.com");
    expect(out.removed).toMatchObject({ email: "carol@acme.com", role: "writer", level: "collection", uri: C1 });
    await expectError(runOperation(ops.list, { uri: C1 }, h.runner(carol)), "not_found");
  });

  it("returns not_found when there is no grant at that level, hinting at the org grant", async () => {
    await create(C1);
    await h.addUser("bob@acme.com", "reader");

    const error = await expectError(unshare(C1, "user:bob@acme.com"), "not_found");
    expect(error.hint).toContain("storage unshare storage://acme/");

    await share(ORG, "user:nobody@example.com", "reader");
    await unshare(ORG, "user:nobody@example.com");
    await expectError(unshare(ORG, "user:nobody@example.com"), "not_found");
  });

  it("doesn't create a user for an unknown email", async () => {
    await expectError(unshare(ORG, "user:ghost@example.com"), "not_found");
    expect(await userRows("ghost@example.com")).toHaveLength(0);
  });

  it("protects the last org admin but not collection admins", async () => {
    await create(C1);
    await expectError(unshare(ORG, "user:admin@acme.com"), "precondition_failed");

    await share(C1, "user:dave@example.com", "admin");
    const out = await unshare(C1, "user:dave@example.com");
    expect(out.removed.role).toBe("admin");
  });

  it("requires admin access", async () => {
    await create(C1);
    const writer = await h.addUser("carol@acme.com", "writer", { collectionSlug: "c1" });
    await expectError(unshare(C1, "user:carol@acme.com", writer), "forbidden");
  });
});

describe("CLI", () => {
  async function cli(args: string[]) {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runCli(args, {
      env: {
        STORAGE_SERVER: SERVER_URL,
        STORAGE_TOKEN: h.adminToken,
        STORAGE_HOME: join(h.dir, "home"),
        STORAGE_CONFIG_DIR: join(h.dir, "config"),
      },
      cwd: h.dir,
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetch: h.fetch,
    });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }

  it("shares and lists grants", async () => {
    await create(C1);
    const shared = await cli(["share", C1, "user:dave@example.com", "reader"]);
    expect(shared.code).toBe(0);
    expect(shared.stdout).toContain("Granted reader");

    const listed = await cli(["grants", C1, "--json"]);
    expect(listed.code).toBe(0);
    const parsed = JSON.parse(listed.stdout) as { grants: Array<{ email: string | null }> };
    expect(Array.isArray(parsed.grants)).toBe(true);
    expect(parsed.grants.map((g) => g.email)).toContain("dave@example.com");
  });
});
