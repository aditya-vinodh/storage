import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Seals secrets kept at rest, such as connected GitHub tokens, with AES-256-GCM. The AAD binds a sealed value to
 * where it is stored (for example `github:<subject>`), so it can't be copied to another row.
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error("SecretBox needs a 32-byte key.");
    }
    this.#key = key;
  }

  /** Returns `v1.<iv>.<ciphertext and tag>`, in base64url. */
  seal(plaintext: string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `${VERSION}.${iv.toString("base64url")}.${body.toString("base64url")}`;
  }

  /** The plaintext, or null if `sealed` is malformed, tampered with, or sealed under another key or AAD. */
  open(sealed: string, aad: string): string | null {
    const parts = sealed.split(".");
    if (parts.length !== 3 || parts[0] !== VERSION) {
      return null;
    }
    const iv = Buffer.from(parts[1] as string, "base64url");
    const body = Buffer.from(parts[2] as string, "base64url");
    if (iv.length !== IV_BYTES || body.length < TAG_BYTES) {
      return null;
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
      return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString(
        "utf8",
      );
    } catch {
      return null;
    }
  }
}
