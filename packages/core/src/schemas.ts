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

/** `<n>d` or `<n>h`. The upper bounds (36500 days, 876000 hours) are checked by the server. */
export const DURATION_PATTERN = /^[1-9][0-9]{0,5}[dh]$/;

/** A lifecycle rule (design doc §12.1, docs/specs/lifecycle-rules.md). Exactly one action per rule. */
export const lifecycleRuleSchema = z
  .strictObject({
    prefix: z
      .string()
      .max(1024)
      .describe('"" for the whole collection, or a path prefix ending in /, for example videos/.'),
    delete_after: z
      .string()
      .regex(DURATION_PATTERN, "Expected a duration such as 7d or 12h.")
      .optional()
      .describe("Soft-delete objects under the prefix this long after the collection was created, for example 30d."),
    keep_versions: z
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Keep only this many of the newest versions of each object under the prefix."),
  })
  .refine((rule) => (rule.delete_after === undefined) !== (rule.keep_versions === undefined), {
    message: "A rule needs exactly one of delete_after and keep_versions.",
  });

export type LifecycleRule = z.infer<typeof lifecycleRuleSchema>;

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

/** A DNS label: 1 to 63 alphanumerics or hyphens, not starting or ending with a hyphen. */
const DNS_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";

/** A hostname with at least two labels and at most 253 characters. */
const DOMAIN = `(?=.{1,253}$)${DNS_LABEL}(?:\\.${DNS_LABEL})+`;

/**
 * Principals a grant can name: users, by id (`user:usr_…`) or by email (`user:alice@acme.com`), services,
 * GitHub users (`github-user:octocat`), Google Workspace domains (`google-domain:acme.com`), GitHub orgs
 * (`github-org:acme`) and GitHub teams (`github-team:acme/frontend`). The all-digit forms of the GitHub
 * principals are ids, which only `unshare` accepts.
 */
export const principalInputSchema = z
  .string()
  .regex(
    new RegExp(
      `^(user:(usr_[0-9a-z]{1,64}|[^\\s@:]+@[^\\s@:]+\\.[^\\s@:]+)|service:(${SLUG_BODY}/)?${SLUG_BODY}|github-user:${GITHUB_LOGIN}|google-domain:${DOMAIN}|github-org:${GITHUB_LOGIN}|github-team:(${GITHUB_LOGIN}/[A-Za-z0-9_.-]{1,100}|[0-9]+))$`,
    ),
    "Expected user:<email>, user:<user id>, service:<name>, service:<org>/<name>, github-user:<login>, google-domain:<domain>, github-org:<login> or github-team:<org>/<team>.",
  )
  .describe(
    "Who to grant, for example user:alice@acme.com, service:bugbot, github-user:octocat, google-domain:acme.com, github-org:acme or github-team:acme/frontend.",
  );

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
  name: z
    .string()
    .nullable()
    .describe(
      "The group's name, for google-domain, github-org and github-team principals: acme.com, acme or acme/frontend. Null if unknown.",
    ),
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
  "object.restore",
  "object.purge",
  "object.expire",
  "version.prune",
  "lifecycle.set",
  "url.issue",
  "content.inline",
  "user.sign_in",
  "account.connect",
  "account.disconnect",
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
