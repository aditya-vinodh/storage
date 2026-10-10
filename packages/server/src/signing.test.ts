import { describe, expect, it } from "vitest";
import { Signer } from "./signing.js";

const signer = new Signer("s".repeat(32));
const later = new Date(Date.now() + 60_000);

describe("Signer", () => {
  it("round-trips a payload", () => {
    const token = signer.sign({ op: "get", key: "k" }, later);
    expect(signer.verify(token)).toMatchObject({ op: "get", key: "k" });
  });

  it("rejects tampered, foreign, and expired tokens", () => {
    const token = signer.sign({ op: "get", key: "k" }, later);
    const [body, mac] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ op: "get", key: "other", exp: 9e9 })).toString("base64url")}.${mac}`;
    expect(signer.verify(forged)).toBeNull();
    expect(signer.verify(`${body}.AAAA`)).toBeNull();
    expect(new Signer("t".repeat(32)).verify(token)).toBeNull();
    expect(signer.verify(token, new Date(later.getTime() + 1000))).toBeNull();
    expect(signer.verify("garbage")).toBeNull();
  });

  it("requires a long secret", () => {
    expect(() => new Signer("short")).toThrow();
  });
});
