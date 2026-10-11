import { z } from "zod";
import {
  auditActionSchema,
  auditEventSchema,
  bindingEventSchema,
  bindingSchema,
  collectionSchema,
  deliverySchema,
  grantSchema,
  lifecycleRuleSchema,
  linkSchema,
  listObjectSchema,
  listPrefixSchema,
  metaSchema,
  principalInputSchema,
  roleSchema,
  scopeSchema,
  serviceSchema,
  sha256Schema,
  uploadTargetSchema,
  versionSchema,
} from "./schemas.js";
import { defineOperation, type OperationSpec, offeredOn, type Surface } from "./spec.js";
import { TOOL_NAMES } from "./tools.js";
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
    token: z.object({
      id: z.string(),
      name: z.string().nullable(),
      scopes: z.array(scopeSchema).nullable().describe("Null means the token has the principal's full access."),
      default_delivery: deliverySchema.nullable(),
      expires_at: z.string().nullable(),
      allowed_tools: z.array(z.string()).nullable().describe("Null means the token can call every tool."),
      parent_id: z.string().nullable().describe("The token this one was created from, if any."),
    }),
    groups: z
      .array(
        z.object({
          principal: z.string().describe("For example google-domain:acme.com."),
          name: z.string().describe("For example acme.com."),
        }),
      )
      .describe(
        "Group principals the caller acts as besides itself, such as its Google Workspace domain. Empty for services and share links.",
      ),
    link: z
      .object({ uri: z.string().describe("The collection or prefix the link can read.") })
      .nullable()
      .describe("Set when the credentials are a share link."),
    connected: z
      .array(
        z.object({
          provider: z.literal("github"),
          id: z.string(),
          login: z.string(),
          org_access: z.boolean().describe("True when the stored GitHub token can read org and team memberships."),
        }),
      )
      .describe("Accounts connected to the user. Empty for services and share links."),
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
  shorthand: "resolve",
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
  shorthand: "resolve",
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
  shorthand: "resolve",
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

const putInput = z.object({
  file: z.string().min(1).describe("Local file to upload."),
  uri: uri("Target object URI, for example storage://acme/pr-482/screenshots/after.png."),
  content_type: z.string().min(1).optional().describe("Content type. Guessed from the file extension if omitted."),
  description: z.string().max(4000).optional().describe("What this file shows, written for agents."),
  meta: metaSchema.optional(),
  if_match: ifMatch,
  idempotency_key: idempotencyKey,
});

export const put = defineOperation({
  name: "put",
  shorthand: "create",
  summary: "Upload a file as a new version of an object",
  description:
    "Uploads a local file to an object path, creating a new version. The collection must exist. " +
    "Bytes go straight to the blob store, and identical content already in the org is not uploaded again.",
  hostedDescription:
    "Uploads base64-encoded bytes to an object path, creating a new version. The collection must exist. " +
    "Use this only if you cannot run the storage CLI: bytes are capped (10 MiB by default). " +
    "Identical content already in the org is not stored again.",
  access: "write",
  role: "writer",
  visibility: "public",
  positional: ["file", "uri"],
  input: putInput,
  hostedInput: putInput.omit({ file: true }).extend({
    bytes: z.base64().describe("The file's content, base64-encoded."),
    content_type: z.string().min(1).optional().describe("Content type. Guessed from the path's extension if omitted."),
  }),
  output: versionSchema.extend({
    deduplicated: z.boolean().describe("True if the content already existed in the org and was not uploaded again."),
  }),
});

const getInput = z.object({
  uri: uri("Object URI, optionally with @<version> or @sha256:<hex>."),
  delivery: deliverySchema
    .optional()
    .describe(
      "ref returns a reference; inline returns the content. Defaults to the token's default_delivery, else ref.",
    ),
  to: z.string().min(1).optional().describe("Directory to download into. Defaults to the local cache."),
});

export const get = defineOperation({
  name: "get",
  shorthand: "resolve",
  summary: "Download an object",
  description:
    'Fetches an object. delivery "ref" downloads it to a local path and returns the path; it is the default ' +
    "unless the token sets default_delivery. " +
    'Use delivery "inline" only if you cannot run shell commands. Use pull for a prefix. ' +
    "Inline content is capped, and binaries without a rendition fall back to ref with a note.",
  hostedDescription:
    'Fetches an object. delivery "ref" returns a short-lived signed URL, with fetch.command (storage CLI) and ' +
    "fetch.curl to download it; it is the default unless the token sets default_delivery. " +
    'Use delivery "inline" only if you cannot run shell commands. ' +
    "Inline content is capped, and binaries without a rendition fall back to ref with a note.",
  access: "read",
  role: "reader",
  visibility: "public",
  positional: ["uri"],
  input: getInput,
  hostedInput: getInput.omit({ to: true }),
  output: versionSchema.extend({
    delivery: deliverySchema,
    path: z.string().optional().describe("Local path of the downloaded file."),
    url: z.string().optional().describe("Short-lived signed URL."),
    url_expires_at: z.string().optional(),
    fetch: z.object({ command: z.string(), curl: z.string() }).optional(),
    note: z
      .string()
      .optional()
      .describe("Why the result differs from what was asked, for example inline fell back to ref."),
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
  shorthand: "create",
  summary: "Upload a directory to a prefix",
  description:
    "Uploads every file under a local directory to a collection or prefix, keeping relative paths. " +
    "Files whose content already matches the remote object are skipped, so re-running push after a failure resumes it. " +
    "Symlinks are skipped. delete_missing soft-deletes remote objects under the prefix that have no local file.",
  access: "write",
  role: "writer",
  visibility: "public",
  surfaces: ["local"],
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
  shorthand: "resolve",
  summary: "Download every object under a prefix",
  description:
    "Downloads every object under a collection or prefix and returns their local paths. Paths below the URI are kept " +
    "relative to `to`, or the full path is mirrored under the local cache if `to` is omitted. Files already present " +
    "with the right content aren't downloaded again. Paths that would collide on a case-insensitive filesystem are " +
    "refused unless rename_conflicts is set.",
  access: "read",
  role: "reader",
  visibility: "public",
  surfaces: ["local"],
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
  shorthand: "resolve",
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

export const restore = defineOperation({
  name: "restore",
  shorthand: "resolve",
  summary: "Restore a deleted object, or make an older version current",
  description:
    "Undeletes an object, or every deleted object under a prefix when recursive is set. Deleted objects stay " +
    "restorable for a grace period (7 days by default); after that they are gone for good. Add @<n> to an object " +
    "URI (for example storage://acme/docs/a.md@2) to make that older version current again: this adds a new " +
    "version with the same content, and also undeletes the object if it was deleted within the grace period.",
  access: "write",
  role: "writer",
  destructive: false,
  visibility: "public",
  positional: ["uri"],
  input: z.object({
    uri: uri("Object URI, optionally with @<version>, or a prefix URI with recursive."),
    recursive: z.boolean().default(false).describe("Required to restore a prefix."),
  }),
  output: z.object({
    restored: z.array(
      z.object({
        uri: z.string(),
        path: z.string(),
        version: z.int().describe("The object's current version after the restore."),
      }),
    ),
  }),
});

const lifecycleOutput = z.object({
  uri: z.string(),
  rules: z.array(lifecycleRuleSchema),
  scheduled: z
    .array(
      z.object({
        prefix: z.string(),
        delete_after: z.string().optional(),
        delete_after_event: z.object({ event: bindingEventSchema, after: z.string() }).optional(),
        at: z.string().describe("When the rule deletes the objects it governs."),
        due: z.boolean().describe("True once at has passed; the worker deletes what's left on its next pass."),
        objects: z.int().describe("Live objects this rule governs now."),
      }),
    )
    .describe("Delete rules that still have work to do, soonest first."),
  waiting: z
    .array(
      z.object({
        prefix: z.string(),
        event: bindingEventSchema,
        after: z.string(),
        objects: z.int().describe("Live objects this rule would govern if its event happened now."),
      }),
    )
    .describe("Event rules whose event hasn't happened yet, so they have no deletion time."),
  binding: bindingSchema.nullable().describe("The pull request the collection is bound to. Null for an org URI."),
  next: z
    .object({ prefix: z.string(), at: z.string(), objects: z.int() })
    .nullable()
    .describe("The next deletion that hasn't happened yet, or null if none is scheduled."),
});

export const lifecycle = defineOperation({
  name: "lifecycle",
  shorthand: "resolve",
  summary: "Show a collection's lifecycle rules and the next scheduled deletion",
  description:
    "Lists a collection's lifecycle rules and when each delete rule deletes the objects it governs. " +
    "delete_after counts from the collection's creation and delete_after_event from its binding's event; the most " +
    "specific prefix wins. For an org URI, shows the default rules new collections start with.",
  access: "read",
  role: "reader",
  visibility: "public",
  positional: ["uri"],
  input: z.object({ uri: uri("Collection URI, for example storage://acme/pr-482/, or an org URI.") }),
  output: lifecycleOutput,
});

export const setLifecycle = defineOperation({
  name: "set-lifecycle",
  shorthand: "resolve",
  summary: "Replace a collection's lifecycle rules",
  description:
    'Replaces a collection\'s lifecycle rules; an empty list removes them. Each rule has a prefix ("" for the ' +
    "whole collection) and one action: delete_after (for example 30d or 12h, counted from the collection's " +
    "creation) soft-deletes the objects under the prefix; delete_after_event ({event: binding.closed or " +
    "binding.merged, after: 7d}) does the same that long after the collection's bound pull request closes or " +
    "merges; keep_versions prunes all but the newest versions of each object. For an object, the matching rule " +
    "with the longest prefix wins. Deleted objects stay restorable for the grace period; pruned versions are " +
    "removed for good. For an org URI, sets the default rules copied into new collections. Needs admin access.",
  access: "write",
  role: "admin",
  destructive: true,
  visibility: "public",
  positional: ["uri"],
  input: z.object({
    uri: uri("Collection URI, or an org URI for the org's default rules."),
    rules: z.array(lifecycleRuleSchema).max(50).describe("The new rules, as JSON."),
  }),
  output: lifecycleOutput.extend({
    changed: z.boolean().describe("False if the collection already had exactly these rules."),
  }),
});

const bindOutput = z.object({
  uri: z.string().describe("Collection URI."),
  binding: bindingSchema.nullable(),
  changed: z.boolean(),
});

export const bind = defineOperation({
  name: "bind",
  summary: "Bind a collection to a GitHub pull request",
  description:
    "Links a collection to a pull request, for example github:acme/web#482, so delete_after_event lifecycle " +
    "rules can count from when it closes or merges. The state arrives with the next webhook delivery or poll. A " +
    "collection has at most one binding, and a pull request at most one collection per org.",
  access: "write",
  role: "writer",
  visibility: "public",
  positional: ["uri", "target"],
  input: z.object({
    uri: uri("Collection URI."),
    target: z.string().min(1).describe("github:<owner>/<repo>#<number>."),
  }),
  output: bindOutput,
});

export const unbind = defineOperation({
  name: "unbind",
  shorthand: "resolve",
  summary: "Remove a collection's binding",
  description:
    "Removes a collection's binding. Event-based lifecycle rules then have no event to count from until it is " +
    "bound again. Returns changed: false if the collection had no binding.",
  access: "write",
  role: "writer",
  visibility: "public",
  positional: ["uri"],
  input: z.object({ uri: uri("Collection URI.") }),
  output: bindOutput,
});

export const grants = defineOperation({
  name: "grants",
  shorthand: "resolve",
  summary: "List who has access to an org or collection",
  description:
    "Lists the grants on an org or a collection. For a collection, org-level grants that apply to it are included " +
    "with level=org. Needs reader access; for an org URI, an org-level grant and an unscoped token.",
  access: "read",
  role: "reader",
  visibility: "public",
  positional: ["uri"],
  input: z.object({
    uri: uri("Org or collection URI, for example storage://acme/ or storage://acme/pr-482/."),
  }),
  output: z.object({
    uri: z.string(),
    grants: z.array(grantSchema),
  }),
});

export const share = defineOperation({
  name: "share",
  shorthand: "resolve",
  summary: "Grant a principal a role on an org or collection",
  description:
    "Grants a role on an org or collection, or changes the role of an existing grant at that level. " +
    "Sharing with an email that hasn't signed in yet reserves the grant for that user. " +
    "Needs admin access; sharing an org needs an unscoped token.",
  access: "write",
  role: "admin",
  visibility: "public",
  positional: ["uri", "principal", "role"],
  input: z.object({
    uri: uri("Org or collection URI."),
    principal: principalInputSchema,
    role: roleSchema.describe("reader, writer or admin."),
  }),
  output: z.object({
    grant: grantSchema,
    changed: z.boolean().describe("False if the principal already had this role at this level."),
    previous_role: roleSchema.nullable().describe("The role before this call, or null for a new grant."),
  }),
});

export const unshare = defineOperation({
  name: "unshare",
  shorthand: "resolve",
  summary: "Remove a principal's grant on an org or collection",
  description:
    "Removes the principal's grant at exactly this level. An org-level grant still applies to a collection after " +
    "its collection grant is removed. The last org admin can't be removed. Needs admin access.",
  access: "write",
  role: "admin",
  destructive: true,
  visibility: "public",
  positional: ["uri", "principal"],
  input: z.object({
    uri: uri("Org or collection URI."),
    principal: principalInputSchema,
  }),
  output: z.object({
    removed: grantSchema,
  }),
});

export const audit = defineOperation({
  name: "audit",
  summary: "Read an org's audit log",
  description:
    "Lists audit events for an org, newest first: grant changes, uploads, deletes, issued download URLs and " +
    "inline reads. Needs org admin access and an unscoped token.",
  access: "read",
  role: "admin",
  visibility: "public",
  positional: ["uri"],
  input: z.object({
    uri: uri("Org URI, for example storage://acme/."),
    action: auditActionSchema.optional().describe("Only list events with this action."),
    since: z.iso.datetime().optional().describe("Only list events at or after this ISO-8601 time."),
    limit: z.int().min(1).max(500).default(100).describe("Maximum number of events to return."),
    cursor,
  }),
  output: z.object({
    events: z.array(auditEventSchema),
    next_cursor: z.string().nullable(),
  }),
});

export const linkCreate = defineOperation({
  name: "link_create",
  shorthand: "resolve",
  summary: "Create a share link",
  description:
    "Creates a read-only, expiring share link to a collection, or to a prefix of it. Whoever holds the secret can " +
    "list, stat, read the history of and get objects under that URI, and nothing else. The secret is only returned " +
    "here. Needs admin access to the collection.",
  access: "write",
  role: "admin",
  visibility: "public",
  customCli: true,
  input: z.object({
    uri: uri("Collection or prefix URI, for example storage://acme/pr-482/ or storage://acme/pr-482/screenshots/."),
    name: z.string().min(1).max(100).optional().describe("A label for the link, for example reviewer."),
    expires_in_days: z
      .int()
      .min(1)
      .max(365)
      .default(7)
      .describe("Days until the link expires. The server caps this (30 days by default)."),
  }),
  output: z.object({
    secret: z.string().describe("The link secret, used as a bearer token. Shown once."),
    link: linkSchema,
  }),
});

export const linkList = defineOperation({
  name: "link_list",
  shorthand: "resolve",
  summary: "List a collection's share links",
  description:
    "Lists the share links on a collection that haven't been revoked, newest first, including expired ones. " +
    "Needs admin access to the collection.",
  access: "read",
  role: "admin",
  visibility: "public",
  customCli: true,
  input: z.object({ uri: uri("Collection URI.") }),
  output: z.object({ uri: z.string(), links: z.array(linkSchema) }),
});

export const linkRevoke = defineOperation({
  name: "link_revoke",
  summary: "Revoke a share link",
  description:
    "Revokes a share link. It stops working on the next request. Revoking a revoked link returns its revocation " +
    "time. Needs admin access to the link's collection.",
  access: "write",
  role: "admin",
  visibility: "public",
  customCli: true,
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ id: z.string(), uri: z.string(), revoked_at: z.string() }),
});

// ---------------------------------------------------------------------------
// Internal operations: client <-> server wire protocol.
// ---------------------------------------------------------------------------

export const uploadInitiate = defineOperation({
  name: "upload_initiate",
  shorthand: "create",
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
  shorthand: "resolve",
  summary: "Issue a signed download URL",
  description: "Authorizes a read and returns a short-lived URL for the object's bytes.",
  access: "read",
  role: "reader",
  visibility: "internal",
  input: z.object({ uri: uri("Object URI, optionally with a version selector.") }),
  output: versionSchema.extend({
    url: z.string(),
    url_expires_at: z.string(),
    default_delivery: deliverySchema.describe("The token's default_delivery, else ref."),
  }),
});

export const resolveShorthand = defineOperation({
  name: "resolve_shorthand",
  summary: "Resolve a gh-pr: URI",
  description:
    "Resolves a gh-pr: URI to the storage URI of the PR's collection for the named operation, creating and " +
    "binding the collection when the operation writes and there is none (docs/specs/gh-pr-shorthand.md).",
  access: "read",
  visibility: "internal",
  input: z.object({
    uri: uri("A gh-pr: URI."),
    operation: z.string().min(1).describe("The operation the URI is for."),
    org: z.string().regex(SLUG_PATTERN).optional().describe("Org slug to resolve in, from STORAGE_ORG."),
  }),
  output: z.object({
    uri: z.string().describe("The resolved storage URI."),
    collection: z.string().describe("The collection URI."),
    target: z.string().describe("The binding target, github:<owner>/<repo>#<number>."),
    created: z.boolean().describe("True when this call created and bound the collection."),
  }),
});

const orgAndName = z.object({
  org: z.string().regex(SLUG_PATTERN).describe("Org slug."),
  name: z.string().regex(SLUG_PATTERN).describe("Service name."),
});

const serviceRef = z
  .string()
  .regex(
    new RegExp(`^${SLUG_PATTERN.source.slice(1, -1)}/${SLUG_PATTERN.source.slice(1, -1)}$`),
    "Expected <org>/<name>.",
  );

export const serviceCreate = defineOperation({
  name: "service_create",
  summary: "Create a service",
  description:
    "Creates a service in an org: a non-human principal (service:<org>/<name>) that can be granted access and " +
    "given tokens. Idempotent on the name. Needs org admin access and an unscoped user token.",
  access: "write",
  visibility: "internal",
  input: orgAndName,
  output: z.object({ service: serviceSchema, created: z.boolean() }),
});

export const serviceList = defineOperation({
  name: "service_list",
  summary: "List an org's services",
  description: "Lists the org's services by name. Needs org access and an unscoped user token.",
  access: "read",
  visibility: "internal",
  input: z.object({ org: z.string().regex(SLUG_PATTERN).describe("Org slug.") }),
  output: z.object({ services: z.array(serviceSchema) }),
});

export const serviceDelete = defineOperation({
  name: "service_delete",
  summary: "Delete a service",
  description:
    "Deletes a service, revokes all its tokens and removes its grants in the org. Needs org admin access and an " +
    "unscoped user token.",
  access: "write",
  destructive: true,
  visibility: "internal",
  input: orgAndName,
  output: z.object({ service: serviceSchema, revoked_tokens: z.int(), removed_grants: z.int() }),
});

export const tokenCreate = defineOperation({
  name: "token_create",
  summary: "Create a token",
  description:
    "Creates a token. An unscoped user token creates user tokens for itself (scopes required) or, with service, " +
    "service tokens. Any other token creates a child token with the same principal and no more access than itself. " +
    "The secret is only returned here.",
  access: "write",
  visibility: "internal",
  input: z.object({
    name: z.string().min(1).max(100).describe("A label for the token, for example ci."),
    scopes: z.array(scopeSchema).min(1).max(20).optional(),
    service: serviceRef.optional().describe("<org>/<name>: create a token for this service instead of yourself."),
    allowed_tools: z.array(z.enum(TOOL_NAMES)).min(1).max(50).optional(),
    default_delivery: deliverySchema.optional(),
    expires_in_days: z.int().min(1).max(3650).optional(),
  }),
  output: z.object({
    token: z.string().describe("The token secret. Shown once."),
    id: z.string(),
    name: z.string(),
    principal: z.string(),
    scopes: z.array(scopeSchema).nullable().describe("Null means the principal's full access."),
    allowed_tools: z.array(z.string()).nullable(),
    default_delivery: deliverySchema.nullable(),
    created_at: z.string(),
    expires_at: z.string().nullable().describe("Null means the token never expires."),
    parent_id: z.string().nullable(),
  }),
});

export const tokenList = defineOperation({
  name: "token_list",
  summary: "List tokens",
  description:
    "An unscoped user token lists its principal's tokens that haven't been revoked, or a service's with service. " +
    "Any other token lists itself and the live tokens created from it. Newest first.",
  access: "read",
  visibility: "internal",
  input: z.object({ service: serviceRef.optional().describe("<org>/<name>: list this service's tokens.") }),
  output: z.object({
    tokens: z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        principal: z.string(),
        scopes: z.array(scopeSchema).nullable(),
        allowed_tools: z.array(z.string()).nullable(),
        parent_id: z.string().nullable(),
        default_delivery: deliverySchema.nullable(),
        created_at: z.string(),
        expires_at: z.string().nullable(),
        last_used_at: z.string().nullable(),
        expired: z.boolean(),
        current: z.boolean().describe("True for the token making this call."),
      }),
    ),
  }),
});

export const tokenRevoke = defineOperation({
  name: "token_revoke",
  summary: "Revoke a token",
  description:
    "Revokes a token and every token created from it. It stops working on the next request. An unscoped user token " +
    "may revoke any of its principal's tokens, and its org's service tokens if it is an org admin; any other token " +
    "may revoke itself and the tokens created from it.",
  access: "write",
  visibility: "internal",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({
    id: z.string(),
    revoked_at: z.string(),
    also_revoked: z.array(z.string()).describe("Ids of descendant tokens revoked by this call."),
  }),
});

export const connectStart = defineOperation({
  name: "connect_start",
  summary: "Start connecting an account",
  description:
    "Returns a single-use link, valid for 10 minutes, to open in a browser to connect a GitHub account to the " +
    "signed-in user. Needs an unscoped user token.",
  access: "write",
  visibility: "internal",
  input: z.object({ provider: z.literal("github") }),
  output: z.object({ url: z.string(), expires_at: z.string() }),
});

export const disconnect = defineOperation({
  name: "disconnect",
  summary: "Disconnect an account",
  description:
    "Disconnects the user's connected account. Grants to it stay and apply again if it is reconnected. Needs an " +
    "unscoped user token. Returns disconnected: false if nothing was connected.",
  access: "write",
  destructive: true,
  visibility: "internal",
  input: z.object({ provider: z.literal("github") }),
  output: z.object({ provider: z.literal("github"), disconnected: z.boolean() }),
});

const installationSchema = z.object({
  installation_id: z.string().describe("GitHub's id for the installation."),
  account_login: z.string().describe("The GitHub user or org the app is installed on."),
  account_type: z.enum(["User", "Organization"]),
  created_by: z.string(),
  created_at: z.string(),
});

export const githubInstallStart = defineOperation({
  name: "github_install_start",
  summary: "Start linking a GitHub App installation to an org",
  description:
    "Returns a single-use link, valid for 10 minutes, to open in a browser to install the server's GitHub App on a " +
    "GitHub account and link the installation to the org, so collections can be bound to its pull requests. Needs " +
    "an org-level admin grant and an unscoped user token.",
  access: "write",
  role: "admin",
  visibility: "internal",
  input: z.object({ uri: uri("Org URI, for example storage://acme/.") }),
  output: z.object({ url: z.string(), expires_at: z.string() }),
});

export const githubInstallationList = defineOperation({
  name: "github_installation_list",
  summary: "List the GitHub App installations linked to an org",
  description: "Lists the GitHub App installations linked to an org. Needs an org-level grant and an unscoped token.",
  access: "read",
  role: "reader",
  visibility: "internal",
  input: z.object({ uri: uri("Org URI.") }),
  output: z.object({ uri: z.string(), installations: z.array(installationSchema) }),
});

export const githubInstallationRemove = defineOperation({
  name: "github_installation_remove",
  summary: "Unlink a GitHub App installation from an org",
  description:
    "Unlinks a GitHub App installation from an org. Bindings made through it keep their state but stop updating. " +
    "Needs an org-level admin grant and an unscoped token.",
  access: "write",
  role: "admin",
  destructive: true,
  visibility: "internal",
  input: z.object({ uri: uri("Org URI."), installation_id: z.string().min(1) }),
  output: z.object({ uri: z.string(), removed: installationSchema }),
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
  restore,
  lifecycle,
  setLifecycle,
  bind,
  unbind,
  grants,
  share,
  unshare,
  audit,
  linkCreate,
  linkList,
  linkRevoke,
  uploadInitiate,
  uploadCommit,
  downloadUrl,
  resolveShorthand,
  serviceCreate,
  serviceList,
  serviceDelete,
  tokenCreate,
  tokenList,
  tokenRevoke,
  connectStart,
  disconnect,
  githubInstallStart,
  githubInstallationList,
  githubInstallationRemove,
] as const satisfies readonly OperationSpec[];

export const PUBLIC_OPERATIONS: readonly OperationSpec[] = OPERATIONS.filter((op) => op.visibility === "public");

/** The public operations offered on `surface`, as CLI commands or MCP tools. */
export function operationsFor(surface: Surface): readonly OperationSpec[] {
  return OPERATIONS.filter((op) => offeredOn(op, surface));
}

const BY_NAME = new Map<string, OperationSpec>(OPERATIONS.map((op) => [op.name, op]));

export function findOperation(name: string): OperationSpec | undefined {
  return BY_NAME.get(name);
}
