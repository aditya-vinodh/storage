/** The public operations a token's `allowed_tools` can name. Matches PUBLIC_OPERATIONS (checked in a test). */
export const TOOL_NAMES = [
  "whoami",
  "collections",
  "create",
  "list",
  "stat",
  "history",
  "put",
  "get",
  "push",
  "pull",
  "delete",
  "restore",
  "lifecycle",
  "set-lifecycle",
  "bind",
  "unbind",
  "grants",
  "share",
  "unshare",
  "audit",
  "link_create",
  "link_list",
  "link_revoke",
] as const;

/**
 * True if a token limited to `allowed` (null for no limit) may call `operation`. Token self-management and
 * whoami are always allowed. The internal upload and download operations follow the public tools that use them.
 */
export function toolAllowed(allowed: readonly string[] | null, operation: string): boolean {
  if (allowed === null) {
    return true;
  }
  switch (operation) {
    case "whoami":
    case "token_create":
    case "token_list":
    case "token_revoke":
      return true;
    case "upload_initiate":
    case "upload_commit":
      return allowed.includes("put") || allowed.includes("push");
    case "download_url":
      return allowed.includes("get") || allowed.includes("pull");
    default:
      return allowed.includes(operation);
  }
}
