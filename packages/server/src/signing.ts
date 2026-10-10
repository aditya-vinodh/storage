import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signs short-lived capability tokens embedded in transfer URLs. A token is
 * `base64url(json payload).base64url(hmac-sha256)` and carries its own expiry.
 */
export class Signer {
  readonly #secret: string;

  constructor(secret: string) {
    if (secret.length < 32) {
      throw new Error("Signing secret must be at least 32 characters.");
    }
    this.#secret = secret;
  }

  sign(payload: Record<string, unknown>, expiresAt: Date): string {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(expiresAt.getTime() / 1000) })).toString(
      "base64url",
    );
    return `${body}.${this.#mac(body)}`;
  }

  /** Returns the payload, or null if the token is malformed, tampered with, or expired. */
  verify(token: string, now: Date = new Date()): Record<string, unknown> | null {
    const dot = token.indexOf(".");
    if (dot <= 0 || dot !== token.lastIndexOf(".")) {
      return null;
    }
    const body = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), "base64url");
    const expected = Buffer.from(this.#mac(body), "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return null;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (typeof payload !== "object" || payload === null) {
      return null;
    }
    const exp = (payload as { exp?: unknown }).exp;
    if (typeof exp !== "number" || exp * 1000 <= now.getTime()) {
      return null;
    }
    return payload as Record<string, unknown>;
  }

  #mac(body: string): string {
    return createHmac("sha256", this.#secret).update(body).digest("base64url");
  }
}
