const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PRIVATE_USE_SCHEME = /^[a-z][a-z0-9+.-]*$/;
const FORBIDDEN_SCHEMES = new Set([
  "javascript",
  "data",
  "file",
  "vbscript",
  "about",
  "blob",
  "ftp",
  "ws",
  "wss",
  "http",
  "https",
]);

export const MAX_REDIRECT_URI_LENGTH = 2000;

/**
 * True if a client may register `value` as a redirect URI: https, http on loopback, or a private-use scheme
 * (RFC 8252 §7.1). It must be absolute, with no fragment and no userinfo.
 */
export function isValidRedirectUri(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
  if (value.length > MAX_REDIRECT_URI_LENGTH || /[\u0000- \u007f]/.test(value) || value.includes("#")) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") {
    return false;
  }
  const scheme = url.protocol.slice(0, -1);
  if (scheme === "https") {
    return url.hostname !== "";
  }
  if (scheme === "http") {
    return LOOPBACK_HOSTS.has(url.hostname);
  }
  return PRIVATE_USE_SCHEME.test(scheme) && !FORBIDDEN_SCHEMES.has(scheme);
}

/** Where the user will be sent, for the consent page: the host for http(s), else the scheme, like `cursor:`. */
export function describeRedirectTarget(value: string): string {
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:" ? url.host : url.protocol;
}
