import { describe, expect, it } from "vitest";
import { inlineKind } from "./inline.js";

describe("inlineKind", () => {
  it.each([
    ["image/png", "image"],
    ["image/JPEG", "image"],
    ["image/webp", "image"],
    ["image/gif", "image"],
    ["image/svg+xml", "text"],
    ["image/tiff", "binary"],
    ["text/plain; charset=utf-8", "text"],
    ["text/markdown", "text"],
    ["application/json", "text"],
    ["application/vnd.api+json", "text"],
    ["application/atom+xml", "text"],
    ["application/x-ndjson", "text"],
    ["application/yaml", "text"],
    ["application/pdf", "binary"],
    ["application/octet-stream", "binary"],
    ["video/mp4", "binary"],
  ])("%s is %s", (contentType, kind) => {
    expect(inlineKind(contentType)).toBe(kind);
  });
});
