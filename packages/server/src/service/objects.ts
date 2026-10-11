import {
  basename,
  formatVersion,
  type ListObject,
  type ListPrefix,
  ops,
  parseUriOfKind,
  StorageError,
} from "@storage/core";
import { sql } from "kysely";
import picomatch from "picomatch";
import { recordAudit } from "../audit.js";
import { blobKey } from "../blobs/store.js";
import { newId } from "../ids.js";
import { assertNotExpired } from "../lifecycle.js";
import { handle, type ServiceContext } from "./context.js";
import {
  collectionUri,
  decodeCursor,
  encodeCursor,
  objectUri,
  type ResolvedCollection,
  resolveCollection,
  resolveObjectVersion,
  toVersion,
} from "./resolve.js";

const DELETE_BATCH_SIZE = 500;

/** Live objects whose path starts with `prefix`, joined with their current version. */
async function liveObjectsUnder(ctx: ServiceContext, resolved: ResolvedCollection, prefix: string) {
  let query = ctx.db
    .selectFrom("objects as o")
    .innerJoin("versions as v", (join) =>
      join.onRef("v.object_id", "=", "o.id").onRef("v.version", "=", "o.current_version"),
    )
    .select([
      "o.id",
      "o.path",
      "v.version",
      "v.blob_sha256",
      "v.size",
      "v.content_type",
      "v.description",
      "v.meta",
      "v.uploaded_at",
    ])
    .where("o.collection_id", "=", resolved.collection.id)
    .where("o.deleted_at", "is", null);
  if (prefix !== "") {
    // substr counts code points in both SQLite and Postgres.
    query = query.where(sql<string>`substr(${sql.ref("o.path")}, 1, ${[...prefix].length})`, "=", prefix);
  }
  const rows = await query.execute();
  return rows.filter((row) => row.path.startsWith(prefix));
}

function isListCursor(value: unknown): value is { after: string } {
  return typeof (value as { after?: unknown } | null)?.after === "string";
}

export const listHandler = handle(ops.list, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["collection", "prefix"]);
  const resolved = await resolveCollection(ctx, uri, "reader");
  const { slug } = resolved.collection;
  const org = resolved.org.slug;
  const rows = await liveObjectsUnder(ctx, resolved, uri.path);
  const matches = input.glob === undefined ? null : picomatch(input.glob, { dot: true });
  const recursive = input.recursive || matches !== null;

  const objects: ListObject[] = [];
  const prefixes = new Map<string, ListPrefix>();
  for (const row of rows) {
    const relative = row.path.slice(uri.path.length);
    const slash = relative.indexOf("/");
    if (!recursive && slash !== -1) {
      const path = uri.path + relative.slice(0, slash + 1);
      const entry = prefixes.get(path) ?? { uri: objectUri(org, slug, path), path, object_count: 0, total_size: 0 };
      entry.object_count += 1;
      entry.total_size += Number(row.size);
      prefixes.set(path, entry);
      continue;
    }
    if (matches && !matches(relative)) {
      continue;
    }
    objects.push({
      uri: objectUri(org, slug, row.path),
      path: row.path,
      version: row.version,
      sha256: row.blob_sha256,
      size: Number(row.size),
      content_type: row.content_type,
      description: row.description,
      meta: JSON.parse(row.meta) as Record<string, string>,
      updated_at: row.uploaded_at,
    });
  }

  type Entry = { path: string; prefix?: ListPrefix; object?: ListObject };
  const entries: Entry[] = [
    ...[...prefixes.values()].map((prefix) => ({ path: prefix.path, prefix })),
    ...objects.map((object) => ({ path: object.path, object })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const after = input.cursor === undefined ? null : decodeCursor(input.cursor, isListCursor).after;
  const remaining = after === null ? entries : entries.filter((entry) => entry.path > after);
  const page = remaining.slice(0, input.limit);
  const last = page.at(-1);
  return {
    uri: objectUri(org, slug, uri.path),
    prefixes: page.flatMap((entry) => (entry.prefix ? [entry.prefix] : [])),
    objects: page.flatMap((entry) => (entry.object ? [entry.object] : [])),
    next_cursor: remaining.length > input.limit && last ? encodeCursor({ after: last.path }) : null,
  };
});

export const statHandler = handle(ops.stat, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["object"]);
  const resolved = await resolveCollection(ctx, uri, "reader");
  const { object, version } = await resolveObjectVersion(ctx, resolved, uri);
  return {
    ...toVersion(version, objectUri(resolved.org.slug, resolved.collection.slug, object.path), object.path),
    current_version: object.current_version as number,
  };
});

export const historyHandler = handle(ops.history, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["object"]);
  if (uri.version !== null) {
    throw new StorageError("invalid_argument", "history takes an object URI without a version.");
  }
  const resolved = await resolveCollection(ctx, uri, "reader");
  const { object } = await resolveObjectVersion(ctx, resolved, uri);
  const display = objectUri(resolved.org.slug, resolved.collection.slug, object.path);
  const versions = await ctx.db
    .selectFrom("versions")
    .selectAll()
    .where("object_id", "=", object.id)
    .orderBy("version", "desc")
    .execute();
  return {
    uri: display,
    current_version: object.current_version as number,
    versions: versions.map((row) => toVersion(row, display, object.path)),
  };
});

export const deleteHandler = handle(ops.del, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["object", "prefix", "collection"]);
  if (uri.version !== null) {
    throw new StorageError("invalid_argument", "Individual versions can't be deleted; delete the object instead.");
  }
  const resolved = await resolveCollection(ctx, uri, "writer");
  const { slug } = resolved.collection;
  const org = resolved.org.slug;

  let targets: { id: string; path: string }[];
  if (uri.kind === "object") {
    const { object } = await resolveObjectVersion(ctx, resolved, uri);
    targets = [{ id: object.id, path: object.path }];
  } else {
    if (!input.recursive) {
      throw new StorageError(
        "invalid_argument",
        `${objectUri(org, slug, uri.path)} is a prefix.`,
        "Pass recursive to delete every object under it.",
      );
    }
    targets = await liveObjectsUnder(ctx, resolved, uri.path);
  }

  const now = ctx.now();
  const deletedAt = now.toISOString();
  for (let i = 0; i < targets.length; i += DELETE_BATCH_SIZE) {
    const ids = targets.slice(i, i + DELETE_BATCH_SIZE).map((target) => target.id);
    await ctx.db.updateTable("objects").set({ deleted_at: deletedAt }).where("id", "in", ids).execute();
  }
  if (targets.length > 0) {
    await recordAudit(ctx.db, ctx.principal, now, {
      orgId: resolved.org.id,
      action: "object.delete",
      target: uri.kind === "collection" ? collectionUri(org, slug) : objectUri(org, slug, uri.path),
      detail: { count: targets.length },
    });
  }
  return {
    deleted: targets
      .map((target) => ({ uri: objectUri(org, slug, target.path), path: target.path }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
});

/** Deleted objects under `prefix` that are still inside the grace period, with their current version. */
async function restorableObjectsUnder(
  ctx: ServiceContext,
  resolved: ResolvedCollection,
  prefix: string,
  cutoff: string,
) {
  let query = ctx.db
    .selectFrom("objects as o")
    .select(["o.id", "o.path", "o.current_version"])
    .where("o.collection_id", "=", resolved.collection.id)
    .where("o.deleted_at", "is not", null)
    .where("o.deleted_at", ">", cutoff)
    .where("o.current_version", "is not", null);
  if (prefix !== "") {
    query = query.where(sql<string>`substr(${sql.ref("o.path")}, 1, ${[...prefix].length})`, "=", prefix);
  }
  const rows = await query.execute();
  return rows.flatMap((row) =>
    row.path.startsWith(prefix) && row.current_version !== null
      ? [{ id: row.id, path: row.path, version: row.current_version }]
      : [],
  );
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export const restoreHandler = handle(ops.restore, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["object", "prefix", "collection"]);
  const resolved = await resolveCollection(ctx, uri, "writer");
  const { slug } = resolved.collection;
  const org = resolved.org.slug;
  const now = ctx.now();
  const cutoff = new Date(now.getTime() - ctx.config.deleteGraceDays * 86_400_000).toISOString();
  const restorable = (deletedAt: string | null) => deletedAt !== null && deletedAt > cutoff;
  // A due lifecycle rule would delete the object again on the worker's next pass.
  const checkRules = (path: string) => assertNotExpired(resolved.collection, collectionUri(org, slug), path, now);

  if (uri.kind === "object") {
    if (uri.version !== null && input.recursive) {
      throw new StorageError("invalid_argument", "A version can't be restored recursively.");
    }
    const display = objectUri(org, slug, uri.path);
    checkRules(uri.path);
    const restored = await ctx.db.transaction().execute(async (trx) => {
      // Take the row lock like upload_commit, then re-read: a put, delete or
      // purge that held it first is visible now.
      await trx
        .updateTable("objects")
        .set((eb) => ({ current_version: eb.ref("current_version") }))
        .where("collection_id", "=", resolved.collection.id)
        .where("path", "=", uri.path)
        .execute();
      const object = await trx
        .selectFrom("objects")
        .selectAll()
        .where("collection_id", "=", resolved.collection.id)
        .where("path", "=", uri.path)
        .executeTakeFirst();
      if (!object || object.current_version === null) {
        throw new StorageError("not_found", `Object ${display} not found.`);
      }
      const live = object.deleted_at === null;
      if (!live && !restorable(object.deleted_at)) {
        throw new StorageError("not_found", `Object ${display} not found.`);
      }

      if (uri.version === null) {
        if (live) {
          throw new StorageError(
            "invalid_argument",
            `${display} isn't deleted.`,
            `Pass a version, for example ${display}@${Math.max(1, object.current_version - 1)}, to make an older version current.`,
          );
        }
        await trx.updateTable("objects").set({ deleted_at: null }).where("id", "=", object.id).execute();
        await recordAudit(trx, ctx.principal, now, {
          orgId: resolved.org.id,
          action: "object.restore",
          target: display,
          detail: { count: 1 },
        });
        return { version: object.current_version };
      }

      let query = trx.selectFrom("versions").selectAll().where("object_id", "=", object.id);
      query =
        uri.version.kind === "number"
          ? query.where("version", "=", uri.version.version)
          : query.where("blob_sha256", "=", uri.version.sha256).orderBy("version", "desc").limit(1);
      const source = await query.executeTakeFirst();
      if (!source) {
        throw new StorageError("not_found", `${display} has no version ${formatVersion(uri.version)}.`);
      }
      if (live && source.version === object.current_version) {
        return { version: object.current_version };
      }
      const { max } = await trx
        .selectFrom("versions")
        .select((eb) => eb.fn.max("version").as("max"))
        .where("object_id", "=", object.id)
        .executeTakeFirstOrThrow();
      const version = (max ?? 0) + 1;
      await trx
        .insertInto("versions")
        .values({
          id: newId("ver"),
          object_id: object.id,
          version,
          blob_sha256: source.blob_sha256,
          size: source.size,
          content_type: source.content_type,
          description: source.description,
          meta: source.meta,
          uploaded_by: ctx.principal.id,
          uploaded_at: now.toISOString(),
          idempotency_key: null,
        })
        .execute();
      await trx
        .updateTable("objects")
        .set({ current_version: version, deleted_at: null })
        .where("id", "=", object.id)
        .execute();
      await recordAudit(trx, ctx.principal, now, {
        orgId: resolved.org.id,
        action: "object.restore",
        target: display,
        detail: { count: 1, version, from_version: source.version },
      });
      return { version };
    });
    return { restored: [{ uri: display, path: uri.path, version: restored.version }] };
  }

  if (uri.version !== null) {
    throw new StorageError("invalid_argument", "A version can't be restored recursively.");
  }
  if (!input.recursive) {
    throw new StorageError(
      "invalid_argument",
      `${objectUri(org, slug, uri.path)} is a prefix.`,
      "Pass recursive to restore every deleted object under it.",
    );
  }
  const candidates = await restorableObjectsUnder(ctx, resolved, uri.path, cutoff);
  for (const candidate of candidates) {
    checkRules(candidate.path);
  }
  const restored: { id: string; path: string; version: number }[] = [];
  for (let i = 0; i < candidates.length; i += DELETE_BATCH_SIZE) {
    const ids = candidates.slice(i, i + DELETE_BATCH_SIZE).map((candidate) => candidate.id);
    const done = await ctx.db.transaction().execute(async (trx) => {
      // Lock the rows that are still restorable, then re-select them.
      await trx
        .updateTable("objects")
        .set((eb) => ({ current_version: eb.ref("current_version") }))
        .where("id", "in", ids)
        .where("deleted_at", "is not", null)
        .where("deleted_at", ">", cutoff)
        .execute();
      const still = await trx
        .selectFrom("objects")
        .select("id")
        .where("id", "in", ids)
        .where("deleted_at", "is not", null)
        .where("deleted_at", ">", cutoff)
        .execute();
      const stillIds = still.map((row) => row.id);
      if (stillIds.length > 0) {
        await trx.updateTable("objects").set({ deleted_at: null }).where("id", "in", stillIds).execute();
      }
      return new Set(stillIds);
    });
    restored.push(...candidates.slice(i, i + DELETE_BATCH_SIZE).filter((candidate) => done.has(candidate.id)));
  }
  if (restored.length > 0) {
    await recordAudit(ctx.db, ctx.principal, now, {
      orgId: resolved.org.id,
      action: "object.restore",
      target: uri.kind === "collection" ? collectionUri(org, slug) : objectUri(org, slug, uri.path),
      detail: { count: restored.length },
    });
  }
  return {
    restored: restored
      .map((item) => ({ uri: objectUri(org, slug, item.path), path: item.path, version: item.version }))
      .sort(byPath),
  };
});

/** Finds the object version named by `uri`, after checking that the caller can read its collection. */
export async function resolveDownload(ctx: ServiceContext, uri: string) {
  const parsed = parseUriOfKind(uri, ["object"]);
  const resolved = await resolveCollection(ctx, parsed, "reader");
  const { object, version } = await resolveObjectVersion(ctx, resolved, parsed);
  return {
    orgId: resolved.org.id,
    object,
    version,
    record: toVersion(version, objectUri(resolved.org.slug, resolved.collection.slug, object.path), object.path),
  };
}

/** Records that a signed download URL was issued for `record`'s version. */
export async function recordUrlIssued(
  ctx: ServiceContext,
  orgId: string,
  record: { uri: string; version: number },
  expiresAt: Date,
): Promise<void> {
  await recordAudit(ctx.db, ctx.principal, ctx.now(), {
    orgId,
    action: "url.issue",
    target: `${record.uri}@${record.version}`,
    detail: { version: record.version, expires_at: expiresAt.toISOString() },
  });
}

export const downloadUrlHandler = handle(ops.downloadUrl, async (input, ctx) => {
  const { orgId, object, version, record } = await resolveDownload(ctx, input.uri);
  const signed = await ctx.blobs.presignDownload(blobKey(orgId, version.blob_sha256), {
    contentType: version.content_type,
    filename: basename(object.path),
    expiresAt: new Date(ctx.now().getTime() + ctx.config.downloadTtlSeconds * 1000),
  });
  await recordUrlIssued(ctx, orgId, record, signed.expiresAt);
  return {
    ...record,
    url: signed.url,
    url_expires_at: signed.expiresAt.toISOString(),
    default_delivery: ctx.principal.token.defaultDelivery ?? "ref",
  };
});
