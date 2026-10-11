import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "./webhook.js";

const SECRET = "test-webhook-secret-1234";
const body = new TextEncoder().encode(JSON.stringify({ action: "closed", number: 1 }));
const sign = (secret: string, data: Uint8Array) => `sha256=${createHmac("sha256", secret).update(data).digest("hex")}`;

describe("verifyWebhookSignature", () => {
  it("accepts the HMAC-SHA256 of the body", () => {
    expect(verifyWebhookSignature(SECRET, body, sign(SECRET, body))).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifyWebhookSignature(SECRET, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, "")).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    expect(verifyWebhookSignature(SECRET, body, sign("another-secret-5678", body))).toBe(false);
  });

  it("rejects a signature over a different body", () => {
    expect(verifyWebhookSignature(SECRET, new TextEncoder().encode("{}"), sign(SECRET, body))).toBe(false);
  });

  it("rejects a missing prefix, another algorithm, bad hex and wrong lengths without throwing", () => {
    const hex = createHmac("sha256", SECRET).update(body).digest("hex");
    for (const header of [
      hex,
      `sha1=${hex}`,
      `sha256=${hex.slice(0, -2)}`,
      `sha256=${hex}00`,
      "sha256=",
      `sha256=${"z".repeat(64)}`,
    ]) {
      expect(verifyWebhookSignature(SECRET, body, header), header).toBe(false);
    }
  });
});
