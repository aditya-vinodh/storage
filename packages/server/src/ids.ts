import { randomBytes } from "node:crypto";

export type IdPrefix =
  | "org"
  | "bnd"
  | "usr"
  | "tok"
  | "grt"
  | "col"
  | "obj"
  | "ver"
  | "upl"
  | "aud"
  | "lnk"
  | "svc"
  | "idn"
  | "dev"
  | "sis"
  | "mcp"
  | "oar"
  | "rtk"
  | "cac"
  | "ctk"
  | "cst";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}
