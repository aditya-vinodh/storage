import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { formatUri, type ListObject, normalizePath, ops, parseUri, parseUriOfKind, StorageError } from "@storage/core";
import picomatch from "picomatch";
import type { z } from "zod";
import type { ApiClient } from "./api.js";
import { safeJoin, sha256File } from "./files.js";
import type { Runner } from "./runners.js";
import { downloadVerified, mapLimit, uploadFile } from "./transfer.js";

const CONCURRENCY = 4;
const LIST_PAGE_SIZE = 1000;

async function listAll(api: ApiClient, uri: string): Promise<ListObject[]> {
  const objects: ListObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.call(ops.list, { uri, recursive: true, limit: LIST_PAGE_SIZE, cursor });
    objects.push(...page.objects);
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return objects;
}

function compareBy<T>(key: (item: T) => string) {
  return (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

interface LocalFile {
  /** `/`-separated path relative to the pushed directory. */
  relative: string;
  absolute: string;
}

type Skipped = z.input<typeof ops.push.output>["skipped"];

/** Lists regular files under `root`. Symlinks are never followed. */
async function walk(root: string, skipped: Skipped): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  const visit = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        skipped.push({ local_path: absolute, reason: "symlink" });
      } else if (entry.isDirectory()) {
        await visit(absolute, rel);
      } else if (entry.isFile()) {
        files.push({ relative: rel, absolute });
      } else {
        skipped.push({ local_path: absolute, reason: "not a regular file" });
      }
    }
  };
  await visit(root, "");
  return files.sort(compareBy((file) => file.relative));
}

export const runPush: Runner<typeof ops.push> = async (input, ctx) => {
  const target = parseUriOfKind(input.uri, ["collection", "prefix"]);
  const { org } = target;
  const collection = target.collection as string;
  const objectUri = (path: string) => formatUri({ org, collection, path });
  const root = resolve(ctx.cwd, input.dir);
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    throw new StorageError("invalid_argument", `${input.dir} is not a directory.`);
  }
  const matches = input.glob === undefined ? () => true : picomatch(input.glob, { dot: true });

  const skipped: Skipped = [];
  const local = (await walk(root, skipped)).filter((file) => matches(file.relative));
  // Check every path before uploading anything, so a bad name can't leave a half-finished push.
  for (const file of local) {
    try {
      normalizePath(target.path + file.relative);
    } catch (error) {
      if (error instanceof StorageError) {
        throw new StorageError(error.code, `Can't push ${file.absolute}: ${error.message}`, error.hint);
      }
      throw error;
    }
  }

  const remote = new Map((await listAll(ctx.api, objectUri(target.path))).map((object) => [object.path, object]));
  const hashed = await mapLimit(local, CONCURRENCY, async (file) => ({
    ...file,
    path: target.path + file.relative,
    size: (await stat(file.absolute)).size,
    sha256: await sha256File(file.absolute),
  }));
  const changed = hashed.filter((file) => remote.get(file.path)?.sha256 !== file.sha256);
  const pushed = new Set(hashed.map((file) => file.path));
  const missing = input.delete_missing
    ? [...remote.values()].filter(
        (object) => !pushed.has(object.path) && matches(object.path.slice(target.path.length)),
      )
    : [];
  const result = {
    uri: objectUri(target.path),
    dry_run: input.dry_run,
    unchanged: hashed.length - changed.length,
    skipped,
  };

  if (input.dry_run) {
    return {
      ...result,
      uploaded: changed.map((file) => ({
        uri: objectUri(file.path),
        path: file.path,
        local_path: file.absolute,
        sha256: file.sha256,
        size: file.size,
      })),
      deleted: missing.map((object) => ({ uri: object.uri, path: object.path })),
    };
  }

  const doFetch = ctx.fetch ?? fetch;
  const uploaded = await mapLimit(changed, CONCURRENCY, async (file) => {
    const version = await uploadFile(ctx.api, doFetch, file.absolute, {
      uri: objectUri(file.path),
      size: file.size,
      sha256: file.sha256,
      meta: input.meta,
    });
    return {
      uri: version.uri,
      path: file.path,
      local_path: file.absolute,
      sha256: version.sha256,
      size: version.size,
      version: version.version,
      deduplicated: version.deduplicated,
    };
  });
  const deleted = await mapLimit(missing, CONCURRENCY, async (object) => {
    try {
      return (await ctx.api.call(ops.del, { uri: object.uri })).deleted;
    } catch (error) {
      // Already gone: someone else deleted it after we listed.
      if (error instanceof StorageError && error.code === "not_found") {
        return [];
      }
      throw error;
    }
  });
  return { ...result, uploaded, deleted: deleted.flat() };
};

/** Probes whether `dir` (which must exist) treats names that differ only in case as the same file. */
async function isCaseInsensitive(dir: string): Promise<boolean> {
  const probe = join(dir, `.storage-case-probe-${randomBytes(6).toString("hex")}-X`);
  await writeFile(probe, "", { flag: "wx" });
  try {
    return (await stat(probe.toLowerCase()).catch(() => null)) !== null;
  } finally {
    await rm(probe, { force: true });
  }
}

/** `a/b/name.ext` with n=2 becomes `a/b/name~2.ext`. */
function withSuffix(path: string, n: number): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? `${path.slice(0, dot)}~${n}${path.slice(dot)}` : `${path}~${n}`;
}

/** Throws unless `dir` resolves (through any symlinks) to `root` or a directory inside it. */
async function assertInside(root: string, dir: string): Promise<void> {
  const real = await realpath(dir);
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new StorageError("invalid_argument", `Refusing to write to ${dir}: it resolves outside ${root}.`);
  }
}

/** True if `path` is a regular file (not a symlink) with exactly the expected content. */
async function isPresent(path: string, expected: { size: number; sha256: string }): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return info?.isFile() === true && info.size === expected.size && (await sha256File(path)) === expected.sha256;
}

export const runPull: Runner<typeof ops.pull> = async (input, ctx) => {
  const parsed = parseUri(input.uri);
  if (parsed.kind === "object") {
    throw new StorageError(
      "invalid_argument",
      `pull takes a collection or prefix URI; ${input.uri} is an object.`,
      `Download it with: storage get ${input.uri}`,
    );
  }
  const source = parseUriOfKind(input.uri, ["collection", "prefix"]);
  const { org } = source;
  const collection = source.collection as string;
  const matches = input.glob === undefined ? () => true : picomatch(input.glob, { dot: true });

  const objects = (await listAll(ctx.api, input.uri)).filter((object) => {
    // Paths are normalized server-side; re-validate before touching the filesystem.
    const checked = normalizePath(object.path);
    if (checked.isPrefix || checked.path !== object.path || !object.path.startsWith(source.path)) {
      throw new StorageError("internal", `Server returned an invalid path "${object.path}".`);
    }
    return matches(object.path.slice(source.path.length));
  });

  const prefixSegments = source.path === "" ? [] : source.path.slice(0, -1).split("/");
  const to =
    input.to === undefined
      ? safeJoin(resolve(ctx.home, "cache"), org, collection, ...prefixSegments)
      : resolve(ctx.cwd, input.to);
  if (objects.length === 0) {
    return { uri: formatUri({ org, collection, path: source.path }), to, files: [] };
  }
  await mkdir(to, { recursive: true });
  const realTo = await realpath(to);

  // Plan every local path first, so a collision fails before anything is written.
  const insensitive = await isCaseInsensitive(to);
  const fold = insensitive ? (path: string) => path.normalize("NFC").toLowerCase() : (path: string) => path;
  const directories = new Map<string, string>();
  for (const object of objects) {
    const segments = object.path.slice(source.path.length).split("/");
    for (let i = 1; i < segments.length; i++) {
      const key = fold(segments.slice(0, i).join("/"));
      if (!directories.has(key)) {
        directories.set(key, object.path);
      }
    }
  }
  const files = new Map<string, string>();
  const plan = objects.map((object) => {
    const original = object.path.slice(source.path.length);
    let rel = original;
    for (let n = 2; files.has(fold(rel)) || directories.has(fold(rel)); n++) {
      if (!input.rename_conflicts) {
        const other = files.get(fold(rel)) ?? directories.get(fold(rel));
        throw new StorageError(
          "conflict",
          `${object.path} and ${other} would both be written to ${join(to, ...rel.split("/"))}` +
            (insensitive ? " on this case-insensitive filesystem." : "."),
          "Pass --rename-conflicts (rename_conflicts) to give later files a ~2, ~3, … suffix.",
        );
      }
      rel = withSuffix(original, n);
    }
    files.set(fold(rel), object.path);
    return { object, rel, target: safeJoin(to, ...rel.split("/")), renamed: rel !== original };
  });
  for (const dir of new Set(plan.map((entry) => dirname(entry.target)))) {
    await mkdir(dir, { recursive: true });
    await assertInside(realTo, dir);
  }

  const doFetch = ctx.fetch ?? fetch;
  const pulled = await mapLimit(plan, CONCURRENCY, async ({ object, target, renamed }) => {
    const present = await isPresent(target, object);
    if (!present) {
      const { url } = await ctx.api.call(ops.downloadUrl, { uri: `${object.uri}@${object.version}` });
      await downloadVerified(doFetch, url, target, object);
    }
    return {
      uri: object.uri,
      path: object.path,
      local_path: target,
      sha256: object.sha256,
      size: object.size,
      version: object.version,
      downloaded: !present,
      renamed,
    };
  });
  return { uri: formatUri({ org, collection, path: source.path }), to, files: pulled };
};
