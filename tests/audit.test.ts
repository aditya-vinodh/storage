import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runOperation } from "@storage/client";
import { type AuditAction, ops, StorageError } from "@storage/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, SERVER_URL } from "./harness.js";

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

const ORG = "storage://acme/";
const C1 = "storage://acme/c1/";
const A = "storage://acme/c1/a.txt";

function create(uri: string, token?: string) {
  return runOperation(ops.create, { uri }, h.runner(token));
}

async function put(uri: string, content: string, token?: string) {
  const path = join(h.dir, `src-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(path, content);
  return runOperation(ops.put, { file: path, uri, content_type: "text/plain" }, h.runner(token));
}

function audit(
  input: { action?: AuditAction; since?: string; limit?: number; cursor?: string } = {},
  token?: string,
  uri = ORG,
) {
  return runOperation(ops.audit, { uri, limit: 100, ...input }, h.runner(token));
}

function share(uri: string, principal: string, role: "reader" | "writer" | "admin") {
  return runOperation(ops.share, { uri, principal, role }, h.runner());
}

describe("audit log", () => {
  it("records grants, puts, url issues and deletes newest first with actor details", async () => {
    await create(C1);
    const content = "hello audit";
    await put(A, content);
    h.advance(1000);
    const got = await runOperation(ops.get, { uri: A, delivery: "ref" }, h.runner());
    expect(got.delivery).toBe("ref");
    h.advance(1000);
    await runOperation(ops.del, { uri: A }, h.runner());
    h.advance(1000);
    const shared = await share(C1, "user:dave@example.com", "reader");

    const me = await runOperation(ops.whoami, {}, h.runner());
    const { events } = await audit();
    const order = events
      .map((e) => e.action)
      .filter((a) => ["grant.create", "object.delete", "url.issue", "object.put"].includes(a));
    expect(order).toEqual(["grant.create", "object.delete", "url.issue", "object.put"]);

    const find = (action: string) => events.find((e) => e.action === action && e.target !== "storage://acme/c1/");
    const putEvent = events.find((e) => e.action === "object.put");
    expect(putEvent?.target).toBe(A);
    expect(putEvent?.detail).toMatchObject({
      version: 1,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.length,
      deduplicated: false,
    });
    expect(find("url.issue")?.target.endsWith("@1")).toBe(true);
    expect(events.find((e) => e.action === "object.delete")?.detail).toMatchObject({ count: 1 });
    expect(events.find((e) => e.action === "grant.create")?.detail).toMatchObject({
      principal: shared.grant.principal,
      role: "reader",
    });
    for (const event of events.filter((e) =>
      ["grant.create", "object.delete", "url.issue", "object.put"].includes(e.action),
    )) {
      expect(event.actor).toBe(me.principal);
      expect(event.token_id).toBe(me.token.id);
    }
  });

  it("records one object.put when an upload commit is retried", async () => {
    await create(C1);
    const content = "retry me";
    const api = h.runner().api;
    const initiated = await api.call(ops.uploadInitiate, {
      uri: A,
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      content_type: "text/plain",
    });
    if (initiated.upload) {
      const res = await h.fetch(initiated.upload.url, {
        method: "PUT",
        headers: initiated.upload.headers,
        body: content,
      });
      expect(res.ok).toBe(true);
    }
    const first = await api.call(ops.uploadCommit, { upload_id: initiated.upload_id });
    const second = await api.call(ops.uploadCommit, { upload_id: initiated.upload_id });
    expect(second.version).toBe(first.version);

    const { events } = await audit({ action: "object.put" });
    expect(events).toHaveLength(1);
  });

  it("records no event for an unchanged share, grant.update for a role change, grant.delete for unshare", async () => {
    await create(C1);
    await share(C1, "user:dave@example.com", "reader");
    expect((await audit()).events.map((e) => e.action)).toEqual(["grant.create"]);

    await share(C1, "user:dave@example.com", "reader");
    expect((await audit()).events).toHaveLength(1);

    await share(C1, "user:dave@example.com", "writer");
    const updated = (await audit({ action: "grant.update" })).events;
    expect(updated).toHaveLength(1);
    expect(updated[0]?.detail).toMatchObject({ previous_role: "reader", role: "writer" });

    await runOperation(ops.unshare, { uri: C1, principal: "user:dave@example.com" }, h.runner());
    expect((await audit({ action: "grant.delete" })).events).toHaveLength(1);
  });

  it("filters by action and since, and pages with a cursor", async () => {
    await create(C1);
    await put(A, "one");
    h.advance(10_000);
    const since = new Date(Date.now() + 10_000).toISOString();
    h.advance(10_000);
    await put(A, "two");
    await put("storage://acme/c1/b.txt", "three");
    await share(C1, "user:dave@example.com", "reader");

    const puts = await audit({ action: "object.put" });
    expect(puts.events).toHaveLength(3);
    expect(puts.events.every((e) => e.action === "object.put")).toBe(true);

    const recent = await audit({ since });
    expect(recent.events.map((e) => e.action).sort()).toEqual(["grant.create", "object.put", "object.put"]);

    const all = await audit();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await audit({ limit: 2, ...(cursor ? { cursor } : {}) });
      expect(page.events.length).toBeLessThanOrEqual(2);
      seen.push(...page.events.map((e) => e.id));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    expect(seen).toEqual(all.events.map((e) => e.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("rejects an invalid cursor", async () => {
    await expectError(audit({ cursor: "not-a-cursor" }), "invalid_argument");
  });

  it("restricts access to unscoped org admins", async () => {
    await create(C1);
    const writer = await h.addUser("wanda@acme.com", "writer");
    const carol = await h.addUser("carol@acme.com", "reader", { collectionSlug: "c1" });
    const scoped = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/*", role: "admin" }] });

    await expectError(audit({}, writer), "forbidden");
    await expectError(audit({}, carol), "not_found");
    await expectError(audit({}, scoped), "forbidden");
    await expectError(audit({}, undefined, C1), "invalid_argument");
  });

  it("keeps token events out of the org log but records them with no org", async () => {
    await h.createToken(h.adminToken, { scopes: [{ collection: "acme/*", role: "reader" }] });

    const { events } = await audit();
    expect(events.filter((e) => e.action.startsWith("token."))).toHaveLength(0);

    const rows = await h.db.selectFrom("audit_events").selectAll().where("action", "=", "token.create").execute();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.org_id === null)).toBe(true);
  });
});

describe("hosted MCP", () => {
  async function connect(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${SERVER_URL}/mcp`), {
      fetch: h.fetch,
      requestInit: { headers: { authorization: `Bearer ${h.adminToken}` } },
    });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(transport);
    clients.push(c);
    return c;
  }

  async function seed(c: Client): Promise<void> {
    await c.callTool({ name: "create", arguments: { uri: C1 } });
    const res = await c.callTool({
      name: "put",
      arguments: { uri: A, bytes: Buffer.from("hello agent").toString("base64"), content_type: "text/plain" },
    });
    expect(res.isError).toBeFalsy();
  }

  it("records content.inline for inline reads", async () => {
    const c = await connect();
    await seed(c);
    const res = (await c.callTool({ name: "get", arguments: { uri: A, delivery: "inline" } })) as {
      structuredContent?: { delivery?: string };
    };
    expect(res.structuredContent?.delivery).toBe("inline");

    const { events } = await audit({ action: "content.inline" });
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({ size: "hello agent".length });
  });

  it("records url.issue for ref reads", async () => {
    const c = await connect();
    await seed(c);
    const res = (await c.callTool({ name: "get", arguments: { uri: A, delivery: "ref" } })) as {
      structuredContent?: { delivery?: string };
    };
    expect(res.structuredContent?.delivery).toBe("ref");

    const { events } = await audit({ action: "url.issue" });
    expect(events).toHaveLength(1);
  });
});
