import { z } from "zod";
import { SLUG_PATTERN } from "./uri.js";

export const metaSchema = z
  .record(z.string(), z.string())
  .describe("String key/value metadata, for example route=/settings or state=after.");

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase hex SHA-256 digest.");

const SLUG_BODY = SLUG_PATTERN.source.slice(1, -1);

export const roleSchema = z.enum(["reader", "writer", "admin"]);

export const deliverySchema = z.enum(["ref", "inline"]);

/** A token scope (design doc §8.5): a role on the collections of one org whose slugs match a glob. */
export const scopeSchema = z.object({
  collection: z
    .string()
    .regex(
      new RegExp(`^${SLUG_BODY}/[a-z0-9*?-]{1,63}$`),
      "Expected <org>/<collection-glob>, where the glob uses a-z, 0-9, -, * and ?.",
    )
    .describe("<org>/<glob>. * matches any run of characters and ? one character, for example acme/pr-*."),
  role: roleSchema,
});

export type Scope = z.infer<typeof scopeSchema>;

export const collectionSchema = z.object({
  uri: z.string(),
  org: z.string(),
  slug: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  state: z.enum(["active", "expiring", "deleted"]),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Collection = z.infer<typeof collectionSchema>;

/** An immutable version of an object (design doc §7.1). */
export const versionSchema = z.object({
  uri: z.string().describe("Object URI without a version selector."),
  path: z.string(),
  version: z.int(),
  sha256: sha256Schema,
  size: z.int(),
  content_type: z.string(),
  description: z.string().nullable(),
  meta: metaSchema,
  uploaded_by: z.string(),
  uploaded_at: z.string(),
});

export type Version = z.infer<typeof versionSchema>;

export const listObjectSchema = z.object({
  uri: z.string(),
  path: z.string(),
  version: z.int(),
  sha256: sha256Schema,
  size: z.int(),
  content_type: z.string(),
  description: z.string().nullable(),
  meta: metaSchema,
  updated_at: z.string(),
});

export type ListObject = z.infer<typeof listObjectSchema>;

export const listPrefixSchema = z.object({
  uri: z.string(),
  path: z.string(),
  object_count: z.int(),
  total_size: z.int(),
});

export type ListPrefix = z.infer<typeof listPrefixSchema>;

export const uploadTargetSchema = z.object({
  url: z.string(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
});

export type UploadTarget = z.infer<typeof uploadTargetSchema>;

/** A GitHub login: 1 to 39 alphanumerics or single hyphens, not starting or ending with a hyphen. All digits is also accepted, as an id. */
const GITHUB_LOGIN = "[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}";

/**
 * Principals a grant can name in this version: users, by id (`user:usr_…`) or by email (`user:alice@acme.com`),
 * services, and GitHub users (`github-user:octocat`). Domain, GitHub org and team principals (design doc §8.2)
 * come later.
 */
export const principalInputSchema = z
  .string()
  .regex(
    new RegExp(
      `^(user:(usr_[0-9a-z]{1,64}|[^\\s@:]+@[^\\s@:]+\\.[^\\s@:]+)|service:(${SLUG_BODY}/)?${SLUG_BODY}|github-user:${GITHUB_LOGIN})$`,
    ),
    "Expected user:<email>, user:<user id>, service:<name>, service:<org>/<name> or github-user:<login>.",
  )
  .describe("Who to grant, for example user:alice@acme.com, service:bugbot or github-user:octocat.");

/** The principal string of a service (design doc §8.5), for example `service:acme/bugbot`. */
export function servicePrincipal(org: string, name: string): string {
  return `service:${org}/${name}`;
}

/** A service: a non-human principal that belongs to one org and holds grants and tokens like a user. */
export const serviceSchema = z.object({
  org: z.string(),
  name: z.string(),
  principal: z.string().describe("For example service:acme/bugbot."),
  created_by: z.string(),
  created_at: z.string(),
});

export type Service = z.infer<typeof serviceSchema>;

export const grantSchema = z.object({
  principal: z.string().describe("For example user:usr_123."),
  email: z.string().nullable().describe("The user's email, for user principals."),
  github_login: z.string().nullable().describe("The GitHub login, for github-user principals."),
  role: roleSchema,
  uri: z.string().describe("The org or collection the grant is on."),
  level: z.enum(["org", "collection"]),
  created_at: z.string(),
});

export type Grant = z.infer<typeof grantSchema>;

/** A share link (design doc §8.6): read-only access to a collection, or a prefix of it, for whoever holds the secret. */
export const linkSchema = z.object({
  id: z.string(),
  uri: z.string().describe("The collection or prefix the link can read."),
  name: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  last_used_at: z.string().nullable(),
  expired: z.boolean(),
});

export type Link = z.infer<typeof linkSchema>;

/** Audit log actions (design doc §15) recorded so far. */
export const AUDIT_ACTIONS = [
  "grant.create",
  "grant.update",
  "grant.delete",
  "token.create",
  "token.revoke",
  "service.create",
  "service.delete",
  "link.create",
  "link.revoke",
  "link.use",
  "object.put",
  "object.delete",
  "url.issue",
  "content.inline",
  "user.sign_in",
] as const;

export const auditActionSchema = z.enum(AUDIT_ACTIONS);

export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.string(),
  token_id: z.string().nullable(),
  action: auditActionSchema,
  target: z.string(),
  detail: z.record(z.string(), z.unknown()),
});
