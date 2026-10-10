import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runOperation } from "@storage/client";
import { ops, StorageError } from "@storage/core";
import { createUserToken } from "@storage/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_S3_ENDPOINT } from "./backends.js";
import { createHarness, type Harness, SERVER_URL } from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

async function file(name: string, content: string): Promise<string> {
  const path = join(h.dir, name);
  await writeFile(path, content);
  return path;
}

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

const COLLECTION = "storage://acme/pr-482/";
const AFTER = "storage://acme/pr-482/screenshots/after.png";

async function createCollection(token?: string) {
  return runOperation(ops.create, { uri: COLLECTION, title: "PR 482" }, h.runner(token));
}

describe("authentication", () => {
  it("rejects requests without a valid token", async () => {
    const response = await h.fetch(`${SERVER_URL}/v1/ops/whoami`, { method: "POST" });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });

    await expectError(runOperation(ops.whoami, {}, h.runner("storage_pat_nope")), "unauthenticated", /Invalid token/);
  });

  it("rejects expired tokens", async () => {
    const token = await createUserToken(h.db, { principal: "user:x", expiresAt: new Date(Date.now() + 1000) });
    h.advance(2000);
    await expectError(runOperation(ops.whoami, {}, h.runner(token)), "unauthenticated", /expired/);
  });

  it("reports the principal and org roles", async () => {
    const me = await runOperation(ops.whoami, {}, h.runner());
    expect(me.principal).toMatch(/^user:usr_/);
    expect(me.orgs).toEqual([{ slug: "acme", name: "acme", role: "admin" }]);
  });
});

describe("collections", () => {
  it("creates idempotently and lists newest first", async () => {
    expect((await createCollection()).created).toBe(true);
    const again = await createCollection();
    expect(again).toMatchObject({ created: false, uri: COLLECTION, title: "PR 482" });
    await runOperation(ops.create, { uri: "storage://acme/pr-483/", tags: ["web"] }, h.runner());

    const page1 = await runOperation(ops.collections, { limit: 1 }, h.runner());
    expect(page1.collections.map((c) => c.slug)).toEqual(["pr-483"]);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await runOperation(ops.collections, { limit: 1, cursor: page1.next_cursor ?? "" }, h.runner());
    expect(page2.collections.map((c) => c.slug)).toEqual(["pr-482"]);
    expect(page2.next_cursor).toBeNull();
  });

  it("returns not_found for orgs the caller can't see", async () => {
    await expectError(runOperation(ops.create, { uri: "storage://other/x/" }, h.runner()), "not_found");
  });
});

describe("put and get", () => {
  beforeEach(async () => {
    await createCollection();
  });

  it("uploads, stats, and downloads with verified content", async () => {
    const source = await file("after.png", "png-bytes-v1");
    const put = await runOperation(
      ops.put,
      { file: source, uri: AFTER, description: "Settings page after", meta: { route: "/settings" } },
      h.runner(),
    );
    expect(put).toMatchObject({ uri: AFTER, version: 1, size: 12, content_type: "image/png", deduplicated: false });

    const stat = await runOperation(ops.stat, { uri: AFTER }, h.runner());
    expect(stat).toMatchObject({ version: 1, current_version: 1, meta: { route: "/settings" } });

    const got = await runOperation(ops.get, { uri: AFTER }, h.runner());
    expect(got.delivery).toBe("ref");
    expect(got.url).toBeUndefined();
    expect(got.path).toBe(join(h.dir, "home", "cache", "acme", "pr-482", "screenshots", "after.png"));
    expect(await readFile(got.path ?? "", "utf8")).toBe("png-bytes-v1");

    const to = await runOperation(ops.get, { uri: AFTER, to: "out" }, h.runner());
    expect(to.path).toBe(join(h.dir, "out", "after.png"));
  });

  it("creates versions, deduplicates content, and reads old versions", async () => {
    await runOperation(ops.put, { file: await file("a", "one"), uri: AFTER }, h.runner());
    await runOperation(ops.put, { file: await file("b", "two"), uri: AFTER }, h.runner());
    const third = await runOperation(ops.put, { file: await file("c", "one"), uri: AFTER }, h.runner());
    expect(third).toMatchObject({ version: 3, deduplicated: true });

    const history = await runOperation(ops.history, { uri: AFTER }, h.runner());
    expect(history.current_version).toBe(3);
    expect(history.versions.map((v) => v.version)).toEqual([3, 2, 1]);

    const v2 = await runOperation(ops.get, { uri: `${AFTER}@2`, to: "v2" }, h.runner());
    expect(await readFile(v2.path ?? "", "utf8")).toBe("two");
    const bySha = await runOperation(ops.stat, { uri: `${AFTER}@sha256:${history.versions[1]?.sha256}` }, h.runner());
    expect(bySha.version).toBe(2);
    await expectError(runOperation(ops.stat, { uri: `${AFTER}@9` }, h.runner()), "not_found", /no version @9/);
  });

  it("honors if_match and idempotency keys", async () => {
    const first = await runOperation(ops.put, { file: await file("a", "one"), uri: AFTER }, h.runner());
    await expectError(
      runOperation(ops.put, { file: await file("b", "two"), uri: AFTER, if_match: "7" }, h.runner()),
      "precondition_failed",
    );
    const second = await runOperation(
      ops.put,
      { file: await file("b", "two"), uri: AFTER, if_match: `sha256:${first.sha256}` },
      h.runner(),
    );
    expect(second.version).toBe(2);

    const keyed = { file: await file("c", "three"), uri: AFTER, idempotency_key: "run-1" };
    const once = await runOperation(ops.put, keyed, h.runner());
    const twice = await runOperation(ops.put, keyed, h.runner());
    expect(twice.version).toBe(once.version);
    expect((await runOperation(ops.history, { uri: AFTER }, h.runner())).versions).toHaveLength(3);
  });

  it("assigns distinct versions to concurrent commits and commits each upload once", async () => {
    const contents = Array.from({ length: 8 }, (_, i) => `content-${i}`);
    const uploads = await Promise.all(
      contents.map(async (content) => {
        const initiated = await h.runner().api.call(ops.uploadInitiate, {
          uri: AFTER,
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
          content_type: "text/plain",
        });
        const transfer = await h.fetch(initiated.upload?.url ?? "", {
          method: "PUT",
          headers: initiated.upload?.headers,
          body: content,
        });
        expect(transfer.ok).toBe(true);
        return initiated.upload_id;
      }),
    );
    const commit = (upload_id: string) => h.runner().api.call(ops.uploadCommit, { upload_id });
    const committed = await Promise.all([...uploads.map(commit), ...uploads.map(commit)]);
    const versions = committed.slice(0, uploads.length).map((v) => v.version);
    expect([...versions].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(committed.slice(uploads.length).map((v) => v.version)).toEqual(versions);
    expect((await runOperation(ops.history, { uri: AFTER }, h.runner())).versions).toHaveLength(8);
  });

  it("requires the collection to exist and enforces the size limit", async () => {
    const error = await expectError(
      runOperation(ops.put, { file: await file("a", "x"), uri: "storage://acme/missing/a.txt" }, h.runner()),
      "not_found",
    );
    expect(error.hint).toBe("Create it with: storage create storage://acme/missing/");
    await expectError(
      runOperation(ops.put, { file: await file("big", "x".repeat(1024 * 1024 + 1)), uri: AFTER }, h.runner()),
      "too_large",
    );
  });

  it("verifies transferred bytes and refuses to commit before transfer", async () => {
    const initiated = await h.runner().api.call(ops.uploadInitiate, {
      uri: AFTER,
      size: 3,
      sha256: "a".repeat(64),
      content_type: "text/plain",
    });
    await expectError(
      h.runner().api.call(ops.uploadCommit, { upload_id: initiated.upload_id }),
      "precondition_failed",
      /not been transferred/,
    );
    const transfer = await h.fetch(initiated.upload?.url ?? "", {
      method: "PUT",
      headers: initiated.upload?.headers,
      body: "abc",
    });
    expect(transfer.status).toBe(400);
    if (TEST_S3_ENDPOINT === undefined) {
      expect(await transfer.json()).toMatchObject({ error: { code: "invalid_argument", message: /sha256/ } });
    }
    await expectError(
      h.runner().api.call(ops.uploadCommit, { upload_id: initiated.upload_id }),
      "precondition_failed",
      /not been transferred/,
    );
  });

  // The server signs and serves filesystem transfer links; S3 links are covered in s3.test.ts.
  it.skipIf(TEST_S3_ENDPOINT !== undefined)("rejects tampered and expired transfer links", async () => {
    await runOperation(ops.put, { file: await file("a", "one"), uri: AFTER }, h.runner());
    const { url } = await h.runner().api.call(ops.downloadUrl, { uri: AFTER });
    const ok = await h.fetch(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''after.png");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await ok.text()).toBe("one");

    const tampered = `${url.slice(0, -2)}xx`;
    expect((await h.fetch(tampered)).status).toBe(403);
    h.advance(301_000);
    expect((await h.fetch(url)).status).toBe(403);
  });
});

describe("list and delete", () => {
  beforeEach(async () => {
    await createCollection();
    for (const path of ["screenshots/a.png", "screenshots/b.png", "screenshots/mobile/c.png", "report.json"]) {
      await runOperation(ops.put, { file: await file("f", path), uri: `${COLLECTION}${path}` }, h.runner());
    }
  });

  it("lists one level with prefix summaries", async () => {
    const root = await runOperation(ops.list, { uri: COLLECTION }, h.runner());
    expect(root.prefixes).toEqual([
      expect.objectContaining({ path: "screenshots/", object_count: 3, uri: `${COLLECTION}screenshots/` }),
    ]);
    expect(root.objects.map((o) => o.path)).toEqual(["report.json"]);

    const shots = await runOperation(ops.list, { uri: `${COLLECTION}screenshots/` }, h.runner());
    expect(shots.prefixes.map((p) => p.path)).toEqual(["screenshots/mobile/"]);
    expect(shots.objects.map((o) => o.path)).toEqual(["screenshots/a.png", "screenshots/b.png"]);
  });

  it("lists recursively, by glob, and in pages", async () => {
    const all = await runOperation(ops.list, { uri: COLLECTION, recursive: true }, h.runner());
    expect(all.objects).toHaveLength(4);
    expect(all.prefixes).toEqual([]);

    const pngs = await runOperation(ops.list, { uri: COLLECTION, glob: "**/*.png" }, h.runner());
    expect(pngs.objects.map((o) => o.path)).toEqual([
      "screenshots/a.png",
      "screenshots/b.png",
      "screenshots/mobile/c.png",
    ]);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await runOperation(ops.list, { uri: COLLECTION, recursive: true, limit: 3, cursor }, h.runner());
      seen.push(...page.objects.map((o) => o.path));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(all.objects.map((o) => o.path));
  });

  it("soft-deletes objects and prefixes", async () => {
    await expectError(
      runOperation(ops.del, { uri: `${COLLECTION}screenshots/` }, h.runner()),
      "invalid_argument",
      /is a prefix/,
    );
    const removed = await runOperation(ops.del, { uri: `${COLLECTION}screenshots/`, recursive: true }, h.runner());
    expect(removed.deleted.map((d) => d.path)).toEqual([
      "screenshots/a.png",
      "screenshots/b.png",
      "screenshots/mobile/c.png",
    ]);
    await expectError(runOperation(ops.stat, { uri: `${COLLECTION}screenshots/a.png` }, h.runner()), "not_found");
    expect((await runOperation(ops.list, { uri: COLLECTION }, h.runner())).prefixes).toEqual([]);

    const back = await runOperation(
      ops.put,
      { file: await file("f", "again"), uri: `${COLLECTION}screenshots/a.png` },
      h.runner(),
    );
    expect(back.version).toBe(2);
  });
});

describe("authorization", () => {
  beforeEach(async () => {
    await createCollection();
    await runOperation(ops.create, { uri: "storage://acme/secret/" }, h.runner());
    await runOperation(ops.put, { file: await file("a", "one"), uri: AFTER }, h.runner());
  });

  it("lets readers read but not write", async () => {
    const reader = await h.addUser("reader@acme.com", "reader");
    expect((await runOperation(ops.stat, { uri: AFTER }, h.runner(reader))).version).toBe(1);
    await expectError(
      runOperation(ops.put, { file: await file("b", "two"), uri: AFTER }, h.runner(reader)),
      "forbidden",
      /reader access/,
    );
    await expectError(runOperation(ops.create, { uri: "storage://acme/new/" }, h.runner(reader)), "forbidden");
  });

  it("scopes collection-level grants to that collection", async () => {
    const guest = await h.addUser("guest@example.com", "reader", { collectionSlug: "pr-482" });
    const visible = await runOperation(ops.collections, {}, h.runner(guest));
    expect(visible.collections.map((c) => c.slug)).toEqual(["pr-482"]);
    await expectError(runOperation(ops.list, { uri: "storage://acme/secret/" }, h.runner(guest)), "not_found");
  });

  it("hides everything from principals without grants", async () => {
    const stranger = await createUserToken(h.db, { principal: "user:stranger", expiresAt: null });
    expect((await runOperation(ops.collections, {}, h.runner(stranger))).collections).toEqual([]);
    const error = await expectError(runOperation(ops.stat, { uri: AFTER }, h.runner(stranger)), "not_found");
    expect(error.hint).toBeUndefined();
  });

  it("doesn't let another principal commit someone else's upload", async () => {
    const writer = await h.addUser("writer@acme.com", "writer");
    const initiated = await h.runner().api.call(ops.uploadInitiate, {
      uri: AFTER,
      size: 3,
      sha256: "a".repeat(64),
      content_type: "text/plain",
    });
    await expectError(h.runner(writer).api.call(ops.uploadCommit, { upload_id: initiated.upload_id }), "not_found");
  });
});
