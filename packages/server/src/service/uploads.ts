import { ops, parseUriOfKind, StorageError } from "@storage/core";
import { roleOnCollection } from "../auth.js";
import { blobKey } from "../blobs/store.js";
import { newId } from "../ids.js";
import { handle } from "./context.js";
import { objectUri, requireRole, resolveCollection, toVersion, type VersionRow } from "./resolve.js";

function checkIfMatch(ifMatch: string | null, current: VersionRow | undefined, uri: string): void {
  if (ifMatch === null) {
    return;
  }
  const matches =
    current !== undefined &&
    (ifMatch.startsWith("sha256:")
      ? current.blob_sha256 === ifMatch.slice("sha256:".length)
      : current.version === Number(ifMatch));
  if (!matches) {
    throw new StorageError(
      "precondition_failed",
      `if_match ${ifMatch} does not match ${uri}: current version is ${current ? current.version : "none"}.`,
      "Fetch the current version with stat and retry.",
    );
  }
}

export const uploadInitiateHandler = handle(ops.uploadInitiate, async (input, ctx) => {
  const uri = parseUriOfKind(input.uri, ["object"]);
  if (uri.version !== null) {
    throw new StorageError(
      "invalid_argument",
      "Upload targets can't include a version; versions are assigned on commit.",
    );
  }
  const resolved = await resolveCollection(ctx, uri, "writer");
  if (input.size > ctx.config.maxFileSize) {
    throw new StorageError("too_large", `File is ${input.size} bytes; the limit is ${ctx.config.maxFileSize}.`);
  }

  if (input.if_match !== undefined) {
    const current = await ctx.db
      .selectFrom("objects as o")
      .innerJoin("versions as v", (join) =>
        join.onRef("v.object_id", "=", "o.id").onRef("v.version", "=", "o.current_version"),
      )
      .selectAll("v")
      .where("o.collection_id", "=", resolved.collection.id)
      .where("o.path", "=", uri.path)
      .where("o.deleted_at", "is", null)
      .executeTakeFirst();
    checkIfMatch(input.if_match, current, objectUri(resolved.org.slug, resolved.collection.slug, uri.path));
  }

  const key = blobKey(resolved.org.id, input.sha256);
  const known = await ctx.db
    .selectFrom("blobs")
    .select("size")
    .where("org_id", "=", resolved.org.id)
    .where("sha256", "=", input.sha256)
    .executeTakeFirst();
  const stored = known ? null : await ctx.blobs.stat(key);
  const transferRequired = !known && stored?.size !== input.size;

  const now = ctx.now();
  const expiresAt = new Date(now.getTime() + ctx.config.uploadTtlSeconds * 1000);
  const id = newId("upl");
  await ctx.db
    .insertInto("uploads")
    .values({
      id,
      org_id: resolved.org.id,
      collection_id: resolved.collection.id,
      path: uri.path,
      sha256: input.sha256,
      size: input.size,
      content_type: input.content_type,
      description: input.description ?? null,
      meta: JSON.stringify(input.meta ?? {}),
      if_match: input.if_match ?? null,
      idempotency_key: input.idempotency_key ?? null,
      transfer_required: transferRequired ? 1 : 0,
      created_by: ctx.principal.id,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      version_id: null,
    })
    .execute();

  const upload = transferRequired
    ? await ctx.blobs.presignUpload(key, {
        size: input.size,
        sha256: input.sha256,
        contentType: input.content_type,
        expiresAt,
      })
    : null;
  return {
    upload_id: id,
    upload: upload && { url: upload.url, method: upload.method, headers: upload.headers },
    expires_at: expiresAt.toISOString(),
  };
});

export const uploadCommitHandler = handle(ops.uploadCommit, async (input, ctx) => {
  const upload = await ctx.db
    .selectFrom("uploads as u")
    .innerJoin("orgs as o", "o.id", "u.org_id")
    .innerJoin("collections as c", "c.id", "u.collection_id")
    .selectAll("u")
    .select(["o.slug as org_slug", "c.slug as collection_slug", "c.state as collection_state"])
    .where("u.id", "=", input.upload_id)
    .where("u.created_by", "=", ctx.principal.id)
    .executeTakeFirst();
  if (!upload) {
    throw new StorageError("not_found", `Upload ${input.upload_id} not found.`);
  }
  const uri = objectUri(upload.org_slug, upload.collection_slug, upload.path);
  const deduplicated = upload.transfer_required === 0;

  if (upload.version_id !== null) {
    const version = await ctx.db
      .selectFrom("versions")
      .selectAll()
      .where("id", "=", upload.version_id)
      .executeTakeFirstOrThrow();
    return { ...toVersion(version, uri, upload.path), deduplicated };
  }

  const now = ctx.now();
  if (new Date(upload.expires_at) <= now) {
    throw new StorageError("precondition_failed", `Upload ${upload.id} has expired.`, "Start the upload again.");
  }
  const role = await roleOnCollection(ctx.db, ctx.principal, upload.org_id, upload.collection_id);
  if (role === null || upload.collection_state === "deleted") {
    throw new StorageError("not_found", `Collection for ${uri} not found.`);
  }
  requireRole(role, "writer", uri);

  const key = blobKey(upload.org_id, upload.sha256);
  const known = await ctx.db
    .selectFrom("blobs")
    .select("size")
    .where("org_id", "=", upload.org_id)
    .where("sha256", "=", upload.sha256)
    .executeTakeFirst();
  if (!known) {
    const stored = await ctx.blobs.stat(key);
    if (stored === null) {
      throw new StorageError(
        "precondition_failed",
        "The upload's bytes have not been transferred yet.",
        "PUT the file to the upload URL, then commit.",
      );
    }
    if (stored.size !== Number(upload.size)) {
      throw new StorageError("precondition_failed", `Stored blob has ${stored.size} bytes, expected ${upload.size}.`);
    }
  }

  const version = await ctx.db.transaction().execute(async (trx) => {
    const timestamp = now.toISOString();
    await trx
      .insertInto("blobs")
      .values({ org_id: upload.org_id, sha256: upload.sha256, size: upload.size, created_at: timestamp })
      .onConflict((oc) => oc.columns(["org_id", "sha256"]).doNothing())
      .execute();
    await trx
      .insertInto("objects")
      .values({
        id: newId("obj"),
        collection_id: upload.collection_id,
        path: upload.path,
        current_version: null,
        deleted_at: null,
      })
      .onConflict((oc) => oc.columns(["collection_id", "path"]).doNothing())
      .execute();
    // A no-op update takes the object's row lock on Postgres (SQLite already
    // serializes writers), so commits to one path assign versions one at a time.
    // Everything below reads state committed by any commit that held it first.
    await trx
      .updateTable("objects")
      .set((eb) => ({ current_version: eb.ref("current_version") }))
      .where("collection_id", "=", upload.collection_id)
      .where("path", "=", upload.path)
      .execute();
    const object = await trx
      .selectFrom("objects")
      .selectAll()
      .where("collection_id", "=", upload.collection_id)
      .where("path", "=", upload.path)
      .executeTakeFirstOrThrow();

    const { version_id: committed } = await trx
      .selectFrom("uploads")
      .select("version_id")
      .where("id", "=", upload.id)
      .executeTakeFirstOrThrow();
    if (committed !== null) {
      return trx.selectFrom("versions").selectAll().where("id", "=", committed).executeTakeFirstOrThrow();
    }

    if (upload.idempotency_key !== null) {
      const previous = await trx
        .selectFrom("versions")
        .selectAll()
        .where("object_id", "=", object.id)
        .where("idempotency_key", "=", upload.idempotency_key)
        .executeTakeFirst();
      if (previous) {
        await trx.updateTable("uploads").set({ version_id: previous.id }).where("id", "=", upload.id).execute();
        return previous;
      }
    }

    const current =
      object.deleted_at === null && object.current_version !== null
        ? await trx
            .selectFrom("versions")
            .selectAll()
            .where("object_id", "=", object.id)
            .where("version", "=", object.current_version)
            .executeTakeFirst()
        : undefined;
    checkIfMatch(upload.if_match, current, uri);

    const { max } = await trx
      .selectFrom("versions")
      .select((eb) => eb.fn.max("version").as("max"))
      .where("object_id", "=", object.id)
      .executeTakeFirstOrThrow();
    const row: VersionRow = {
      id: newId("ver"),
      object_id: object.id,
      version: (max ?? 0) + 1,
      blob_sha256: upload.sha256,
      size: upload.size,
      content_type: upload.content_type,
      description: upload.description,
      meta: upload.meta,
      uploaded_by: ctx.principal.id,
      uploaded_at: timestamp,
      idempotency_key: upload.idempotency_key,
    };
    await trx.insertInto("versions").values(row).execute();
    await trx
      .updateTable("objects")
      .set({ current_version: row.version, deleted_at: null })
      .where("id", "=", object.id)
      .execute();
    await trx.updateTable("uploads").set({ version_id: row.id }).where("id", "=", upload.id).execute();
    return row;
  });

  return { ...toVersion(version, uri, upload.path), deduplicated };
});
