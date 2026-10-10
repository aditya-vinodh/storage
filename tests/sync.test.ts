import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runOperation } from "@storage/client";
import { ops, StorageError } from "@storage/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  await runOperation(ops.create, { uri: COLLECTION }, h.runner());
});

afterEach(async () => {
  await h.cleanup();
});

const COLLECTION = "storage://acme/pr-482/";
const SHOTS = `${COLLECTION}screenshots/`;

async function tree(root: string, files: Record<string, string>): Promise<string> {
  const dir = join(h.dir, root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

async function readTree(dir: string, prefix = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(out, await readTree(dir, rel));
    } else {
      out[rel] = await readFile(join(dir, rel), "utf8");
    }
  }
  return out;
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

const listPaths = async (uri = COLLECTION) =>
  (await runOperation(ops.list, { uri, recursive: true }, h.runner())).objects.map((o) => o.path);

describe("push", () => {
  it("uploads a directory tree, then skips unchanged files", async () => {
    const dir = await tree("artifacts", { "a.png": "a", "mobile/b.png": "b", ".meta/info.json": "{}" });
    const first = await runOperation(ops.push, { dir: "artifacts", uri: SHOTS, meta: { run: "1" } }, h.runner());
    expect(first).toMatchObject({ uri: SHOTS, dry_run: false, unchanged: 0, deleted: [], skipped: [] });
    expect(first.uploaded.map((u) => [u.path, u.version, u.local_path])).toEqual([
      ["screenshots/.meta/info.json", 1, join(dir, ".meta/info.json")],
      ["screenshots/a.png", 1, join(dir, "a.png")],
      ["screenshots/mobile/b.png", 1, join(dir, "mobile/b.png")],
    ]);
    expect((await runOperation(ops.stat, { uri: `${SHOTS}a.png` }, h.runner())).meta).toEqual({ run: "1" });

    const again = await runOperation(ops.push, { dir: "artifacts", uri: SHOTS }, h.runner());
    expect(again).toMatchObject({ uploaded: [], unchanged: 3, deleted: [] });
  });

  it("uploads changes and deletes missing objects, with a dry run first", async () => {
    await tree("artifacts", { "a.png": "a", "b.png": "b", "c.png": "c" });
    await runOperation(ops.push, { dir: "artifacts", uri: SHOTS }, h.runner());
    await writeFile(join(h.dir, "artifacts/a.png"), "a2");
    await writeFile(join(h.dir, "artifacts/d.png"), "d");
    await rm(join(h.dir, "artifacts/c.png"));

    const plan = await runOperation(
      ops.push,
      { dir: "artifacts", uri: SHOTS, delete_missing: true, dry_run: true },
      h.runner(),
    );
    expect(plan.dry_run).toBe(true);
    expect(plan.uploaded.map((u) => [u.path, u.version])).toEqual([
      ["screenshots/a.png", undefined],
      ["screenshots/d.png", undefined],
    ]);
    expect(plan.deleted.map((d) => d.path)).toEqual(["screenshots/c.png"]);
    expect(await listPaths()).toEqual(["screenshots/a.png", "screenshots/b.png", "screenshots/c.png"]);

    const done = await runOperation(ops.push, { dir: "artifacts", uri: SHOTS, delete_missing: true }, h.runner());
    expect(done.uploaded.map((u) => [u.path, u.version])).toEqual([
      ["screenshots/a.png", 2],
      ["screenshots/d.png", 1],
    ]);
    expect(done.unchanged).toBe(1);
    expect(done.deleted.map((d) => d.path)).toEqual(["screenshots/c.png"]);
    expect(await listPaths()).toEqual(["screenshots/a.png", "screenshots/b.png", "screenshots/d.png"]);
  });

  it("limits uploads and deletions to the glob", async () => {
    const keep = join(await tree("x", { "keep.txt": "k" }), "keep.txt");
    await runOperation(ops.put, { file: keep, uri: `${SHOTS}keep.txt` }, h.runner());
    await runOperation(ops.put, { file: keep, uri: `${SHOTS}old.png` }, h.runner());
    await tree("artifacts", { "new.png": "n", "notes.txt": "t" });
    const result = await runOperation(
      ops.push,
      { dir: "artifacts", uri: SHOTS, glob: "**/*.png", delete_missing: true },
      h.runner(),
    );
    expect(result.uploaded.map((u) => u.path)).toEqual(["screenshots/new.png"]);
    expect(result.deleted.map((d) => d.path)).toEqual(["screenshots/old.png"]);
    expect(await listPaths()).toEqual(["screenshots/keep.txt", "screenshots/new.png"]);
  });

  it("skips symlinks instead of following them", async () => {
    await tree("outside", { "secret.txt": "secret" });
    const dir = await tree("artifacts", { "a.png": "a" });
    await symlink(join(h.dir, "outside/secret.txt"), join(dir, "link.txt"));
    await symlink(join(h.dir, "outside"), join(dir, "linked-dir"));
    const result = await runOperation(ops.push, { dir: "artifacts", uri: SHOTS }, h.runner());
    expect(result.uploaded.map((u) => u.path)).toEqual(["screenshots/a.png"]);
    expect(result.skipped).toEqual([
      { local_path: join(dir, "link.txt"), reason: "symlink" },
      { local_path: join(dir, "linked-dir"), reason: "symlink" },
    ]);
  });

  it("checks every path before uploading anything", async () => {
    await tree("artifacts", { "a.png": "a", "bad\\name.png": "b" });
    await expectError(
      runOperation(ops.push, { dir: "artifacts", uri: SHOTS }, h.runner()),
      "invalid_argument",
      /Can't push .*bad\\name\.png: Path contains a backslash/,
    );
    expect(await listPaths()).toEqual([]);
  });

  it("rejects object URIs, missing directories, and missing collections", async () => {
    await tree("artifacts", { "a.png": "a" });
    await expectError(
      runOperation(ops.push, { dir: "artifacts", uri: `${COLLECTION}screenshots` }, h.runner()),
      "invalid_argument",
      /got an object URI/,
    );
    await expectError(
      runOperation(ops.push, { dir: "nope", uri: SHOTS }, h.runner()),
      "invalid_argument",
      /not a directory/,
    );
    const missing = await expectError(
      runOperation(ops.push, { dir: "artifacts", uri: "storage://acme/missing/" }, h.runner()),
      "not_found",
    );
    expect(missing.hint).toBe("Create it with: storage create storage://acme/missing/");
  });
});

describe("pull", () => {
  beforeEach(async () => {
    await tree("artifacts", { "a.png": "a", "mobile/b.png": "b", "report.json": "{}" });
    await runOperation(ops.push, { dir: "artifacts", uri: SHOTS }, h.runner());
  });

  it("downloads a prefix relative to --to, then skips files already present", async () => {
    const first = await runOperation(ops.pull, { uri: SHOTS, to: "out" }, h.runner());
    expect(first.to).toBe(join(h.dir, "out"));
    expect(first.files.map((f) => [f.path, f.local_path, f.downloaded, f.renamed])).toEqual([
      ["screenshots/a.png", join(h.dir, "out/a.png"), true, false],
      ["screenshots/mobile/b.png", join(h.dir, "out/mobile/b.png"), true, false],
      ["screenshots/report.json", join(h.dir, "out/report.json"), true, false],
    ]);
    expect(await readTree(join(h.dir, "out"))).toEqual(await readTree(join(h.dir, "artifacts")));

    const again = await runOperation(ops.pull, { uri: SHOTS, to: "out" }, h.runner());
    expect(again.files.map((f) => f.downloaded)).toEqual([false, false, false]);
  });

  it("mirrors the full path under the cache by default, and filters by glob", async () => {
    const result = await runOperation(ops.pull, { uri: COLLECTION, glob: "**/*.png" }, h.runner());
    const cache = join(h.dir, "home", "cache", "acme", "pr-482");
    expect(result.to).toBe(cache);
    expect(result.files.map((f) => f.local_path)).toEqual([
      join(cache, "screenshots/a.png"),
      join(cache, "screenshots/mobile/b.png"),
    ]);
    const prefix = await runOperation(ops.pull, { uri: `${SHOTS}mobile/` }, h.runner());
    expect(prefix.to).toBe(join(cache, "screenshots/mobile"));
    expect(prefix.files.map((f) => [f.local_path, f.downloaded])).toEqual([
      [join(cache, "screenshots/mobile/b.png"), false],
    ]);
  });

  it("refuses a file and a directory at the same local path unless asked to rename", async () => {
    await runOperation(ops.put, { file: join(h.dir, "artifacts/a.png"), uri: `${SHOTS}mobile` }, h.runner());
    const error = await expectError(runOperation(ops.pull, { uri: SHOTS, to: "out" }, h.runner()), "conflict");
    expect(error.message).toContain("screenshots/mobile and screenshots/mobile/b.png");
    expect(error.hint).toMatch(/--rename-conflicts/);
    expect(await lstat(join(h.dir, "out", "a.png")).catch(() => null)).toBeNull();

    const renamed = await runOperation(ops.pull, { uri: SHOTS, to: "out", rename_conflicts: true }, h.runner());
    expect(renamed.files.filter((f) => f.renamed).map((f) => [f.path, f.local_path])).toEqual([
      ["screenshots/mobile", join(h.dir, "out/mobile~2")],
    ]);
    expect(await readFile(join(h.dir, "out/mobile~2"), "utf8")).toBe("a");
  });

  it("never writes through symlinks that point outside the target", async () => {
    await mkdir(join(h.dir, "elsewhere"));
    await mkdir(join(h.dir, "out"));
    await symlink(join(h.dir, "elsewhere"), join(h.dir, "out", "mobile"));
    await expectError(
      runOperation(ops.pull, { uri: SHOTS, to: "out" }, h.runner()),
      "invalid_argument",
      /resolves outside/,
    );
    expect(await readdir(join(h.dir, "elsewhere"))).toEqual([]);
    expect(await readdir(join(h.dir, "out"))).toEqual(["mobile"]);

    await rm(join(h.dir, "out", "mobile"));
    await writeFile(join(h.dir, "elsewhere", "a.png"), "a");
    await symlink(join(h.dir, "elsewhere", "a.png"), join(h.dir, "out", "a.png"));
    const result = await runOperation(ops.pull, { uri: SHOTS, to: "out" }, h.runner());
    expect(result.files[0]).toMatchObject({ path: "screenshots/a.png", downloaded: true });
    expect((await lstat(join(h.dir, "out", "a.png"))).isFile()).toBe(true);
  });

  it("points get and pull at each other for the wrong kind of URI", async () => {
    const get = await expectError(runOperation(ops.get, { uri: SHOTS }, h.runner()), "invalid_argument");
    expect(get.hint).toBe(`Download everything under it with: storage pull ${SHOTS}`);
    const pull = await expectError(runOperation(ops.pull, { uri: `${SHOTS}a.png` }, h.runner()), "invalid_argument");
    expect(pull.hint).toBe(`Download it with: storage get ${SHOTS}a.png`);
  });

  it("returns an empty result for an empty prefix", async () => {
    const result = await runOperation(ops.pull, { uri: `${COLLECTION}nothing/`, to: "out" }, h.runner());
    expect(result.files).toEqual([]);
  });
});
