import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runOperation } from "@storage/client";
import { type AuditAction, ops, StorageError } from "@storage/core";
import { bootstrapAdmin } from "@storage/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

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
const DOCS = "storage://acme/docs/";
const PRINCIPAL = "service:acme/bugbot";

const api = (token?: string) => h.runner(token).api;
const createService = (name = "bugbot", token?: string) => api(token).call(ops.serviceCreate, { org: "acme", name });
const createServiceToken = (extra: Record<string, unknown> = {}, token?: string) =>
  api(token).call(ops.tokenCreate, { name: "bot", service: "acme/bugbot", ...extra });
const makeCollection = (slug: string) => runOperation(ops.create, { uri: `storage://acme/${slug}/` }, h.runner());
const share = (uri: string, principal: string, role: "reader" | "writer" | "admin" = "reader") =>
  runOperation(ops.share, { uri, principal, role }, h.runner());
const grantsOn = async (uri: string) => (await runOperation(ops.grants, { uri }, h.runner())).grants;
const audit = async (action: AuditAction) =>
  (await runOperation(ops.audit, { uri: ORG, action, limit: 100 }, h.runner())).events;

describe("service_create", () => {
  it("creates a service, then returns the existing one with created=false", async () => {
    const first = await createService();
    expect(first.created).toBe(true);
    expect(first.service).toMatchObject({ org: "acme", name: "bugbot", principal: PRINCIPAL });
    expect(first.service.created_by).toMatch(/^user:/);

    const second = await createService();
    expect(second.created).toBe(false);
    expect(second.service.principal).toBe(PRINCIPAL);
    expect((await audit("service.create")).length).toBe(1);
  });

  it("forbids a non-admin org member", async () => {
    const writer = await h.addUser("wanda@acme.com", "writer");
    await expectError(createService("bugbot", writer), "forbidden");
  });

  it("hides the org from a non-member", async () => {
    const beta = await bootstrapAdmin(h.db, { org: "beta", email: "admin@beta.com" });
    await expectError(createService("bugbot", beta.token), "not_found");
  });

  it("forbids a scoped token", async () => {
    const scoped = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/*", role: "admin" }] });
    await expectError(
      createService("bugbot", scoped),
      "forbidden",
      /Only an unscoped user token can manage services\./,
    );
    await expectError(api(scoped).call(ops.serviceList, { org: "acme" }), "forbidden");
    await expectError(api(scoped).call(ops.serviceDelete, { org: "acme", name: "bugbot" }), "forbidden");
  });
});

describe("service_list", () => {
  it("lists live services sorted by name, and readers can list", async () => {
    await createService("zeta");
    await createService("alpha");
    await createService("mid");
    await api().call(ops.serviceDelete, { org: "acme", name: "mid" });

    const listed = await api().call(ops.serviceList, { org: "acme" });
    expect(listed.services.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect(listed.services[0]?.principal).toBe("service:acme/alpha");

    const reader = await h.addUser("rita@acme.com", "reader");
    const asReader = await api(reader).call(ops.serviceList, { org: "acme" });
    expect(asReader.services.map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("service_delete", () => {
  it("soft-deletes, revokes its tokens, removes its grants and reports the counts", async () => {
    await createService();
    await makeCollection("docs");
    await makeCollection("other");
    await share(DOCS, "service:bugbot");
    await share("storage://acme/other/", "service:bugbot");
    const first = await createServiceToken();
    const second = await createServiceToken({ name: "bot2" });

    const deleted = await api().call(ops.serviceDelete, { org: "acme", name: "bugbot" });
    expect(deleted.service.principal).toBe(PRINCIPAL);
    expect(deleted.revoked_tokens).toBe(2);
    expect(deleted.removed_grants).toBe(2);

    for (const token of [first.token, second.token]) {
      await expectError(runOperation(ops.whoami, {}, h.runner(token)), "unauthenticated");
    }
    expect((await api().call(ops.serviceList, { org: "acme" })).services).toEqual([]);
    expect((await grantsOn(DOCS)).map((g) => g.principal)).not.toContain(PRINCIPAL);
    await expectError(api().call(ops.serviceDelete, { org: "acme", name: "bugbot" }), "not_found");

    const again = await createService();
    expect(again.created).toBe(true);
    expect((await grantsOn(DOCS)).map((g) => g.principal)).not.toContain(PRINCIPAL);
    expect((await grantsOn("storage://acme/other/")).map((g) => g.principal)).not.toContain(PRINCIPAL);
  });

  it("records service.create and service.delete in the audit log", async () => {
    await createService();
    await createServiceToken();
    await api().call(ops.serviceDelete, { org: "acme", name: "bugbot" });

    const created = await audit("service.create");
    expect(created).toHaveLength(1);
    expect(created[0]?.target).toBe(PRINCIPAL);
    const deleted = await audit("service.delete");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.target).toBe(PRINCIPAL);
    expect(deleted[0]?.detail).toMatchObject({ revoked_tokens: 1, removed_grants: 0 });
  });
});

describe("share with service principals", () => {
  it("stores service:<org>/<name> for both input forms, with no email", async () => {
    await createService();
    await makeCollection("docs");
    for (const input of ["service:bugbot", "service:acme/bugbot"]) {
      const shared = await share(DOCS, input);
      expect(shared.grant.principal).toBe(PRINCIPAL);
      expect(shared.grant.email).toBeNull();
    }
    const listed = (await grantsOn(DOCS)).filter((g) => g.principal === PRINCIPAL);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ email: null, role: "reader", level: "collection" });
  });

  it("rejects a service from another org", async () => {
    await makeCollection("docs");
    await expectError(
      share(DOCS, "service:other/bugbot"),
      "invalid_argument",
      /Services can only be granted access in their own org/,
    );
  });

  it("rejects an unknown or deleted service", async () => {
    await makeCollection("docs");
    await expectError(share(DOCS, "service:ghost"), "invalid_argument", /No service ghost in storage:\/\/acme\//);
    await createService();
    await api().call(ops.serviceDelete, { org: "acme", name: "bugbot" });
    await expectError(share(DOCS, "service:bugbot"), "invalid_argument");
  });

  it("returns not_found when unsharing an unknown service", async () => {
    await makeCollection("docs");
    await expectError(
      runOperation(ops.unshare, { uri: DOCS, principal: "service:ghost" }, h.runner()),
      "not_found",
      /has no grant on/,
    );
  });
});

describe("service tokens", () => {
  it("has the storage_svc_ prefix, the service principal and no expiry by default", async () => {
    await createService();
    const created = await createServiceToken();
    expect(created.token).toMatch(/^storage_svc_/);
    expect(created.principal).toBe(PRINCIPAL);
    expect(created.scopes).toBeNull();
    expect(created.allowed_tools).toBeNull();
    expect(created.parent_id).toBeNull();
    expect(created.expires_at).toBeNull();

    const me = await runOperation(ops.whoami, {}, h.runner(created.token));
    expect(me.principal).toBe(PRINCIPAL);
    expect(me.token.expires_at).toBeNull();
  });

  it("honours expires_in_days", async () => {
    await createService();
    const created = await createServiceToken({ expires_in_days: 365 });
    const day = 24 * 60 * 60 * 1000;
    expect(Math.abs(Date.parse(created.expires_at ?? "") - (Date.now() + 365 * day))).toBeLessThan(60_000);
  });

  it("gets exactly the service's grants when no scopes are given", async () => {
    await createService();
    await makeCollection("docs");
    await makeCollection("other");
    await share(DOCS, "service:bugbot", "reader");
    const created = await createServiceToken();
    const runner = h.runner(created.token);

    const uri = "storage://acme/docs/a.txt";
    await runOperation(ops.put, { file: await sourceFile("a", "one"), uri }, h.runner());
    expect((await runOperation(ops.list, { uri: DOCS }, runner)).objects).toHaveLength(1);
    await expectError(runOperation(ops.put, { file: await sourceFile("b", "two"), uri }, runner), "forbidden");
    await expectError(runOperation(ops.list, { uri: "storage://acme/other/" }, runner), "not_found");
  });

  it("rejects scopes in another org", async () => {
    await createService();
    await bootstrapAdmin(h.db, { org: "beta", email: "admin@beta.com" });
    await expectError(
      createServiceToken({ scopes: [{ collection: "beta/*", role: "reader" }] }),
      "invalid_argument",
      /must be in its own org/,
    );
  });

  it("can only be created by an org admin", async () => {
    await createService();
    const writer = await h.addUser("wanda@acme.com", "writer");
    await expectError(createServiceToken({}, writer), "forbidden");
  });

  it("needs a live service", async () => {
    await expectError(createServiceToken(), "not_found");
    await createService();
    await api().call(ops.serviceDelete, { org: "acme", name: "bugbot" });
    await expectError(createServiceToken(), "not_found", /No service bugbot/);
  });

  it("is listed by token_list with service, and an org admin can revoke it", async () => {
    await createService();
    const created = await createServiceToken();
    const mine = await api().call(ops.tokenList, {});
    expect(mine.tokens.map((t) => t.id)).not.toContain(created.id);

    const listed = await api().call(ops.tokenList, { service: "acme/bugbot" });
    expect(listed.tokens.map((t) => t.id)).toEqual([created.id]);
    expect(listed.tokens[0]?.principal).toBe(PRINCIPAL);
    await expectError(api().call(ops.tokenList, { service: "acme/ghost" }), "not_found");

    await api().call(ops.tokenRevoke, { id: created.id });
    await expectError(runOperation(ops.whoami, {}, h.runner(created.token)), "unauthenticated");
    expect((await api().call(ops.tokenList, { service: "acme/bugbot" })).tokens).toEqual([]);
  });

  it("records token.create with the service's org", async () => {
    await createService();
    const created = await createServiceToken();
    const events = await audit("token.create");
    const event = events.find((e) => e.detail.principal === PRINCIPAL);
    expect(event).toBeDefined();
    expect(event?.detail).toMatchObject({ name: "bot" });
    expect(created.id).toBeDefined();
  });
});

async function sourceFile(name: string, content: string): Promise<string> {
  const path = join(h.dir, name);
  await writeFile(path, content);
  return path;
}
