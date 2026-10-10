import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runOperation } from "@storage/client";
import { ops, type Scope, StorageError } from "@storage/core";
import { bootstrapAdmin, createUserToken } from "@storage/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureStream, createHarness, type Harness } from "./harness.js";

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

async function file(name: string, content: string): Promise<string> {
  const path = join(h.dir, name);
  await writeFile(path, content);
  return path;
}

const DAY = 24 * 60 * 60 * 1000;
const PR_WRITER: Scope[] = [{ collection: "acme/pr-*", role: "writer" }];

function create(uri: string, token?: string) {
  return runOperation(ops.create, { uri }, h.runner(token));
}

describe("token_create", () => {
  it("creates a scoped token for the caller's principal", async () => {
    const created = await h.runner().api.call(ops.tokenCreate, { name: "ci", scopes: PR_WRITER });
    expect(created.token).toMatch(/^storage_pat_/);
    expect(created.name).toBe("ci");
    expect(created.default_delivery).toBeNull();
    expect(created.scopes).toEqual(PR_WRITER);
    expect(Math.abs(Date.parse(created.expires_at ?? "") - (Date.now() + 90 * DAY))).toBeLessThan(60_000);

    const admin = await runOperation(ops.whoami, {}, h.runner());
    const me = await runOperation(ops.whoami, {}, h.runner(created.token));
    expect(me.principal).toBe(admin.principal);
    expect(me.token).toMatchObject({ id: created.id, name: "ci", scopes: PR_WRITER, default_delivery: null });
    expect(admin.token.scopes).toBeNull();
  });

  it("validates expiry, scopes and org access", async () => {
    const api = h.runner().api;
    const scopes = PR_WRITER;
    await expectError(api.call(ops.tokenCreate, { name: "x", scopes, expires_in_days: 91 }), "invalid_argument");
    await expectError(api.call(ops.tokenCreate, { name: "x", scopes: [] }), "invalid_argument");
    const missing = await expectError(
      api.call(ops.tokenCreate, { name: "x", scopes: [{ collection: "nope/*", role: "reader" }] }),
      "invalid_argument",
      /no access to org/,
    );

    await bootstrapAdmin(h.db, { org: "beta", email: "admin@beta.com" });
    const ungranted = await expectError(
      api.call(ops.tokenCreate, { name: "x", scopes: [{ collection: "beta/*", role: "reader" }] }),
      "invalid_argument",
      /no access to org/,
    );
    expect(ungranted.message.replace("beta", "nope")).toBe(missing.message);
  });
});

describe("scoped authorization", () => {
  it("lets a writer scope work inside its collections only", async () => {
    await create("storage://acme/docs/");
    const token = await h.createToken(h.adminToken, { scopes: PR_WRITER });
    const uri = "storage://acme/pr-1/a.txt";

    expect((await create("storage://acme/pr-1/", token)).created).toBe(true);
    expect((await runOperation(ops.put, { file: await file("a", "one"), uri }, h.runner(token))).version).toBe(1);
    expect((await runOperation(ops.list, { uri: "storage://acme/pr-1/" }, h.runner(token))).objects).toHaveLength(1);
    expect((await runOperation(ops.get, { uri }, h.runner(token))).delivery).toBe("ref");

    await expectError(create("storage://acme/other/", token), "forbidden", /scopes don't cover/);
    await expectError(
      runOperation(ops.list, { uri: "storage://acme/docs/" }, h.runner(token)),
      "forbidden",
      /scopes don't cover/,
    );
    await expectError(runOperation(ops.list, { uri: "storage://acme/pr-missing/" }, h.runner(token)), "not_found");
  });

  it("limits a reader scope to reading", async () => {
    await create("storage://acme/docs/");
    const uri = "storage://acme/docs/a.txt";
    await runOperation(ops.put, { file: await file("a", "one"), uri }, h.runner());
    const token = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/*", role: "reader" }] });

    expect((await runOperation(ops.list, { uri: "storage://acme/docs/" }, h.runner(token))).objects).toHaveLength(1);
    expect((await runOperation(ops.stat, { uri }, h.runner(token))).version).toBe(1);
    expect((await runOperation(ops.get, { uri }, h.runner(token))).delivery).toBe("ref");

    const put = await expectError(
      runOperation(ops.put, { file: await file("b", "two"), uri }, h.runner(token)),
      "forbidden",
      /allow reader access/,
    );
    expect(put.message).toContain("needs writer");
    await expectError(runOperation(ops.del, { uri }, h.runner(token)), "forbidden");
  });

  it("intersects scopes with the principal's grants", async () => {
    await create("storage://acme/docs/");
    await create("storage://acme/other/");
    const guest = await h.addUser("guest@example.com", "reader", { collectionSlug: "docs" });
    const token = await h.createToken(guest, { scopes: [{ collection: "acme/*", role: "admin" }] });

    await expectError(
      runOperation(ops.put, { file: await file("a", "one"), uri: "storage://acme/docs/a.txt" }, h.runner(token)),
      "forbidden",
      /You have reader access/,
    );
    await expectError(runOperation(ops.list, { uri: "storage://acme/other/" }, h.runner(token)), "not_found");
  });

  it("filters the collections listing by scope and still paginates", async () => {
    for (const slug of ["pr-1", "pr-2", "docs"]) {
      await create(`storage://acme/${slug}/`);
    }
    const token = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/pr-*", role: "reader" }] });

    const all = await runOperation(ops.collections, {}, h.runner(token));
    expect(all.collections.map((c) => c.slug).sort()).toEqual(["pr-1", "pr-2"]);

    const page1 = await runOperation(ops.collections, { limit: 1 }, h.runner(token));
    expect(page1.collections).toHaveLength(1);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await runOperation(ops.collections, { limit: 1, cursor: page1.next_cursor ?? "" }, h.runner(token));
    expect(page2.collections).toHaveLength(1);
    expect([...page1.collections, ...page2.collections].map((c) => c.slug).sort()).toEqual(["pr-1", "pr-2"]);
  });

  it("re-checks the committing token's scope on upload_commit", async () => {
    await create("storage://acme/pr-1/");
    await create("storage://acme/docs/");
    const tokenA = await h.createToken(h.adminToken, { scopes: PR_WRITER });
    const tokenB = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/docs", role: "writer" }] });

    const content = "scoped-bytes";
    const initiated = await h.runner(tokenA).api.call(ops.uploadInitiate, {
      uri: "storage://acme/pr-1/a.txt",
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      content_type: "text/plain",
    });
    if (initiated.upload) {
      const transfer = await h.fetch(initiated.upload.url, {
        method: "PUT",
        headers: initiated.upload.headers,
        body: content,
      });
      expect(transfer.ok).toBe(true);
    }
    await expectError(h.runner(tokenB).api.call(ops.uploadCommit, { upload_id: initiated.upload_id }), "forbidden");
    const committed = await h.runner(tokenA).api.call(ops.uploadCommit, { upload_id: initiated.upload_id });
    expect(committed.version).toBe(1);
  });
});

describe("token_revoke", () => {
  it("revokes idempotently and hides other principals' tokens", async () => {
    const created = await h.runner().api.call(ops.tokenCreate, { name: "ci", scopes: PR_WRITER });
    await runOperation(ops.whoami, {}, h.runner(created.token));

    const first = await h.runner().api.call(ops.tokenRevoke, { id: created.id });
    expect(first.id).toBe(created.id);
    await expectError(runOperation(ops.whoami, {}, h.runner(created.token)), "unauthenticated", /revoked/);

    h.advance(5000);
    const second = await h.runner().api.call(ops.tokenRevoke, { id: created.id });
    expect(second.revoked_at).toBe(first.revoked_at);

    await expectError(h.runner().api.call(ops.tokenRevoke, { id: "tok_unknown" }), "not_found");

    const live = await h.runner().api.call(ops.tokenCreate, { name: "live", scopes: PR_WRITER });
    const other = await h.addUser("other@acme.com", "admin");
    await expectError(h.runner(other).api.call(ops.tokenRevoke, { id: live.id }), "not_found");
    await runOperation(ops.whoami, {}, h.runner(live.token));
  });

  it("lets scoped tokens revoke only themselves and the tokens created from them", async () => {
    const other = await h.runner().api.call(ops.tokenCreate, { name: "other", scopes: PR_WRITER });
    const created = await h.runner().api.call(ops.tokenCreate, { name: "ci", scopes: PR_WRITER });
    const scoped = h.runner(created.token).api;

    await expectError(
      scoped.call(ops.tokenRevoke, { id: other.id }),
      "forbidden",
      /can only revoke itself and the tokens created from it/,
    );

    const revoked = await scoped.call(ops.tokenRevoke, { id: created.id });
    expect(revoked.id).toBe(created.id);
    await expectError(runOperation(ops.whoami, {}, h.runner(created.token)), "unauthenticated");
  });
});

describe("token_list", () => {
  it("lists newest first without revoked tokens, flags current and expired, and never leaks secrets", async () => {
    const me = await runOperation(ops.whoami, {}, h.runner());
    const lister = await createUserToken(h.db, { principal: me.principal, expiresAt: null });
    const api = h.runner(h.adminToken).api;

    const a = await api.call(ops.tokenCreate, { name: "first", scopes: PR_WRITER });
    h.advance(1000);
    const b = await api.call(ops.tokenCreate, { name: "second", scopes: PR_WRITER });
    h.advance(1000);
    const c = await api.call(ops.tokenCreate, { name: "gone", scopes: PR_WRITER });
    await api.call(ops.tokenRevoke, { id: c.id });

    const listed = await h.runner(lister).api.call(ops.tokenList, {});
    const ours = listed.tokens.filter((t) => [a.id, b.id, c.id].includes(t.id));
    expect(ours.map((t) => t.name)).toEqual(["second", "first"]);
    expect(listed.tokens.filter((t) => t.current)).toHaveLength(1);
    expect(listed.tokens.filter((t) => t.current)[0]?.id).not.toBe(a.id);
    expect(ours.every((t) => !t.current && !t.expired)).toBe(true);
    expect(ours[0]?.scopes).toEqual(PR_WRITER);
    for (const entry of listed.tokens) {
      expect(entry).not.toHaveProperty("token");
      expect(entry).not.toHaveProperty("token_hash");
      expect(entry).not.toHaveProperty("secret");
    }

    h.advance(91 * DAY);
    const later = await h.runner(lister).api.call(ops.tokenList, {});
    expect(later.tokens.find((t) => t.id === a.id)?.expired).toBe(true);
  });
});

describe("user tokens", () => {
  it("requires scopes", async () => {
    await expectError(h.runner().api.call(ops.tokenCreate, { name: "x" }), "invalid_argument", /at least one scope/);
  });

  it("rejects expires_in_days over 90", async () => {
    await expectError(
      h.runner().api.call(ops.tokenCreate, { name: "x", scopes: PR_WRITER, expires_in_days: 91 }),
      "invalid_argument",
    );
  });
});

describe("child tokens", () => {
  const api = () => h.runner().api;
  const parentToken = (extra: Record<string, unknown> = {}) =>
    api().call(ops.tokenCreate, { name: "parent", scopes: PR_WRITER, ...extra });
  const as = (token: string) => h.runner(token).api;

  it("is created by a scoped user token with the same principal and inherited scopes", async () => {
    const parent = await parentToken();
    const child = await as(parent.token).call(ops.tokenCreate, { name: "child" });
    expect(child.token).toMatch(/^storage_pat_/);
    expect(child.parent_id).toBe(parent.id);
    expect(child.principal).toBe(parent.principal);
    expect(child.scopes).toEqual(PR_WRITER);
    expect(child.id).not.toBe(parent.id);
    await runOperation(ops.whoami, {}, h.runner(child.token));
  });

  it("accepts narrower scopes", async () => {
    const parent = await parentToken();
    const child = await as(parent.token).call(ops.tokenCreate, {
      name: "child",
      scopes: [{ collection: "acme/pr-1*", role: "reader" }],
    });
    expect(child.scopes).toEqual([{ collection: "acme/pr-1*", role: "reader" }]);
  });

  it("forbids a wider scope", async () => {
    const parent = await parentToken();
    await expectError(
      as(parent.token).call(ops.tokenCreate, { name: "c", scopes: [{ collection: "acme/*", role: "writer" }] }),
      "forbidden",
      /isn't within this token's scopes/,
    );
  });

  it("forbids a higher role", async () => {
    const parent = await parentToken();
    await expectError(
      as(parent.token).call(ops.tokenCreate, { name: "c", scopes: [{ collection: "acme/pr-*", role: "admin" }] }),
      "forbidden",
      /isn't within this token's scopes/,
    );
  });

  it("defaults to the parent's expiry and refuses a later one", async () => {
    const parent = await parentToken({ expires_in_days: 10 });
    const child = await as(parent.token).call(ops.tokenCreate, { name: "child" });
    expect(child.expires_at).toBe(parent.expires_at);

    await expectError(
      as(parent.token).call(ops.tokenCreate, { name: "late", expires_in_days: 11 }),
      "invalid_argument",
      /can't outlive its parent/,
    );
    const sooner = await as(parent.token).call(ops.tokenCreate, { name: "soon", expires_in_days: 5 });
    expect(Math.abs(Date.parse(sooner.expires_at ?? "") - (Date.now() + 5 * DAY))).toBeLessThan(60_000);
  });

  it("forbids allowed_tools that aren't a subset of the parent's", async () => {
    const parent = await parentToken({ allowed_tools: ["get", "list"] });
    await expectError(
      as(parent.token).call(ops.tokenCreate, { name: "c", allowed_tools: ["get", "put"] }),
      "forbidden",
      /can't give a child access to put/,
    );
    const narrower = await as(parent.token).call(ops.tokenCreate, { name: "ok", allowed_tools: ["get"] });
    expect(narrower.allowed_tools).toEqual(["get"]);
    const inherited = await as(parent.token).call(ops.tokenCreate, { name: "inherit" });
    expect(inherited.allowed_tools).toEqual(["get", "list"]);
  });

  it("uses the service prefix for a child of a service token, and forbids passing service", async () => {
    await api().call(ops.serviceCreate, { org: "acme", name: "bugbot" });
    const svc = await api().call(ops.tokenCreate, { name: "bot", service: "acme/bugbot" });
    const child = await as(svc.token).call(ops.tokenCreate, { name: "child" });
    expect(child.token).toMatch(/^storage_svc_/);
    expect(child.principal).toBe("service:acme/bugbot");
    expect(child.parent_id).toBe(svc.id);
  });

  it("forbids a child from naming a service", async () => {
    await api().call(ops.serviceCreate, { org: "acme", name: "bugbot" });
    const parent = await parentToken();
    await expectError(
      as(parent.token).call(ops.tokenCreate, { name: "x", service: "acme/bugbot" }),
      "forbidden",
      /Only an unscoped user token can create service tokens/,
    );
  });

  it("lists the calling token and its descendants only", async () => {
    const parent = await parentToken();
    const unrelated = await parentToken();
    const child = await as(parent.token).call(ops.tokenCreate, { name: "child" });
    const grand = await as(child.token).call(ops.tokenCreate, { name: "grand" });

    const fromParent = await as(parent.token).call(ops.tokenList, {});
    expect(fromParent.tokens.map((t) => t.id).sort()).toEqual([parent.id, child.id, grand.id].sort());
    expect(fromParent.tokens.find((t) => t.current)?.id).toBe(parent.id);
    expect(fromParent.tokens.find((t) => t.id === child.id)?.parent_id).toBe(parent.id);
    expect(fromParent.tokens.map((t) => t.id)).not.toContain(unrelated.id);

    const fromChild = await as(child.token).call(ops.tokenList, {});
    expect(fromChild.tokens.map((t) => t.id).sort()).toEqual([child.id, grand.id].sort());
  });

  it("cascades revocation from a parent to its descendants", async () => {
    const parent = await parentToken();
    const child = await as(parent.token).call(ops.tokenCreate, { name: "child" });
    const grand = await as(child.token).call(ops.tokenCreate, { name: "grand" });

    const revoked = await as(parent.token).call(ops.tokenRevoke, { id: parent.id });
    expect([...revoked.also_revoked].sort()).toEqual([child.id, grand.id].sort());
    for (const token of [parent.token, child.token, grand.token]) {
      await expectError(runOperation(ops.whoami, {}, h.runner(token)), "unauthenticated");
    }
  });

  it("can't revoke its parent or an unrelated token", async () => {
    const parent = await parentToken();
    const unrelated = await parentToken();
    const child = await as(parent.token).call(ops.tokenCreate, { name: "child" });

    await expectError(as(child.token).call(ops.tokenRevoke, { id: parent.id }), "forbidden");
    await expectError(as(parent.token).call(ops.tokenRevoke, { id: unrelated.id }), "forbidden");
    await runOperation(ops.whoami, {}, h.runner(parent.token));
    await runOperation(ops.whoami, {}, h.runner(unrelated.token));
  });
});

describe("allowed_tools", () => {
  const SCOPES: Scope[] = [{ collection: "acme/*", role: "writer" }];

  it("limits the operations a token can call", async () => {
    await create("storage://acme/docs/");
    const uri = "storage://acme/docs/a.txt";
    await runOperation(ops.put, { file: await file("a", "one"), uri }, h.runner());
    const created = await h
      .runner()
      .api.call(ops.tokenCreate, { name: "ro", scopes: SCOPES, allowed_tools: ["get", "list"] });
    expect(created.allowed_tools).toEqual(["get", "list"]);
    const runner = h.runner(created.token);

    expect((await runOperation(ops.list, { uri: "storage://acme/docs/" }, runner)).objects).toHaveLength(1);
    expect((await runOperation(ops.get, { uri }, runner)).delivery).toBe("ref");
    await expectError(
      runOperation(ops.put, { file: await file("b", "two"), uri }, runner),
      "forbidden",
      /This token can't call/,
    );
  });

  it("still allows whoami and token_revoke, and whoami reports the list", async () => {
    const created = await h.runner().api.call(ops.tokenCreate, { name: "ro", scopes: SCOPES, allowed_tools: ["list"] });
    const me = await runOperation(ops.whoami, {}, h.runner(created.token));
    expect(me.token.allowed_tools).toEqual(["list"]);
    expect(me.token.parent_id).toBeNull();

    await h.runner(created.token).api.call(ops.tokenRevoke, { id: created.id });
    await expectError(runOperation(ops.whoami, {}, h.runner(created.token)), "unauthenticated");
  });

  it("rejects an unknown tool name", async () => {
    await expectError(
      h.runner().api.call(ops.tokenCreate, { name: "x", scopes: SCOPES, allowed_tools: ["nope" as never] }),
      "invalid_argument",
    );
  });
});

describe("default_delivery", () => {
  it("applies the token's default when delivery is omitted", async () => {
    await create("storage://acme/pr-1/");
    const uri = "storage://acme/pr-1/a.txt";
    await runOperation(ops.put, { file: await file("a", "hello inline"), uri }, h.runner());
    const token = await h.createToken(h.adminToken, { scopes: PR_WRITER, default_delivery: "inline" });

    const out = captureStream();
    const got = await runOperation(ops.get, { uri }, { ...h.runner(token), stdout: out.stream });
    expect(got.delivery).toBe("inline");
    expect(out.text()).toBe("hello inline");

    const explicit = await runOperation(ops.get, { uri, delivery: "ref" }, h.runner(token));
    expect(explicit.delivery).toBe("ref");

    expect((await runOperation(ops.get, { uri }, h.runner())).delivery).toBe("ref");
  });
});
