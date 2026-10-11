import { recordAuditAs } from "../audit.js";
import { type BlobStore, blobKey } from "../blobs/store.js";
import type { ServerConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { pollBindings } from "../github/poll.js";
import type { GitHubPulls } from "../github/pulls.js";
import { dueAt, governingDeleteRule, isDeleteRule, keepVersionsFor, parseRules, type RuleTimes } from "../lifecycle.js";
import { collectionUri } from "../service/resolve.js";

export interface WorkerDeps {
  db: Db;
  blobs: BlobStore;
  config: Pick<ServerConfig, "deleteGraceDays" | "uploadTtlSeconds" | "githubAdapter">;
  /** Polls bound pull requests when set (docs/specs/bindings.md). */
  github?: GitHubPulls | null;
  now?: () => Date;
}

/** What one maintenance pass removed. */
export interface MaintenanceResult {
  polledBindings: number;
  expiredObjects: number;
  prunedVersions: number;
  purgedObjects: number;
  deletedBlobs: number;
  deletedUploads: number;
  deletedSignInRows: number;
}

/** The principal the worker's audit events are recorded as. */
export const WORKER_ACTOR = "system:worker";

const BATCH_SIZE = 500;
const MAX_AUDITED_PATHS = 100;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Job = (deps: WorkerDeps, now: Date) => Promise<number>;

/** Runs `batch` until it handles fewer rows than a full batch, and returns the total it removed. */
async function drain(batch: () => Promise<{ seen: number; removed: number }>): Promise<number> {
  let total = 0;
  for (;;) {
    const { seen, removed } = await batch();
    total += removed;
    if (seen < BATCH_SIZE) {
      return total;
    }
  }
}

/** Collections with lifecycle rules, with the org slug for their URI. */
async function collectionsWithRules(db: Db) {
  const rows = await db
    .selectFrom("collections as c")
    .innerJoin("orgs as g", "g.id", "c.org_id")
    .leftJoin("bindings as b", "b.collection_id", "c.id")
    .select([
      "c.id",
      "c.slug",
      "c.created_at",
      "c.lifecycle_rules",
      "g.id as org_id",
      "g.slug as org_slug",
      "b.closed_at",
      "b.merged_at",
    ])
    .where("c.lifecycle_rules", "<>", "[]")
    .orderBy("c.id")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    orgId: row.org_id,
    times: { createdAt: row.created_at, closedAt: row.closed_at, mergedAt: row.merged_at } satisfies RuleTimes,
    uri: collectionUri(row.org_slug, row.slug),
    rules: parseRules(row.lifecycle_rules),
  }));
}

/** Job 0a: live objects past a due delete rule are soft-deleted, the same state `delete` leaves them in. */
const expireObjects: Job = async ({ db }, now) => {
  let total = 0;
  for (const collection of await collectionsWithRules(db)) {
    const { rules, times } = collection;
    const deleteRules = rules.filter(isDeleteRule);
    if (!deleteRules.some((rule) => (dueAt(rule, times)?.getTime() ?? Number.POSITIVE_INFINITY) <= now.getTime())) {
      continue;
    }
    let lastPath: string | null = null;
    for (;;) {
      let page = db
        .selectFrom("objects")
        .select(["id", "path"])
        .where("collection_id", "=", collection.id)
        .where("deleted_at", "is", null)
        .orderBy("path")
        .limit(BATCH_SIZE);
      if (lastPath !== null) {
        page = page.where("path", ">", lastPath);
      }
      const objects = await page.execute();
      if (objects.length === 0) {
        break;
      }
      lastPath = objects.at(-1)?.path ?? null;
      const due = new Map<string, string>();
      for (const object of objects) {
        const governing = governingDeleteRule(rules, object.path, times);
        if (governing?.dueAt && governing.dueAt <= now) {
          due.set(object.id, governing.rule.prefix);
        }
      }
      if (due.size > 0) {
        total += await db.transaction().execute(async (trx) => {
          const ids = [...due.keys()];
          // Lock first, like purgeObjects, so a put or delete that got there first is seen below.
          await trx
            .updateTable("objects")
            .set((eb) => ({ current_version: eb.ref("current_version") }))
            .where("id", "in", ids)
            .where("deleted_at", "is", null)
            .execute();
          const live = await trx
            .selectFrom("objects")
            .select(["id", "path"])
            .where("id", "in", ids)
            .where("deleted_at", "is", null)
            .execute();
          if (live.length === 0) {
            return 0;
          }
          await trx
            .updateTable("objects")
            .set({ deleted_at: now.toISOString() })
            .where(
              "id",
              "in",
              live.map((row) => row.id),
            )
            .execute();
          const paths = live.map((row) => row.path).sort();
          const prefixes = [...new Set(live.map((row) => due.get(row.id) as string))].sort();
          await recordAuditAs(trx, WORKER_ACTOR, null, now, {
            orgId: collection.orgId,
            action: "object.expire",
            target: collection.uri,
            detail: { count: paths.length, paths: paths.slice(0, MAX_AUDITED_PATHS), rules: prefixes },
          });
          return live.length;
        });
      }
      if (objects.length < BATCH_SIZE) {
        break;
      }
    }
  }
  return total;
};

/** Job 0b: versions beyond a keep_versions rule's count are removed, oldest first. The current version always stays. */
const pruneVersions: Job = async ({ db }, now) => {
  let total = 0;
  for (const collection of await collectionsWithRules(db)) {
    const keeps = collection.rules.flatMap((rule) => (rule.keep_versions === undefined ? [] : [rule.keep_versions]));
    if (keeps.length === 0) {
      continue;
    }
    const minKeep = Math.min(...keeps);
    let lastPath: string | null = null;
    for (;;) {
      let page = db
        .selectFrom("objects as o")
        .innerJoin("versions as v", "v.object_id", "o.id")
        .select(["o.id", "o.path"])
        .where("o.collection_id", "=", collection.id)
        .groupBy(["o.id", "o.path"])
        .having((eb) => eb.fn.count("v.id"), ">", minKeep)
        .orderBy("o.path")
        .limit(BATCH_SIZE);
      if (lastPath !== null) {
        page = page.where("o.path", ">", lastPath);
      }
      const objects = await page.execute();
      if (objects.length === 0) {
        break;
      }
      lastPath = objects.at(-1)?.path ?? null;
      const keepById = new Map<string, number>();
      for (const object of objects) {
        const keep = keepVersionsFor(collection.rules, object.path);
        if (keep !== null) {
          keepById.set(object.id, keep);
        }
      }
      if (keepById.size > 0) {
        total += await db.transaction().execute(async (trx) => {
          const ids = [...keepById.keys()];
          // Lock the rows the way upload_commit does, so the max version read below can't move.
          await trx
            .updateTable("objects")
            .set((eb) => ({ current_version: eb.ref("current_version") }))
            .where("id", "in", ids)
            .execute();
          const paths: string[] = [];
          let count = 0;
          for (const object of objects) {
            const keep = keepById.get(object.id);
            if (keep === undefined) {
              continue;
            }
            const newest = await trx
              .selectFrom("versions")
              .select((eb) => eb.fn.max("version").as("newest"))
              .where("object_id", "=", object.id)
              .executeTakeFirst();
            if (!newest || newest.newest === null) {
              continue;
            }
            const stale = await trx
              .selectFrom("versions")
              .select("id")
              .where("object_id", "=", object.id)
              .where("version", "<=", newest.newest - keep)
              .execute();
            if (stale.length === 0) {
              continue;
            }
            const staleIds = stale.map((row) => row.id);
            await trx.deleteFrom("uploads").where("version_id", "in", staleIds).execute();
            await trx.deleteFrom("versions").where("id", "in", staleIds).execute();
            paths.push(object.path);
            count += stale.length;
          }
          if (count > 0) {
            paths.sort();
            await recordAuditAs(trx, WORKER_ACTOR, null, now, {
              orgId: collection.orgId,
              action: "version.prune",
              target: collection.uri,
              detail: { count, paths: paths.slice(0, MAX_AUDITED_PATHS) },
            });
          }
          return count;
        });
      }
      if (objects.length < BATCH_SIZE) {
        break;
      }
    }
  }
  return total;
};

/** Job 1: objects deleted longer ago than the grace period lose their versions and their row. */
const purgeObjects: Job = ({ db, config }, now) => {
  const cutoff = new Date(now.getTime() - config.deleteGraceDays * DAY_MS).toISOString();
  return drain(async () => {
    const candidates = await db
      .selectFrom("objects")
      .select("id")
      .where("deleted_at", "is not", null)
      .where("deleted_at", "<=", cutoff)
      .orderBy("deleted_at")
      .limit(BATCH_SIZE)
      .execute();
    if (candidates.length === 0) {
      return { seen: 0, removed: 0 };
    }
    const removed = await db.transaction().execute(async (trx) => {
      const ids = candidates.map((row) => row.id);
      // Take the row locks first, the way upload_commit and restore do, so a
      // put or restore that got there first (and cleared deleted_at) is seen below.
      await trx
        .updateTable("objects")
        .set((eb) => ({ current_version: eb.ref("current_version") }))
        .where("id", "in", ids)
        .where("deleted_at", "is not", null)
        .where("deleted_at", "<=", cutoff)
        .execute();
      const purged = await trx
        .selectFrom("objects as o")
        .innerJoin("collections as c", "c.id", "o.collection_id")
        .innerJoin("orgs as g", "g.id", "c.org_id")
        .select(["o.id", "o.path", "c.slug as collection_slug", "g.id as org_id", "g.slug as org_slug"])
        .where("o.id", "in", ids)
        .where("o.deleted_at", "is not", null)
        .where("o.deleted_at", "<=", cutoff)
        .execute();
      if (purged.length === 0) {
        return 0;
      }
      const purgedIds = purged.map((row) => row.id);
      const versions = trx.selectFrom("versions").select("id").where("object_id", "in", purgedIds);
      await trx.deleteFrom("uploads").where("version_id", "in", versions).execute();
      await trx.deleteFrom("versions").where("object_id", "in", purgedIds).execute();
      await trx.deleteFrom("objects").where("id", "in", purgedIds).execute();

      const byCollection = new Map<string, { orgId: string; target: string; paths: string[] }>();
      for (const row of purged) {
        const target = collectionUri(row.org_slug, row.collection_slug);
        const entry = byCollection.get(target) ?? { orgId: row.org_id, target, paths: [] };
        entry.paths.push(row.path);
        byCollection.set(target, entry);
      }
      for (const { orgId, target, paths } of byCollection.values()) {
        paths.sort();
        await recordAuditAs(trx, WORKER_ACTOR, null, now, {
          orgId,
          action: "object.purge",
          target,
          detail: { count: paths.length, paths: paths.slice(0, MAX_AUDITED_PATHS) },
        });
      }
      return purged.length;
    });
    return { seen: candidates.length, removed };
  });
};

/** True when no version and no recent upload in the org references the blob. */
async function unreferenced(db: Db, orgId: string, sha256: string, liveCutoff: string): Promise<boolean> {
  const version = await db
    .selectFrom("versions as v")
    .innerJoin("objects as o", "o.id", "v.object_id")
    .innerJoin("collections as c", "c.id", "o.collection_id")
    .select("v.id")
    .where("c.org_id", "=", orgId)
    .where("v.blob_sha256", "=", sha256)
    .limit(1)
    .executeTakeFirst();
  if (version) {
    return false;
  }
  const upload = await db
    .selectFrom("uploads")
    .select("id")
    .where("org_id", "=", orgId)
    .where("sha256", "=", sha256)
    .where("expires_at", ">", liveCutoff)
    .limit(1)
    .executeTakeFirst();
  return !upload;
}

/**
 * Job 2: blobs nothing references lose their bytes and their row. The bytes are deleted while this
 * transaction holds the row's lock, and the row goes in the same transaction, so a blobs row always
 * means the bytes exist (upload_commit relies on that).
 */
const deleteBlobs: Job = ({ db, blobs }, now) => {
  // An upload counts as a reference until an hour after it expires, which covers a commit that
  // started just before expiry. The row lock is what makes it safe; this only avoids wasted uploads.
  const liveCutoff = new Date(now.getTime() - HOUR_MS).toISOString();
  return drain(async () => {
    const candidates = await db
      .selectFrom("blobs as b")
      .select(["b.org_id", "b.sha256"])
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("versions as v")
              .innerJoin("objects as o", "o.id", "v.object_id")
              .innerJoin("collections as c", "c.id", "o.collection_id")
              .select("v.id")
              .whereRef("c.org_id", "=", "b.org_id")
              .whereRef("v.blob_sha256", "=", "b.sha256"),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("uploads as u")
              .select("u.id")
              .whereRef("u.org_id", "=", "b.org_id")
              .whereRef("u.sha256", "=", "b.sha256")
              .where("u.expires_at", ">", liveCutoff),
          ),
        ),
      )
      .limit(BATCH_SIZE)
      .execute();
    let removed = 0;
    for (const { org_id, sha256 } of candidates) {
      const deleted = await db.transaction().execute(async (trx) => {
        const locked = await trx
          .updateTable("blobs")
          .set((eb) => ({ size: eb.ref("size") }))
          .where("org_id", "=", org_id)
          .where("sha256", "=", sha256)
          .executeTakeFirst();
        if (Number(locked.numUpdatedRows) === 0 || !(await unreferenced(trx, org_id, sha256, liveCutoff))) {
          return false;
        }
        await blobs.delete(blobKey(org_id, sha256));
        await trx.deleteFrom("blobs").where("org_id", "=", org_id).where("sha256", "=", sha256).execute();
        return true;
      });
      removed += deleted ? 1 : 0;
    }
    return { seen: candidates.length, removed };
  });
};

/**
 * Job 3: an upload that expired without a commit may have left bytes in the store with no blobs row.
 * A placeholder row, held for the length of the transaction, stops a commit from adopting the bytes
 * while they're deleted. Returns the number of uploads cleaned up.
 */
const deleteAbandonedBytes: Job = ({ db, blobs }, now) => {
  const liveCutoff = new Date(now.getTime() - HOUR_MS).toISOString();
  return drain(async () => {
    const candidates = await db
      .selectFrom("uploads")
      .select(["id", "org_id", "sha256", "size"])
      .where("transfer_required", "=", 1)
      .where("version_id", "is", null)
      .where("expires_at", "<=", liveCutoff)
      .limit(BATCH_SIZE)
      .execute();
    let removed = 0;
    for (const upload of candidates) {
      await db.transaction().execute(async (trx) => {
        const placeholder = await trx
          .insertInto("blobs")
          .values({ org_id: upload.org_id, sha256: upload.sha256, size: upload.size, created_at: now.toISOString() })
          .onConflict((oc) => oc.columns(["org_id", "sha256"]).doNothing())
          .executeTakeFirst();
        // With a real blobs row, the bytes belong to it and job 2 decides their fate.
        if (Number(placeholder.numInsertedOrUpdatedRows ?? 0) > 0) {
          if (await unreferenced(trx, upload.org_id, upload.sha256, liveCutoff)) {
            await blobs.delete(blobKey(upload.org_id, upload.sha256));
          }
          await trx
            .deleteFrom("blobs")
            .where("org_id", "=", upload.org_id)
            .where("sha256", "=", upload.sha256)
            .execute();
        }
        // Nothing is left to transfer for this upload, so later passes skip it.
        await trx.updateTable("uploads").set({ transfer_required: 0 }).where("id", "=", upload.id).execute();
      });
      removed += 1;
    }
    return { seen: candidates.length, removed };
  });
};

/** Job 4a: uploads more than a day past their expiry. A commit retried after that gets not_found. */
const deleteExpiredUploads: Job = async ({ db }, now) => {
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
  const result = await db.deleteFrom("uploads").where("expires_at", "<", cutoff).executeTakeFirst();
  return Number(result.numDeletedRows);
};

/** Job 4b: sign-in and connect flow rows more than a day past their expiry. */
const deleteExpiredSignInRows: Job = async ({ db }, now) => {
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
  let total = 0;
  const count = (result: { numDeletedRows: bigint }) => {
    total += Number(result.numDeletedRows);
  };
  count(await db.deleteFrom("sign_in_states").where("expires_at", "<", cutoff).executeTakeFirst());
  count(
    await db
      .deleteFrom("device_authorizations")
      .where("expires_at", "<", cutoff)
      .where("id", "not in", (eb) =>
        eb
          .selectFrom("sign_in_states")
          .select("device_authorization_id")
          .where("device_authorization_id", "is not", null),
      )
      .executeTakeFirst(),
  );
  count(
    await db
      .deleteFrom("oauth_authorization_requests")
      .where("expires_at", "<", cutoff)
      .where("id", "not in", (eb) =>
        eb
          .selectFrom("sign_in_states")
          .select("authorization_request_id")
          .where("authorization_request_id", "is not", null),
      )
      .executeTakeFirst(),
  );
  count(await db.deleteFrom("connect_states").where("expires_at", "<", cutoff).executeTakeFirst());
  count(await db.deleteFrom("connect_tickets").where("expires_at", "<", cutoff).executeTakeFirst());
  return total;
};

/** Runs one pass of every maintenance job (docs/specs/purge-and-restore.md). Safe to run concurrently. */
export async function runMaintenance(deps: WorkerDeps): Promise<MaintenanceResult> {
  const now = (deps.now ?? (() => new Date()))();
  // Polling first, so this pass expires on fresh pull request state.
  const polledBindings = await pollBindings({ db: deps.db, github: deps.github ?? null, config: deps.config }, now);
  const expiredObjects = await expireObjects(deps, now);
  const prunedVersions = await pruneVersions(deps, now);
  const purgedObjects = await purgeObjects(deps, now);
  const deletedBlobs = await deleteBlobs(deps, now);
  await deleteAbandonedBytes(deps, now);
  const deletedUploads = await deleteExpiredUploads(deps, now);
  const deletedSignInRows = await deleteExpiredSignInRows(deps, now);
  return {
    polledBindings,
    expiredObjects,
    prunedVersions,
    purgedObjects,
    deletedBlobs,
    deletedUploads,
    deletedSignInRows,
  };
}

export interface RunningWorker {
  /** Stops scheduling passes and waits for the one in progress. */
  stop(): Promise<void>;
}

/** Runs a pass now and then every `intervalMs`, one at a time. A failed pass is logged, not thrown. */
export function startWorker(
  deps: WorkerDeps,
  intervalMs: number,
  log: (error: unknown) => void = console.error,
): RunningWorker {
  let running: Promise<void> = Promise.resolve();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const pass = () => {
    running = runMaintenance(deps)
      .then(() => undefined, log)
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(pass, intervalMs);
          timer.unref();
        }
      });
  };
  pass();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
