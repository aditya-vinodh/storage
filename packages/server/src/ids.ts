import { randomBytes } from "node:crypto";

export type IdPrefix = "org" | "usr" | "tok" | "grt" | "col" | "obj" | "ver" | "upl" | "aud";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}
