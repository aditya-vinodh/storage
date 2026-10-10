import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runCli } from "@storage/cli";
import { ApiClient, runOperation } from "@storage/client";
import { type AuditAction, ops, StorageError } from "@storage/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureStream, createHarness, type Harness, SERVER_URL } from "./harness.js";

let h: Harness;
const clients: Client[] = [];

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await h.cleanup();
});

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

const DAY = 24 * 60 * 60 * 1000;
const ORG = "storage://acme/";
const C1 = "storage://acme/c1/";
const C2 = "storage://acme/c2/";
const SHOTS = "storage://acme/c1/shots/";
const A = "storage://acme/c1/shots/a.txt";
const X = "storage://acme/c1/logs/x.txt";

async function put(uri: string, content: string, token?: string) {
  const path = join(h.dir, `src-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(path, content);
  return runOperation(ops.put, { file: path, uri, content_type: "text/plain" }, h.runner(token));
}

async function seed() {
  await runOperation(ops.create, { uri: C1 }, h.runner());
  await runOperation(ops.create, { uri: C2 }, h.runner());
  await put(A, "content a");
  await put("storage://acme/c1/shots/b.txt", "content b");
  await put(X, "content x");
  await put("storage://acme/c2/a.txt", "content c2");
}

function api(token: string): ApiClient {
  return new ApiClient({ server: SERVER_URL, token, fetch: h.fetch });
}

function linkCreate(uri: string, token = h.adminToken, extra: { name?: string; expires_in_days?: number } = {}) {
  return api(token).call(ops.linkCreate, { uri, expires_in_days: 7, ...extra });
}

function linkList(uri: string, token = h.adminToken) {
  return api(token).call(ops.linkList, { uri });
}

function linkRevoke(id: string, token = h.adminToken) {
  return api(token).call(ops.linkRevoke, { id });
}

function list(uri: string, token?: string) {
  return runOperation(ops.list, { uri }, h.runner(token));
}

function auditEvents(action?: AuditAction) {
  return runOperation(ops.audit, { uri: ORG, limit: 100, ...(action ? { action } : {}) }, h.runner()).then(
    (r) => r.events,
  );
}

describe("creating a link", () => {
  it("returns a prefixed secret and the link record, and doesn't store the secret", async () => {
    await seed();
    const before = Date.now();
    const out = await api(h.adminToken).call(ops.linkCreate, { uri: SHOTS, expires_in_days: 7 });
    expect(out.secret.startsWith("storage_link_")).toBe(true);
    expect(out.link.uri).toBe(SHOTS);
    expect(out.link.expired).toBe(false);
    expect(Math.abs(Date.parse(out.link.expires_at) - (before + 7 * DAY))).toBeLessThan(60_000);

    const rows = await h.db.selectFrom("links").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(out.link.id);
    expect(rows[0]?.token_hash).not.toBe(out.secret);
    expect(JSON.stringify(rows[0])).not.toContain(out.secret);
  });

  it("defaults to 7 days when expires_in_days is omitted", async () => {
    await seed();
    const before = Date.now();
    const out = await api(h.adminToken).call(ops.linkCreate, { uri: SHOTS });
    expect(Math.abs(Date.parse(out.link.expires_at) - (before + 7 * DAY))).toBeLessThan(60_000);
  });
});

describe("reading with a link", () => {
  it("lists, stats, reads history and gets objects under the prefix", async () => {
    await seed();
    const { secret } = await linkCreate(SHOTS);

    const listed = await list(SHOTS, secret);
    expect(listed.objects.map((o) => o.path).sort()).toEqual(["shots/a.txt", "shots/b.txt"]);

    const stat = await runOperation(ops.stat, { uri: A }, h.runner(secret));
    expect(stat.path).toBe("shots/a.txt");
    expect(stat.version).toBe(1);

    const history = await runOperation(ops.history, { uri: A }, h.runner(secret));
    expect(history.current_version).toBe(1);
    expect(history.versions).toHaveLength(1);

    const got = await runOperation(ops.get, { uri: A, to: "out-a.txt" }, h.runner(secret));
    expect(got.path).toBeDefined();
    expect(await readFile(got.path ?? "", "utf8")).toBe("content a");
  });

  it("is forbidden outside the prefix, other collections and unknown collections", async () => {
    await seed();
    const { secret } = await linkCreate(SHOTS);

    await expectError(list(C1, secret), "forbidden");
    await expectError(runOperation(ops.stat, { uri: X }, h.runner(secret)), "forbidden");
    await expectError(list(C2, secret), "forbidden");
    await expectError(list("storage://acme/nope/", secret), "forbidden");
  });

  it("is forbidden from every operation outside the allowlist", async () => {
    await seed();
    const { secret } = await linkCreate(SHOTS);
    const file = join(h.dir, "up.txt");
    await writeFile(file, "nope");

    await expectError(runOperation(ops.put, { file, uri: A }, h.runner(secret)), "forbidden");
    await expectError(runOperation(ops.del, { uri: A }, h.runner(secret)), "forbidden");
    await expectError(runOperation(ops.collections, { limit: 50 }, h.runner(secret)), "forbidden");
    await expectError(runOperation(ops.grants, { uri: C1 }, h.runner(secret)), "forbidden");
    await expectError(linkCreate(SHOTS, secret), "forbidden");

    // Nothing changed.
    const stat = await runOperation(ops.stat, { uri: A }, h.runner());
    expect(stat.version).toBe(1);
  });

  it("reports the link in whoami", async () => {
    await seed();
    const { secret, link } = await linkCreate(SHOTS);

    const me = await runOperation(ops.whoami, {}, h.runner(secret));
    expect(me.principal).toBe(`link:${link.id}`);
    expect(me.orgs).toEqual([]);
    expect(me.link).toEqual({ uri: SHOTS });
    expect(me.token.scopes).toEqual([{ collection: "acme/c1", role: "reader" }]);

    const admin = await runOperation(ops.whoami, {}, h.runner());
    expect(admin.link).toBeNull();
  });

  it("covers the whole collection when the link is on the collection URI", async () => {
    await seed();
    const { secret, link } = await linkCreate(C1);
    expect(link.uri).toBe(C1);

    const root = await list(C1, secret);
    expect(root.prefixes.map((p) => p.path.replace(/\/$/, "")).sort()).toEqual(["logs", "shots"]);
    const stat = await runOperation(ops.stat, { uri: X }, h.runner(secret));
    expect(stat.path).toBe("logs/x.txt");
    await expectError(list(C2, secret), "forbidden");
  });
});

describe("edge cases", () => {
  it("doesn't cover a sibling path that merely starts with the prefix name", async () => {
    await seed();
    await put("storage://acme/c1/shots-old/z.txt", "old");
    const { secret } = await linkCreate(SHOTS);
    await expectError(
      runOperation(ops.stat, { uri: "storage://acme/c1/shots-old/z.txt" }, h.runner(secret)),
      "forbidden",
    );
  });

  it("lists an empty prefix, then sees an object put there later", async () => {
    await seed();
    const empty = "storage://acme/c1/fresh/";
    const { secret } = await linkCreate(empty);
    const before = await list(empty, secret);
    expect(before.objects).toEqual([]);
    expect(before.prefixes).toEqual([]);
    await put(`${empty}n.txt`, "new");
    expect((await list(empty, secret)).objects.map((o) => o.path)).toEqual(["fresh/n.txt"]);
  });

  it("returns not_found when creating a link on a nonexistent collection", async () => {
    await seed();
    await expectError(linkCreate("storage://acme/nope/"), "not_found");
  });

  it("records no link.use for an expired or revoked secret", async () => {
    await seed();
    const count = async () =>
      (await h.db.selectFrom("audit_events").select("id").where("action", "=", "link.use").execute()).length;
    const revoked = await linkCreate(SHOTS);
    const expired = await linkCreate(SHOTS, h.adminToken, { expires_in_days: 1 });
    await linkRevoke(revoked.link.id);
    h.advance(2 * DAY);
    const before = await count();
    await expectError(list(SHOTS, revoked.secret), "unauthenticated");
    await expectError(list(SHOTS, expired.secret), "unauthenticated");
    expect(await count()).toBe(before);
  });
});

describe("expiry and the max", () => {
  it("rejects the secret after it expires", async () => {
    await seed();
    const { secret } = await linkCreate(SHOTS);
    await list(SHOTS, secret);
    h.advance(8 * DAY);
    await expectError(list(SHOTS, secret), "unauthenticated");
  });

  it("rejects expires_in_days above the configured max with invalid_argument", async () => {
    await seed();
    await expectError(linkCreate(SHOTS, h.adminToken, { expires_in_days: 31 }), "invalid_argument");
    expect((await linkCreate(SHOTS, h.adminToken, { expires_in_days: 30 })).link.expired).toBe(false);
  });

  it("forbids creating links when linkMaxDays is 0", async () => {
    const off = await createHarness({ config: { linkMaxDays: 0 } });
    try {
      await runOperation(ops.create, { uri: C1 }, off.runner());
      await expectError(
        new ApiClient({ server: SERVER_URL, token: off.adminToken, fetch: off.fetch }).call(ops.linkCreate, {
          uri: C1,
          expires_in_days: 7,
        }),
        "forbidden",
      );
    } finally {
      await off.cleanup();
    }
  });
});

describe("revoking", () => {
  it("stops the secret working, is idempotent, and not_found for unknown ids", async () => {
    await seed();
    const { secret, link } = await linkCreate(SHOTS);
    await list(SHOTS, secret);

    const first = await linkRevoke(link.id);
    expect(first.id).toBe(link.id);
    expect(first.uri).toBe(SHOTS);
    await expectError(list(SHOTS, secret), "unauthenticated");

    h.advance(1000);
    const second = await linkRevoke(link.id);
    expect(second.revoked_at).toBe(first.revoked_at);

    await expectError(linkRevoke("lnk_doesnotexist"), "not_found");
  });

  it("returns not_found to a user who can only read the collection", async () => {
    await seed();
    const { link } = await linkCreate(SHOTS);
    const reader = await h.addUser("rita@acme.com", "reader", { collectionSlug: "c1" });
    await expectError(linkRevoke(link.id, reader), "not_found");
    // Still works for the owner.
    expect((await linkRevoke(link.id)).id).toBe(link.id);
  });
});

describe("permissions", () => {
  it("needs collection admin to create a link", async () => {
    await seed();
    const writer = await h.addUser("wanda@acme.com", "writer", { collectionSlug: "c1" });
    const colAdmin = await h.addUser("carl@acme.com", "admin", { collectionSlug: "c1" });
    const scoped = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/c1", role: "reader" }] });

    await expectError(linkCreate(SHOTS, writer), "forbidden");
    await expectError(linkCreate(SHOTS, scoped), "forbidden");
    const out = await linkCreate(SHOTS, colAdmin);
    expect(out.secret.startsWith("storage_link_")).toBe(true);
    expect(out.link.created_by).toMatch(/^user:/);
  });
});

describe("listing links", () => {
  it("lists non-revoked links newest first with expired and last_used_at", async () => {
    await seed();
    const first = await linkCreate(SHOTS, h.adminToken, { name: "first", expires_in_days: 1 });
    h.advance(1000);
    const second = await linkCreate(C1, h.adminToken, { name: "second", expires_in_days: 7 });
    h.advance(1000);
    const third = await linkCreate(SHOTS, h.adminToken, { name: "third" });

    let out = await linkList(C1);
    expect(out.uri).toBe(C1);
    expect(out.links.map((l) => l.id)).toEqual([third.link.id, second.link.id, first.link.id]);
    expect(out.links.map((l) => l.name)).toEqual(["third", "second", "first"]);
    expect(out.links.every((l) => l.expired === false && l.last_used_at === null)).toBe(true);

    await list(SHOTS, second.secret);
    await linkRevoke(third.link.id);
    h.advance(2 * DAY);

    out = await linkList(C1);
    expect(out.links.map((l) => l.id)).toEqual([second.link.id, first.link.id]);
    const byId = new Map(out.links.map((l) => [l.id, l]));
    expect(byId.get(first.link.id)?.expired).toBe(true);
    expect(byId.get(first.link.id)?.last_used_at).toBeNull();
    expect(byId.get(second.link.id)?.expired).toBe(false);
    expect(byId.get(second.link.id)?.last_used_at).not.toBeNull();
  });

  it("doesn't list another collection's links", async () => {
    await seed();
    await linkCreate(SHOTS);
    expect((await linkList(C2)).links).toEqual([]);
  });

  it("is forbidden to a reader", async () => {
    await seed();
    await linkCreate(SHOTS);
    const reader = await h.addUser("rita@acme.com", "reader", { collectionSlug: "c1" });
    await expectError(linkList(C1, reader), "forbidden");
  });
});

describe("audit", () => {
  it("records link.create, link.use and link.revoke", async () => {
    await seed();
    const admin = await runOperation(ops.whoami, {}, h.runner());
    const { secret, link } = await linkCreate(SHOTS);
    h.advance(1000);
    await list(SHOTS, secret);
    h.advance(1000);
    await linkRevoke(link.id);

    const created = (await auditEvents("link.create")).filter((e) => e.target.includes(SHOTS));
    expect(created).toHaveLength(1);
    expect(created[0]?.actor).toBe(admin.principal);

    const used = await auditEvents("link.use");
    const listUse = used.find((e) => e.detail.operation === "list");
    expect(listUse?.actor).toBe(`link:${link.id}`);

    const revoked = await auditEvents("link.revoke");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.actor).toBe(admin.principal);
  });

  it("records a forbidden call as link.use with the attempted operation", async () => {
    await seed();
    const { secret, link } = await linkCreate(SHOTS);
    const file = join(h.dir, "up.txt");
    await writeFile(file, "nope");
    await expectError(runOperation(ops.put, { file, uri: A }, h.runner(secret)), "forbidden");

    const used = await auditEvents("link.use");
    const attempt = used.find((e) => e.detail.operation === "upload_initiate");
    expect(attempt).toBeDefined();
    expect(attempt?.actor).toBe(`link:${link.id}`);
  });

  it("records url.issue with the link as actor when a link gets an object", async () => {
    await seed();
    const { secret, link } = await linkCreate(SHOTS);
    await runOperation(ops.get, { uri: A, to: "out-audit.txt" }, h.runner(secret));

    const issued = await auditEvents("url.issue");
    expect(issued.some((e) => e.actor === `link:${link.id}`)).toBe(true);
  });
});

describe("hosted MCP", () => {
  async function connect(token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${SERVER_URL}/mcp`), {
      fetch: h.fetch,
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(transport);
    clients.push(c);
    return c;
  }

  it("lists only the read tools for a link", async () => {
    await seed();
    const { secret } = await linkCreate(SHOTS);
    const names = (await (await connect(secret)).listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get", "history", "list", "stat", "whoami"]);
  });

  it("returns a forbidden error result for history outside the prefix", async () => {
    await seed();
    const { secret } = await linkCreate(SHOTS);
    const c = await connect(secret);
    const result = (await c.callTool({ name: "history", arguments: { uri: X } })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({ error: { code: "forbidden" } });
  });

  it("returns a forbidden error result for put", async () => {
    await seed();
    const { secret } = await linkCreate(SHOTS);
    const c = await connect(secret);
    const result = (await c.callTool({
      name: "put",
      arguments: { uri: A, bytes: Buffer.from("x").toString("base64") },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    // Either the tool is unknown to the link, or it is refused; the error must say forbidden.
    expect(JSON.parse(text)).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("CLI", () => {
  async function cli(args: string[], env: Record<string, string | undefined> = {}) {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runCli(args, {
      env: {
        STORAGE_SERVER: SERVER_URL,
        STORAGE_TOKEN: h.adminToken,
        STORAGE_HOME: join(h.dir, "home"),
        STORAGE_CONFIG_DIR: join(h.dir, "config"),
        ...env,
      },
      cwd: h.dir,
      stdout: stdout.stream,
      stderr: stderr.stream,
      fetch: h.fetch,
    });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }

  it("creates, lists and revokes links, and whoami names the link", async () => {
    await seed();
    const created = await cli(["link", "create", SHOTS, "--expires", "3d"]);
    expect(created.code).toBe(0);
    expect(created.stdout).toMatch(/storage_link_\S+/);
    expect(created.stdout).toContain("STORAGE_TOKEN=");

    const json = await cli(["link", "create", SHOTS, "--expires", "3d", "--json"]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout) as { secret: string; link: { id: string; uri: string } };
    expect(parsed.secret.startsWith("storage_link_")).toBe(true);
    expect(parsed.link.uri).toBe(SHOTS);

    const listed = await cli(["link", "list", C1]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(parsed.link.id);

    const me = await cli(["whoami"], { STORAGE_TOKEN: parsed.secret });
    expect(me.code).toBe(0);
    expect(me.stdout).toContain("share link for");

    const revoked = await cli(["link", "revoke", parsed.link.id]);
    expect(revoked.code).toBe(0);
    expect(revoked.stdout).toContain("Revoked");
  });
});
