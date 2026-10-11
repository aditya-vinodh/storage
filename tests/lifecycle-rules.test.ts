import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "@storage/cli";
import { runOperation } from "@storage/client";
import { type LifecycleRule, ops, StorageError } from "@storage/core";
import { blobKey } from "@storage/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureStream, createHarness, type Harness, SERVER_URL } from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  await runOperation(ops.create, { uri: C1 }, h.runner());
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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PAST_GRACE = 7 * DAY + 1;
const ORG = "storage://acme/";
const C1 = "storage://acme/c1/";
const A = "storage://acme/c1/a.txt";

const sha = (content: string) => createHash("sha256").update(content).digest("hex");

async function put(uri: string, content: string, token?: string) {
  const path = join(h.dir, `src-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(path, content);
  return runOperation(ops.put, { file: path, uri, content_type: "text/plain" }, h.runner(token));
}

function setRules(rules: LifecycleRule[], token?: string, uri = C1) {
  return runOperation(ops.setLifecycle, { uri, rules }, h.runner(token));
}

function lifecycle(token?: string, uri = C1) {
  return runOperation(ops.lifecycle, { uri }, h.runner(token));
}

function stat(uri: string) {
  return runOperation(ops.stat, { uri }, h.runner());
}

function restore(uri: string) {
  return runOperation(ops.restore, { uri }, h.runner());
}

async function history(uri: string) {
  const out = await runOperation(ops.history, { uri }, h.runner());
  return out.versions.map((v) => v.version).sort((a, b) => a - b);
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

async function createdAt(): Promise<Date> {
  const row = await h.db
    .selectFrom("collections")
    .select("created_at")
    .where("slug", "=", "c1")
    .executeTakeFirstOrThrow();
  return new Date(row.created_at);
}

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

describe("set-lifecycle and lifecycle", () => {
  it("stores rules as given, normalizing prefixes, and reports changed", async () => {
    const out = await setRules([
      { prefix: "/videos/", delete_after: "7d" },
      { prefix: "", delete_after: "90d" },
      { prefix: "", keep_versions: 5 },
    ]);
    const expected = [
      { prefix: "videos/", delete_after: "7d" },
      { prefix: "", delete_after: "90d" },
      { prefix: "", keep_versions: 5 },
    ];
    expect(out.changed).toBe(true);
    expect(out.rules).toEqual(expected);
    expect((await lifecycle()).rules).toEqual(expected);
  });

  it("reports changed false and records no second event when setting the same rules", async () => {
    const rules = [
      { prefix: "videos/", delete_after: "7d" },
      { prefix: "", keep_versions: 3 },
    ];
    expect((await setRules(rules)).changed).toBe(true);
    expect((await setRules(rules)).changed).toBe(false);
    expect(await auditEvents("lifecycle.set")).toHaveLength(1);
  });

  it("clears all rules with an empty list from the CLI", async () => {
    await setRules([{ prefix: "", delete_after: "30d" }]);
    const out = await cli(["set-lifecycle", C1, "--rules", "[]", "--json"]);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ rules: [], scheduled: [], next: null, changed: true });
    expect(await lifecycle()).toMatchObject({ rules: [], scheduled: [], next: null });
  });

  it("sets rules from the CLI with repeated --rules objects and prints the next deletion", async () => {
    await put(`${C1}videos/v.mp4`, "video");
    const set = await cli([
      "set-lifecycle",
      C1,
      "--rules",
      '{"prefix":"videos/","delete_after":"7d"}',
      "--rules",
      '{"prefix":"","keep_versions":5}',
      "--json",
    ]);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.stdout).rules).toEqual([
      { prefix: "videos/", delete_after: "7d" },
      { prefix: "", keep_versions: 5 },
    ]);
    const shown = await cli(["lifecycle", C1]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("Next: deletes");
    expect(shown.stdout).toContain("videos/");
  });

  const invalid: Array<[string, LifecycleRule[]]> = [
    ["both actions", [{ prefix: "", delete_after: "7d", keep_versions: 2 }]],
    ["neither action", [{ prefix: "" }]],
    ["an unknown key", [{ prefix: "", "delete-after": "7d" } as unknown as LifecycleRule]],
    ["a duration without a unit", [{ prefix: "", delete_after: "7" }]],
    ["a zero duration", [{ prefix: "", delete_after: "0d" }]],
    ["keep_versions 0", [{ prefix: "", keep_versions: 0 }]],
    ["a prefix without a trailing slash", [{ prefix: "videos", delete_after: "7d" }]],
    ["a prefix with ..", [{ prefix: "a/../b/", delete_after: "7d" }]],
    ["51 rules", Array.from({ length: 51 }, () => ({ prefix: "", keep_versions: 2 }))],
  ];
  for (const [name, rules] of invalid) {
    it(`rejects ${name} with invalid_argument`, async () => {
      await expectError(setRules(rules), "invalid_argument");
      expect((await lifecycle()).rules).toEqual([]);
    });
  }

  it("forbids writers from set-lifecycle, lets readers read, and shuts out share links", async () => {
    const writer = await h.addUser("wes@acme.com", "writer");
    const reader = await h.addUser("rita@acme.com", "reader");
    const { secret } = await h.runner().api.call(ops.linkCreate, { uri: C1, expires_in_days: 7 });

    await expectError(setRules([{ prefix: "", keep_versions: 2 }], writer), "forbidden");
    await expectError(setRules([{ prefix: "", keep_versions: 2 }], secret), "forbidden");
    expect((await lifecycle(reader)).rules).toEqual([]);
    await expectError(lifecycle(secret), "forbidden");
    expect((await lifecycle()).rules).toEqual([]);
  });

  it("rejects an object URI and a missing collection", async () => {
    await expectError(lifecycle(undefined, A), "invalid_argument");
    await expectError(lifecycle(undefined, "storage://acme/nope/"), "not_found");
  });

  it("schedules per rule, with next and per-rule object counts", async () => {
    await put(`${C1}videos/a.mp4`, "va");
    await put(`${C1}videos/b.mp4`, "vb");
    await put(`${C1}x.txt`, "x");
    await put(`${C1}y.txt`, "y");
    await put(`${C1}z.txt`, "z");
    await setRules([
      { prefix: "", delete_after: "30d" },
      { prefix: "videos/", delete_after: "7d" },
    ]);
    const created = (await createdAt()).getTime();

    const out = await lifecycle();
    expect(out.next).toEqual({ prefix: "videos/", at: new Date(created + 7 * DAY).toISOString(), objects: 2 });
    expect(out.scheduled).toEqual([
      { prefix: "videos/", delete_after: "7d", at: new Date(created + 7 * DAY).toISOString(), due: false, objects: 2 },
      { prefix: "", delete_after: "30d", at: new Date(created + 30 * DAY).toISOString(), due: false, objects: 3 },
    ]);
  });

  it("audits lifecycle.set with the new and previous rules", async () => {
    const first = [{ prefix: "", delete_after: "30d" }];
    const second = [{ prefix: "docs/", keep_versions: 2 }];
    await setRules(first);
    await setRules(second);

    const events = await auditEvents("lifecycle.set");
    expect(events).toHaveLength(2);
    const latest = events.find((e) => (e.detail.previous as unknown[]).length === 1);
    expect(latest?.target).toBe(C1);
    expect(latest?.detail).toMatchObject({ rules: second, previous: first });
    const initial = events.find((e) => (e.detail.previous as unknown[]).length === 0);
    expect(initial?.detail).toMatchObject({ rules: first, previous: [] });
  });
});

describe("delete rules in the worker", () => {
  it("deletes nothing before a rule is due", async () => {
    await put(A, "one");
    await setRules([{ prefix: "", delete_after: "30d" }]);
    h.advance(29 * DAY);
    const result = await h.runMaintenance();
    expect(result.expiredObjects).toBe(0);
    expect((await stat(A)).version).toBe(1);
    expect(await auditEvents("object.expire")).toHaveLength(0);
  });

  it("soft-deletes governed objects once due and leaves others alone", async () => {
    await put(`${C1}videos/a.mp4`, "va");
    await put(`${C1}videos/sub/b.mp4`, "vb");
    await put(`${C1}docs/readme.txt`, "doc");
    await setRules([{ prefix: "videos/", delete_after: "7d" }]);
    h.advance(8 * DAY);

    const result = await h.runMaintenance();
    expect(result.expiredObjects).toBe(2);
    await expectError(stat(`${C1}videos/a.mp4`), "not_found");
    await expectError(stat(`${C1}videos/sub/b.mp4`), "not_found");
    expect((await stat(`${C1}docs/readme.txt`)).version).toBe(1);

    const events = await auditEvents("object.expire");
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("system:worker");
    expect(events[0]?.target).toBe(C1);
    expect(events[0]?.detail).toMatchObject({ count: 2 });
    expect([...((events[0]?.detail.paths as string[] | undefined) ?? [])].sort()).toEqual([
      "videos/a.mp4",
      "videos/sub/b.mp4",
    ]);
  });

  it("applies the most specific prefix even when it is due later", async () => {
    await put(`${C1}keep/x`, "kx");
    await put(A, "one");
    await setRules([
      { prefix: "", delete_after: "1d" },
      { prefix: "keep/", delete_after: "3650d" },
    ]);
    h.advance(2 * DAY);
    await h.runMaintenance();
    expect((await stat(`${C1}keep/x`)).version).toBe(1);
    await expectError(stat(A), "not_found");
  });

  it("applies the earliest rule among equal prefixes", async () => {
    await put(`${C1}videos/a.mp4`, "va");
    await setRules([
      { prefix: "videos/", delete_after: "10d" },
      { prefix: "videos/", delete_after: "2d" },
    ]);
    h.advance(3 * DAY);
    await h.runMaintenance();
    await expectError(stat(`${C1}videos/a.mp4`), "not_found");
  });

  it("makes expired objects restorable only after the rules change", async () => {
    await put(A, "one");
    await setRules([{ prefix: "", delete_after: "1d" }]);
    h.advance(2 * DAY);
    await h.runMaintenance();
    await expectError(stat(A), "not_found");

    await expectError(restore(A), "precondition_failed");
    await setRules([]);
    const out = await restore(A);
    expect(out.restored).toEqual([{ uri: A, path: "a.txt", version: 1 }]);

    const again = await h.runMaintenance();
    expect(again.expiredObjects).toBe(0);
    expect((await stat(A)).version).toBe(1);
  });

  it("refuses a recursive restore that would bring back an expired object", async () => {
    await put(A, "one");
    await put(`${C1}videos/v.mp4`, "v");
    await setRules([{ prefix: "videos/", delete_after: "1d" }]);
    await runOperation(ops.del, { uri: C1, recursive: true }, h.runner());
    h.advance(2 * DAY);
    await expectError(runOperation(ops.restore, { uri: C1, recursive: true }, h.runner()), "precondition_failed");
    await expectError(stat(A), "not_found");
    const out = await runOperation(ops.restore, { uri: A }, h.runner());
    expect(out.restored).toHaveLength(1);
  });

  it("purges an expired object after the grace period", async () => {
    await put(A, "one");
    await setRules([{ prefix: "", delete_after: "1d" }]);
    h.advance(2 * DAY);
    await h.runMaintenance();
    expect(await auditEvents("object.purge")).toHaveLength(0);

    h.advance(PAST_GRACE);
    const result = await h.runMaintenance();
    expect(result.purgedObjects).toBe(1);
    const purges = await auditEvents("object.purge");
    expect(purges).toHaveLength(1);
    expect(purges[0]?.detail.paths).toContain("a.txt");
    await expectError(runOperation(ops.history, { uri: A }, h.runner()), "not_found");
  });

  it("refuses puts into a due prefix and allows puts outside it", async () => {
    await setRules([{ prefix: "videos/", delete_after: "1d" }]);
    h.advance(2 * DAY);
    const error = await expectError(put(`${C1}videos/new.mp4`, "nv"), "precondition_failed");
    expect(error.message).toContain("videos/");
    await expectError(stat(`${C1}videos/new.mp4`), "not_found");
    expect((await put(`${C1}other/ok.txt`, "ok")).version).toBe(1);
  });

  it("honours hour durations", async () => {
    await put(A, "one");
    await setRules([{ prefix: "", delete_after: "1h" }]);
    h.advance(HOUR - 60_000);
    expect((await h.runMaintenance()).expiredObjects).toBe(0);
    expect((await stat(A)).version).toBe(1);

    h.advance(2 * 60_000);
    expect((await h.runMaintenance()).expiredObjects).toBe(1);
    await expectError(stat(A), "not_found");
  });

  it("records one object.expire event when maintenance runs twice", async () => {
    await put(A, "one");
    await setRules([{ prefix: "", delete_after: "1d" }]);
    h.advance(2 * DAY);
    await h.runMaintenance();
    const second = await h.runMaintenance();
    expect(second.expiredObjects).toBe(0);
    expect(await auditEvents("object.expire")).toHaveLength(1);
  });
});

describe("keep rules in the worker", () => {
  it("prunes versions beyond keep_versions", async () => {
    for (const content of ["v1", "v2", "v3", "v4"]) {
      await put(A, content);
    }
    await setRules([{ prefix: "", keep_versions: 2 }]);
    const result = await h.runMaintenance();
    expect(result.prunedVersions).toBe(2);

    expect(await history(A)).toEqual([3, 4]);
    await expectError(restore(`${A}@1`), "not_found");
    const events = await auditEvents("version.prune");
    expect(events).toHaveLength(1);
    expect(events[0]?.target).toBe(C1);
    expect(events[0]?.detail).toMatchObject({ count: 2 });
    expect(events[0]?.detail.paths).toContain("a.txt");
  });

  it("applies the more specific keep rule", async () => {
    const D = `${C1}docs/d.txt`;
    for (const content of ["a1", "a2", "a3"]) {
      await put(A, content);
    }
    for (const content of ["d1", "d2", "d3", "d4"]) {
      await put(D, content);
    }
    await setRules([
      { prefix: "", keep_versions: 1 },
      { prefix: "docs/", keep_versions: 3 },
    ]);
    await h.runMaintenance();
    expect(await history(A)).toEqual([3]);
    expect(await history(D)).toEqual([2, 3, 4]);
  });

  it("prunes a deleted object's old versions and still restores it at its current version", async () => {
    for (const content of ["v1", "v2", "v3"]) {
      await put(A, content);
    }
    await runOperation(ops.del, { uri: A }, h.runner());
    await setRules([{ prefix: "", keep_versions: 1 }]);
    const result = await h.runMaintenance();
    expect(result.prunedVersions).toBe(2);

    const out = await restore(A);
    expect(out.restored).toEqual([{ uri: A, path: "a.txt", version: 3 }]);
    expect(await history(A)).toEqual([3]);
  });

  it("removes a pruned version's blob unless another object shares it", async () => {
    const B = `${C1}b.txt`;
    for (const content of ["unique", "shared", "newest"]) {
      await put(A, content);
    }
    await put(B, "shared");
    await setRules([{ prefix: "", keep_versions: 1 }]);
    await h.runMaintenance();

    expect(await history(A)).toEqual([3]);
    expect(await bytesExist("unique")).toBe(false);
    expect(await bytesExist("shared")).toBe(true);
    expect(await bytesExist("newest")).toBe(true);
  });
});
