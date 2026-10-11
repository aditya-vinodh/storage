import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "@storage/cli";
import { runOperation } from "@storage/client";
import { ops, StorageError } from "@storage/core";
import { blobKey } from "@storage/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureStream, createHarness, type Harness, SERVER_URL } from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
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
const PAST_GRACE = 7 * DAY + 1;
const ORG = "storage://acme/";
const C1 = "storage://acme/c1/";
const A = "storage://acme/c1/a.txt";
const B = "storage://acme/c1/b.txt";

const sha = (content: string) => createHash("sha256").update(content).digest("hex");

async function put(
  uri: string,
  content: string,
  extra: { description?: string; meta?: Record<string, string>; content_type?: string } = {},
  token?: string,
) {
  const path = join(h.dir, `src-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(path, content);
  return runOperation(ops.put, { file: path, uri, content_type: "text/plain", ...extra }, h.runner(token));
}

async function read(uri: string): Promise<string> {
  const got = await runOperation(ops.get, { uri, to: `out-${Math.random().toString(36).slice(2)}` }, h.runner());
  return readFile(got.path ?? "", "utf8");
}

function del(uri: string, recursive = false) {
  return runOperation(ops.del, { uri, recursive }, h.runner());
}

function restore(uri: string, recursive?: boolean, token?: string) {
  return runOperation(ops.restore, { uri, ...(recursive === undefined ? {} : { recursive }) }, h.runner(token));
}

async function auditEvents(action: string) {
  const { events } = await runOperation(ops.audit, { uri: ORG, limit: 100 }, h.runner());
  return events.filter((e) => e.action === action);
}

async function orgId(): Promise<string> {
  const row = await h.db.selectFrom("orgs").select("id").where("slug", "=", "acme").executeTakeFirstOrThrow();
  return row.id;
}

async function bytesExist(content: string): Promise<boolean> {
  return (await h.blobs.stat(blobKey(await orgId(), sha(content)))) !== null;
}

describe("restore", () => {
  beforeEach(async () => {
    await runOperation(ops.create, { uri: C1 }, h.runner());
  });

  it("restores a deleted object with the same version and content", async () => {
    await put(A, "one");
    await del(A);
    await expectError(runOperation(ops.stat, { uri: A }, h.runner()), "not_found");

    const out = await restore(A);
    expect(out.restored).toEqual([{ uri: A, path: "a.txt", version: 1 }]);
    const stat = await runOperation(ops.stat, { uri: A }, h.runner());
    expect(stat).toMatchObject({ version: 1, current_version: 1, sha256: sha("one") });
    expect(await read(A)).toBe("one");
  });

  it("refuses to restore a live object without a version", async () => {
    await put(A, "one");
    const error = await expectError(restore(A), "invalid_argument");
    expect(error.message).toContain("isn't deleted");
    expect(error.hint).toContain(`${A}@`);
    expect((await runOperation(ops.stat, { uri: A }, h.runner())).version).toBe(1);
  });

  it("makes an older version current by adding a new version", async () => {
    await put(A, "one", { description: "first", meta: { k: "v1" }, content_type: "text/x-one" });
    await put(A, "two", { description: "second", meta: { k: "v2" }, content_type: "text/x-two" });

    const out = await restore(`${A}@1`);
    expect(out.restored).toEqual([{ uri: A, path: "a.txt", version: 3 }]);

    const stat = await runOperation(ops.stat, { uri: A }, h.runner());
    expect(stat).toMatchObject({
      version: 3,
      current_version: 3,
      sha256: sha("one"),
      size: 3,
      content_type: "text/x-one",
      description: "first",
      meta: { k: "v1" },
    });
    const history = await runOperation(ops.history, { uri: A }, h.runner());
    expect(history.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(await read(A)).toBe("one");
  });

  it("adds no version when the named version is already current", async () => {
    await put(A, "one");
    await put(A, "two");
    const out = await restore(`${A}@2`);
    expect(out.restored).toEqual([{ uri: A, path: "a.txt", version: 2 }]);
    const history = await runOperation(ops.history, { uri: A }, h.runner());
    expect(history.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(history.current_version).toBe(2);
  });

  it("treats an object deleted past the grace period as gone, without the worker", async () => {
    await put(A, "one");
    await del(A);
    h.advance(PAST_GRACE);
    await expectError(restore(A), "not_found");
  });

  it("restores a prefix only with recursive, and only restorable objects under it", async () => {
    const P = "storage://acme/c1/p/";
    await put(`${P}old.txt`, "old");
    await put(`${P}x.txt`, "x");
    await put(`${P}sub/y.txt`, "y");
    await put("storage://acme/c1/outside.txt", "outside");
    await del(`${P}old.txt`);
    h.advance(6 * DAY);
    await del(P, true);
    await del("storage://acme/c1/outside.txt");
    h.advance(2 * DAY); // old.txt is now past the grace period; the rest are not.

    const error = await expectError(restore(P), "invalid_argument");
    expect(error.message).toContain("is a prefix");
    await expectError(runOperation(ops.stat, { uri: `${P}x.txt` }, h.runner()), "not_found");

    const out = await restore(P, true);
    expect(out.restored.map((r) => r.path)).toEqual(["p/sub/y.txt", "p/x.txt"]);
    expect(out.restored.every((r) => r.version === 1)).toBe(true);
    expect((await runOperation(ops.stat, { uri: `${P}x.txt` }, h.runner())).version).toBe(1);
    expect((await runOperation(ops.stat, { uri: `${P}sub/y.txt` }, h.runner())).version).toBe(1);
    await expectError(runOperation(ops.stat, { uri: `${P}old.txt` }, h.runner()), "not_found");
    await expectError(runOperation(ops.stat, { uri: "storage://acme/c1/outside.txt" }, h.runner()), "not_found");
  });

  it("is forbidden to readers and to share links", async () => {
    await put(A, "one");
    await del(A);
    const reader = await h.addUser("rita@acme.com", "reader");
    await expectError(restore(A, undefined, reader), "forbidden");

    const { secret } = await h.runner().api.call(ops.linkCreate, { uri: C1, expires_in_days: 7 });
    await expectError(restore(A, undefined, secret), "forbidden");
    await expectError(runOperation(ops.stat, { uri: A }, h.runner()), "not_found");
  });

  it("audits object.restore with the count", async () => {
    await put(A, "one");
    await put(B, "two");
    await del(C1, true);
    await restore(C1, true);

    const events = await auditEvents("object.restore");
    expect(events).toHaveLength(1);
    expect(events[0]?.target).toBe(C1);
    expect(events[0]?.detail).toMatchObject({ count: 2 });
  });

  it("returns not_found for an unknown version of a deleted object", async () => {
    await put(A, "one");
    await del(A);
    const error = await expectError(restore(`${A}@9`), "not_found");
    expect(error.message).toContain("has no version");
    await expectError(runOperation(ops.stat, { uri: A }, h.runner()), "not_found");
  });
});

describe("maintenance worker", () => {
  beforeEach(async () => {
    await runOperation(ops.create, { uri: C1 }, h.runner());
  });

  it("purges an object past the grace period and its blob", async () => {
    await put(A, "one");
    await del(A);
    expect(await bytesExist("one")).toBe(true);
    h.advance(PAST_GRACE);
    const result = await h.runMaintenance();
    expect(result.purgedObjects).toBe(1);

    await expectError(runOperation(ops.history, { uri: A }, h.runner()), "not_found");
    await expectError(restore(A), "not_found");
    const purges = await auditEvents("object.purge");
    expect(purges).toHaveLength(1);
    expect(purges[0]?.target).toBe(C1);
    expect(purges[0]?.detail).toMatchObject({ count: 1 });
    expect(purges[0]?.detail.paths).toContain("a.txt");
    expect(await bytesExist("one")).toBe(false);
  });

  it("leaves a deleted object restorable within the grace period", async () => {
    await put(A, "one");
    await del(A);
    h.advance(6 * DAY);
    const result = await h.runMaintenance();
    expect(result.purgedObjects).toBe(0);
    expect(await bytesExist("one")).toBe(true);
    expect((await restore(A)).restored).toEqual([{ uri: A, path: "a.txt", version: 1 }]);
    expect(await read(A)).toBe("one");
  });

  it("keeps a blob that another object still references", async () => {
    await put(A, "same");
    await put(B, "same");
    await del(A);
    h.advance(PAST_GRACE);
    expect((await h.runMaintenance()).purgedObjects).toBe(1);
    await expectError(runOperation(ops.history, { uri: A }, h.runner()), "not_found");
    expect(await bytesExist("same")).toBe(true);
    expect(await read(B)).toBe("same");
  });

  it("starts at version 1 when putting to a purged path", async () => {
    await put(A, "one");
    await del(A);
    h.advance(PAST_GRACE);
    await h.runMaintenance();

    const again = await put(A, "fresh");
    expect(again.version).toBe(1);
    expect(await read(A)).toBe("fresh");
  });

  it("keeps blobs held by old versions of a live object", async () => {
    await put(A, "one");
    await put(A, "two");
    h.advance(30 * DAY);
    await h.runMaintenance();
    expect(await bytesExist("one")).toBe(true);
    expect(await read(`${A}@1`)).toBe("one");
    expect(await read(A)).toBe("two");
  });

  it("removes bytes of an abandoned upload, then its row a day after expiry", async () => {
    const content = "abandoned";
    const initiated = await h.runner().api.call(ops.uploadInitiate, {
      uri: A,
      size: content.length,
      sha256: sha(content),
      content_type: "text/plain",
    });
    expect(initiated.upload).toBeDefined();
    const transfer = await h.fetch(initiated.upload?.url ?? "", {
      method: "PUT",
      headers: initiated.upload?.headers,
      body: content,
    });
    expect(transfer.ok).toBe(true);
    expect(await bytesExist(content)).toBe(true);

    // Upload TTL is 3600 s; the bytes get another hour before they're collected.
    h.advance(3600_000 + 3600_000 + 1);
    await h.runMaintenance();
    expect(await bytesExist(content)).toBe(false);
    const row = () => h.db.selectFrom("uploads").select("id").where("id", "=", initiated.upload_id).execute();
    expect(await row()).toHaveLength(1);

    h.advance(DAY);
    await h.runMaintenance();
    expect(await row()).toHaveLength(0);
    await expectError(h.runner().api.call(ops.uploadCommit, { upload_id: initiated.upload_id }), "not_found");
  });

  it("transfers bytes again when re-uploading content whose blob was collected", async () => {
    await put(A, "recycled");
    await del(A);
    h.advance(PAST_GRACE);
    await h.runMaintenance();
    expect(await bytesExist("recycled")).toBe(false);

    const again = await put(B, "recycled");
    expect(again).toMatchObject({ version: 1, deduplicated: false });
    expect(await bytesExist("recycled")).toBe(true);
    expect(await read(B)).toBe("recycled");
  });

  it("is harmless to run twice in a row or concurrently", async () => {
    const first = ["s1", "s2", "s3"];
    for (const [i, content] of first.entries()) {
      await put(`${C1}seq-${i}.txt`, content);
      await del(`${C1}seq-${i}.txt`);
    }
    h.advance(PAST_GRACE);
    expect((await h.runMaintenance()).purgedObjects).toBe(3);
    expect((await h.runMaintenance()).purgedObjects).toBe(0);

    const second = ["c1", "c2", "c3", "c4"];
    for (const [i, content] of second.entries()) {
      await put(`${C1}par-${i}.txt`, content);
      await del(`${C1}par-${i}.txt`);
    }
    h.advance(PAST_GRACE);
    const results = await Promise.all([h.runMaintenance(), h.runMaintenance()]);
    expect(results[0].purgedObjects + results[1].purgedObjects).toBe(4);
    for (const [i, content] of second.entries()) {
      await expectError(runOperation(ops.history, { uri: `${C1}par-${i}.txt` }, h.runner()), "not_found");
      expect(await bytesExist(content)).toBe(false);
    }
  });

  it("deletes sign-in rows expired more than a day ago and keeps fresh ones", async () => {
    const old = new Date(h.now().getTime() - 2 * DAY).toISOString();
    const oldExpiry = new Date(h.now().getTime() - 2 * DAY + 600_000).toISOString();
    const fresh = h.now().toISOString();
    const freshExpiry = new Date(h.now().getTime() + 600_000).toISOString();
    for (const [name, created, expires] of [
      ["old", old, oldExpiry],
      ["fresh", fresh, freshExpiry],
    ] as const) {
      await h.db
        .insertInto("device_authorizations")
        .values({
          id: `dev_${name}`,
          device_code_hash: `hash_${name}`,
          user_code: `CODE${name}`.toUpperCase(),
          client_id: "storage-cli",
          status: "pending",
          user_id: null,
          interval_seconds: 5,
          created_at: created,
          expires_at: expires,
          last_polled_at: null,
          approved_at: null,
          token_id: null,
        })
        .execute();
      await h.db
        .insertInto("sign_in_states")
        .values({
          id: `sis_${name}`,
          state_hash: `state_${name}`,
          browser_hash: `browser_${name}`,
          provider: "google",
          code_verifier: "verifier",
          device_authorization_id: `dev_${name}`,
          authorization_request_id: null,
          created_at: created,
          expires_at: expires,
          used_at: null,
        })
        .execute();
    }

    await h.runMaintenance();

    const states = await h.db.selectFrom("sign_in_states").select("id").execute();
    expect(states.map((s) => s.id)).toEqual(["sis_fresh"]);
    const devices = await h.db.selectFrom("device_authorizations").select("id").execute();
    expect(devices.map((d) => d.id)).toEqual(["dev_fresh"]);
  });
});

describe("restore and purge edge cases", () => {
  beforeEach(async () => {
    await runOperation(ops.create, { uri: C1 }, h.runner());
  });

  it("undeletes and adds a version when restoring an older version of a deleted object", async () => {
    await put(A, "one");
    await put(A, "two");
    await del(A);

    const out = await restore(`${A}@1`);
    expect(out.restored).toEqual([{ uri: A, path: "a.txt", version: 3 }]);
    const stat = await runOperation(ops.stat, { uri: A }, h.runner());
    expect(stat).toMatchObject({ version: 3, current_version: 3, sha256: sha("one") });
    expect(await read(A)).toBe("one");
  });

  it("rejects a version together with recursive", async () => {
    await put(A, "one");
    await del(A);
    await expectError(restore(`${A}@1`, true), "invalid_argument");
    await expectError(restore(`${C1}@1`, true), "invalid_argument");
    await expectError(runOperation(ops.stat, { uri: A }, h.runner()), "not_found");
  });

  it("with a zero grace period, cannot restore and purges on the next pass", async () => {
    const zero = await createHarness({ config: { deleteGraceDays: 0 } });
    try {
      const runner = zero.runner();
      await runOperation(ops.create, { uri: C1 }, runner);
      const file = join(zero.dir, "src.txt");
      await writeFile(file, "zero");
      await runOperation(ops.put, { file, uri: A, content_type: "text/plain" }, runner);
      await runOperation(ops.del, { uri: A }, runner);
      zero.advance(1);
      await expectError(runOperation(ops.restore, { uri: A }, runner), "not_found");
      expect((await zero.runMaintenance()).purgedObjects).toBe(1);
      await expectError(runOperation(ops.history, { uri: A }, runner), "not_found");
    } finally {
      await zero.cleanup();
    }
  });

  it("deletes expired connect and OAuth rows but keeps fresh and still-referenced ones", async () => {
    const t = h.now().getTime();
    const oldAt = new Date(t - 2 * DAY).toISOString();
    const freshAt = new Date(t).toISOString();
    const freshExp = new Date(t + 600_000).toISOString();
    const user = "usr_connect";
    await h.db
      .insertInto("users")
      .values({ id: user, email: "connect@acme.com", name: null, created_at: freshAt })
      .execute();

    await h.db
      .insertInto("oauth_clients")
      .values({
        id: "client",
        client_name: null,
        redirect_uris: '["http://localhost/cb"]',
        grant_types: '["authorization_code"]',
        created_at: freshAt,
      })
      .execute();
    for (const [name, exp] of [
      ["oldref", oldAt],
      ["oldfree", oldAt],
    ] as const) {
      await h.db
        .insertInto("oauth_authorization_requests")
        .values({
          id: `oar_${name}`,
          client_id: "client",
          redirect_uri: "http://localhost/cb",
          state: null,
          code_challenge: "challenge",
          resource: null,
          status: "pending",
          user_id: null,
          code_hash: null,
          code_expires_at: null,
          approved_at: null,
          token_id: null,
          consent_hash: null,
          created_at: oldAt,
          expires_at: exp,
        })
        .execute();
    }
    // A fresh sign-in state still points at the old request, so the request must stay.
    await h.db
      .insertInto("sign_in_states")
      .values({
        id: "sis_ref",
        state_hash: "state_ref",
        browser_hash: "browser_ref",
        provider: "google",
        code_verifier: "verifier",
        device_authorization_id: null,
        authorization_request_id: "oar_oldref",
        created_at: freshAt,
        expires_at: freshExp,
        used_at: null,
      })
      .execute();

    for (const [name, at, exp] of [
      ["old", oldAt, oldAt],
      ["fresh", freshAt, freshExp],
    ] as const) {
      await h.db
        .insertInto("connect_tickets")
        .values({
          id: `tkt_${name}`,
          ticket_hash: `ticket_${name}`,
          user_id: user,
          provider: "github",
          created_at: at,
          expires_at: exp,
          used_at: null,
        })
        .execute();
      await h.db
        .insertInto("connect_states")
        .values({
          id: `cst_${name}`,
          state_hash: `cstate_${name}`,
          browser_hash: `cbrowser_${name}`,
          user_id: user,
          provider: "github",
          step: "github",
          code_verifier: "verifier",
          created_at: at,
          expires_at: exp,
          used_at: null,
        })
        .execute();
    }

    await h.runMaintenance();

    const ids = async (table: "oauth_authorization_requests" | "connect_tickets" | "connect_states") =>
      (await h.db.selectFrom(table).select("id").execute()).map((r) => r.id);
    expect(await ids("oauth_authorization_requests")).toEqual(["oar_oldref"]);
    expect(await ids("connect_tickets")).toEqual(["tkt_fresh"]);
    expect(await ids("connect_states")).toEqual(["cst_fresh"]);
    expect((await h.db.selectFrom("sign_in_states").select("id").execute()).map((r) => r.id)).toEqual(["sis_ref"]);
  });

  it("restores from the CLI and prints the restored versions", async () => {
    await put(A, "one");
    await del(A);
    const run = async (args: string[]) => {
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
    };

    const out = await run(["restore", A]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(`Restored ${A} (version 1)`);

    const none = await run(["restore", C1, "--recursive"]);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("Nothing to restore.");
  });
});
