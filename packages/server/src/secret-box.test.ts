import { describe, expect, it } from "vitest";
import { SecretBox } from "./secret-box.js";
import { Signer } from "./signing.js";

const signer = new Signer("s".repeat(32));
const box = new SecretBox(signer.deriveKey("test box"));

describe("SecretBox", () => {
  it("round-trips a secret, with a fresh IV each time", () => {
    const sealed = box.seal("gho_secret", "github:42");
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain("gho_secret");
    expect(box.open(sealed, "github:42")).toBe("gho_secret");
    expect(box.seal("gho_secret", "github:42")).not.toBe(sealed);
  });

  it("refuses another AAD, another key, and tampered or malformed input", () => {
    const sealed = box.seal("gho_secret", "github:42");
    expect(box.open(sealed, "github:43")).toBeNull();
    expect(new SecretBox(signer.deriveKey("other box")).open(sealed, "github:42")).toBeNull();
    expect(new SecretBox(new Signer("t".repeat(32)).deriveKey("test box")).open(sealed, "github:42")).toBeNull();
    const [version, iv, body] = sealed.split(".") as [string, string, string];
    const flipped = Buffer.from(body, "base64url");
    flipped[0] = (flipped[0] as number) ^ 1;
    expect(box.open(`${version}.${iv}.${flipped.toString("base64url")}`, "github:42")).toBeNull();
    for (const junk of ["", "junk", "v2.a.b", `v1.${iv}`, `v1.AAAA.${body}`, `v1.${iv}.AAAA`]) {
      expect(box.open(junk, "github:42")).toBeNull();
    }
  });

  it("needs a 32-byte key", () => {
    expect(() => new SecretBox(Buffer.alloc(16))).toThrow();
  });
});
