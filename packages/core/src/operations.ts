import { z } from "zod";
import {
  collectionSchema,
  listObjectSchema,
  listPrefixSchema,
  metaSchema,
  roleSchema,
  sha256Schema,
  uploadTargetSchema,
  versionSchema,
} from "./schemas.js";
import { defineOperation, type OperationSpec } from "./spec.js";
import { SLUG_PATTERN } from "./uri.js";

const uri = (what: string) => z.string().min(1).describe(what);
const cursor = z.string().optional().describe("Cursor from a previous call's next_cursor.");
const ifMatch = z
  .string()
  .regex(/^(\d+|sha256:[0-9a-f]{64})$/, "Expected a version number or sha256:<hex>.")
  .optional()
  .describe("Only write if the current version matches this version number or sha256:<hex>.");
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("Retrying with the same key returns the version created by the first attempt.");

// ---------------------------------------------------------------------------
// Public operations: CLI commands and MCP tools.
// ---------------------------------------------------------------------------

export const whoami = defineOperation({
  name: "whoami",
  summary: "Show the signed-in principal and its org memberships",
  description:
    "Returns the principal behind the current credentials and the orgs it can access, with its role in each.",
  access: "read",
  visibility: "public",
  input: z.object({}),
  output: z.object({
    principal: z.string(),
    orgs: z.array(z.object({ slug: z.string(), name: z.string(), role: roleSchema })),
  }),
});

export const collections = defineOperation({
  name: "collections",
  summary: "List collections you can read",
  description: "Lists collections the caller can read, newest first. Filter by org slug.",
  access: "read",
  role: "reader",
  visibility: "public",
  input: z.object({
    org: z.string().regex(SLUG_PATTERN).optional().describe("Only list collections in this org."),
    limit: z.int().min(1).max(500).default(50).describe("Maximum number of collections to return."),
    cursor,
  }),
  output: z.object({
    collections: z.array(collectionSchema),
    next_cursor: z.string().nullable(),
  }),
});

export const create = defineOperation({
  name: "create",
  summary: "Create a collection",
  description:
    "Creates a collection. Idempotent on the slug: if the collection already exists it is returned unchanged with created=false.",
  access: "write",
  role: "writer",
  visibility: "public",
  positional: ["uri"],
  input: z.object({
    uri: uri("Collection URI, for example storage://acme/pr-482/."),
    title: z.string().max(200).optional().describe("Human-readable title."),
    description: z.string().max(4000).optional().describe("What the collection holds, written for agents."),
    tags: z.array(z.string().min(1).max(64)).max(32).optional().describe("Tags for filtering."),
  }),
  output: collectionSchema.extend({ created: z.boolean() }),
});

export const list = defineOperation({
  name: "list",
  summary: "List objects and prefixes under a collection or prefix",
  description:
    "Lists the immediate child prefixes (with object counts and sizes) and objects under a collection root or prefix. " +
    "Set recursive to list every object below it. A glob (*, **, ?, {a,b}) filters objects by path relative to the URI and implies recursive.",
  access: "read",
  role: "reader",
  visibility: "public",
  positional: ["uri"],
  input: z.object({
    uri: uri("Collection or prefix URI, for example storage://acme/pr-482/screenshots/."),
    recursive: z.boolean().default(false).describe("List all objects below the URI instead of one level."),
    glob: z.string().min(1).optional().describe("Only list objects whose relative path matches, for example **/*.png."),
    limit: z.int().min(1).max(1000).default(200).describe("Maximum number of entries to return."),
    cursor,
  }),
  output: z.object({
    uri: z.string(),
    prefixes: z.array(listPrefixSchema),
    objects: z.array(listObjectSchema),
    next_cursor: z.string().nullable(),
  }),
});

export const stat = defineOperation({
  name: "stat",
  summary: "Show an object's version record",
  description:
    "Returns the full version record of an object: size, hash, content type, metadata, uploader. Use @<version> for older versions.",
  access: "read",
  role: "reader",
  visibility: "public",
  positional: ["uri"],
  input: z.object({
    uri: uri("Object URI, optionally with @<version> or @sha256:<hex>."),
  }),
  output: versionSchema.extend({ current_version: z.int() }),
});

export const history = defineOperation({
  name: "history",
  summary: "List an object's versions",
  description: "Lists every version of an object, newest first, with uploader, time, size, and hash.",
  access: "read",
  role: "reader",
  visibility: "public",
  positional: ["uri"],
  input: z.object({
    uri: uri("Object URI."),
  }),
  output: z.object({
    uri: z.string(),
    current_version: z.int(),
    versions: z.array(versionSchema),
  }),
});

export const put = defineOperation({
  name: "put",
  summary: "Upload a file as a new version of an object",
  description:
    "Uploads a local file to an object path, creating a new version. The collection must exist. " +
    "Bytes go straight to the blob store, and identical content already in the org is not uploaded again.",
  access: "write",
  role: "writer",
  visibility: "public",
  positional: ["file", "uri"],
  input: z.object({
    file: z.string().min(1).describe("Local file to upload."),
    uri: uri("Target object URI, for example storage://acme/pr-482/screenshots/after.png."),
    content_type: z.string().min(1).optional().describe("Content type. Guessed from the file extension if omitted."),
    description: z.string().max(4000).optional().describe("What this file shows, written for agents."),
    meta: metaSchema.optional(),
    if_match: ifMatch,
    idempotency_key: idempotencyKey,
  }),
  output: versionSchema.extend({
    deduplicated: z.boolean().describe("True if the content already existed in the org and was not uploaded again."),
  }),
});

export const get = defineOperation({
  name: "get",
  summary: "Download an object",
  description:
    'Fetches an object. delivery "ref" (default) downloads it to a local path and returns the path. ' +
    'Use delivery "inline" only if you cannot run shell commands. Use pull for a prefix.',
  access: "read",
  role: "reader",
  visibility: "public",
  positional: ["uri"],
  input: z.object({
    uri: uri("Object URI, optionally with @<version> or @sha256:<hex>."),
    delivery: z.enum(["ref", "inline"]).default("ref").describe("ref returns a reference; inline returns the content."),
    to: z.string().min(1).optional().describe("Directory to download into. Defaults to the local cache."),
  }),
  output: versionSchema.extend({
    delivery: z.enum(["ref", "inline"]),
    path: z.string().optional().describe("Local path of the downloaded file."),
    url: z.string().optional().describe("Short-lived signed URL."),
    url_expires_at: z.string().optional(),
    fetch: z.object({ command: z.string(), curl: z.string() }).optional(),
  }),
});

const syncedObject = z.object({
  uri: z.string(),
  path: z.string().describe("Object path in the collection."),
  local_path: z.string(),
  sha256: sha256Schema,
  size: z.int(),
});

export const push = defineOperation({
  name: "push",
  summary: "Upload a directory to a prefix",
  description:
    "Uploads every file under a local directory to a collection or prefix, keeping relative paths. " +
    "Files whose content already matches the remote object are skipped, so re-running push after a failure resumes it. " +
    "Symlinks are skipped. delete_missing soft-deletes remote objects under the prefix that have no local file.",
  access: "write",
  role: "writer",
  visibility: "public",
  positional: ["dir", "uri"],
  input: z.object({
    dir: z.string().min(1).describe("Local directory to upload."),
    uri: uri("Target collection or prefix URI, ending in /, for example storage://acme/pr-482/screenshots/."),
    glob: z
      .string()
      .min(1)
      .optional()
      .describe("Only push files whose path relative to dir matches, for example **/*.png."),
    meta: metaSchema.optional().describe("Metadata set on every uploaded version."),
    delete_missing: z
      .boolean()
      .default(false)
      .describe("Soft-delete remote objects under the prefix (and matching glob) that aren't in dir."),
    dry_run: z
      .boolean()
      .default(false)
      .describe("Report what would be uploaded and deleted without changing anything."),
  }),
  output: z.object({
    uri: z.string(),
    dry_run: z.boolean(),
    uploaded: z.array(
      syncedObject.extend({
        version: z.int().optional().describe("Absent in a dry run."),
        deduplicated: z.boolean().optional(),
      }),
    ),
    unchanged: z.int().describe("Number of files skipped because the remote content already matches."),
    deleted: z.array(z.object({ uri: z.string(), path: z.string() })),
    skipped: z
      .array(z.object({ local_path: z.string(), reason: z.string() }))
      .describe("Local entries that were not pushed, such as symlinks."),
  }),
});

export const pull = defineOperation({
  name: "pull",
  summary: "Download every object under a prefix",
  description:
    "Downloads every object under a collection or prefix and returns their local paths. Paths below the URI are kept " +
    "relative to `to`, or the full path is mirrored under the local cache if `to` is omitted. Files already present " +
    "with the right content aren't downloaded again. Paths that would collide on a case-insensitive filesystem are " +
    "refused unless rename_conflicts is set.",
  access: "read",
  role: "reader",
  visibility: "public",
  positional: ["uri"],
  input: z.object({
    uri: uri("Collection or prefix URI, ending in /."),
    to: z.string().min(1).optional().describe("Directory to download into. Defaults to the local cache."),
    glob: z.string().min(1).optional().describe("Only pull objects whose path relative to the URI matches."),
    rename_conflicts: z
      .boolean()
      .default(false)
      .describe("Rename files whose local paths would collide (for example a.png and A.png) instead of failing."),
  }),
  output: z.object({
    uri: z.string(),
    to: z.string().describe("Local directory the files were written under."),
    files: z.array(
      syncedObject.extend({
        version: z.int(),
        downloaded: z.boolean().describe("False if the file was already present with the right content."),
        renamed: z.boolean().describe("True if local_path was renamed to avoid a collision."),
      }),
    ),
  }),
});

export const del = defineOperation({
  name: "delete",
  summary: "Delete an object or prefix",
  description: "Soft-deletes an object, or every object under a prefix when recursive is set.",
  access: "write",
  role: "writer",
  destructive: true,
  visibility: "public",
  positional: ["uri"],
  input: z.object({
    uri: uri("Object or prefix URI."),
    recursive: z.boolean().default(false).describe("Required to delete a prefix."),
  }),
  output: z.object({
    deleted: z.array(z.object({ uri: z.string(), path: z.string() })),
  }),
});

// ---------------------------------------------------------------------------
// Internal operations: client <-> server wire protocol.
// ---------------------------------------------------------------------------

export const uploadInitiate = defineOperation({
  name: "upload_initiate",
  summary: "Start an upload",
  description: "Checks policy and returns where to send the bytes, or no target if the org already has the content.",
  access: "write",
  role: "writer",
  visibility: "internal",
  input: z.object({
    uri: uri("Target object URI."),
    size: z.int().min(0),
    sha256: sha256Schema,
    content_type: z.string().min(1),
    description: z.string().max(4000).optional(),
    meta: metaSchema.optional(),
    if_match: ifMatch,
    idempotency_key: idempotencyKey,
  }),
  output: z.object({
    upload_id: z.string(),
    upload: uploadTargetSchema.nullable(),
    expires_at: z.string(),
  }),
});

export const uploadCommit = defineOperation({
  name: "upload_commit",
  summary: "Finish an upload",
  description:
    "Verifies the transferred bytes and creates the version. Committing the same upload twice returns the same version.",
  access: "write",
  role: "writer",
  visibility: "internal",
  input: z.object({ upload_id: z.string().min(1) }),
  output: put.output,
});

export const downloadUrl = defineOperation({
  name: "download_url",
  summary: "Issue a signed download URL",
  description: "Authorizes a read and returns a short-lived URL for the object's bytes.",
  access: "read",
  role: "reader",
  visibility: "internal",
  input: z.object({ uri: uri("Object URI, optionally with a version selector.") }),
  output: versionSchema.extend({ url: z.string(), url_expires_at: z.string() }),
});

export const OPERATIONS = [
  whoami,
  collections,
  create,
  list,
  stat,
  history,
  put,
  get,
  push,
  pull,
  del,
  uploadInitiate,
  uploadCommit,
  downloadUrl,
] as const satisfies readonly OperationSpec[];

export const PUBLIC_OPERATIONS: readonly OperationSpec[] = OPERATIONS.filter((op) => op.visibility === "public");

const BY_NAME = new Map<string, OperationSpec>(OPERATIONS.map((op) => [op.name, op]));

export function findOperation(name: string): OperationSpec | undefined {
  return BY_NAME.get(name);
}
