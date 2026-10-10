/** Content returned in-band for `delivery: "inline"` when the caller collects it (MCP). */
export type InlineContent =
  | { kind: "text"; uri: string; sha256: string; text: string }
  | { kind: "image"; uri: string; sha256: string; data: string; mime_type: string };

/** Default cap on the raw bytes of one inline result. */
export const DEFAULT_INLINE_MAX_BYTES = 1024 * 1024;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-ndjson",
  "application/yaml",
  "application/toml",
]);

/** "text" | "image" | "binary", from a content type (parameters like ;charset ignored, case-insensitive). */
export function inlineKind(contentType: string): "text" | "image" | "binary" {
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (IMAGE_TYPES.has(type)) {
    return "image";
  }
  if (
    type.startsWith("text/") ||
    TEXT_APPLICATION_TYPES.has(type) ||
    type === "image/svg+xml" ||
    (type.startsWith("application/") && (type.endsWith("+json") || type.endsWith("+xml")))
  ) {
    return "text";
  }
  return "binary";
}
