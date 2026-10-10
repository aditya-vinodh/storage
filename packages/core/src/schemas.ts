import { z } from "zod";

export const metaSchema = z
  .record(z.string(), z.string())
  .describe("String key/value metadata, for example route=/settings or state=after.");

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase hex SHA-256 digest.");

export const roleSchema = z.enum(["reader", "writer", "admin"]);

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
