import { StorageError } from "./errors.js";
import { type Scope, scopeSchema } from "./schemas.js";
import { ROLES } from "./spec.js";

/** True if `pattern` (`<org>/<glob>`) covers the collection `org/slug`. `*` matches any run of characters, `?` one. */
export function scopeMatches(pattern: string, org: string, slug: string): boolean {
  const slash = pattern.indexOf("/");
  if (slash === -1 || pattern.slice(0, slash) !== org) {
    return false;
  }
  const glob = pattern.slice(slash + 1);
  const source = [...glob].map((char) => (char === "*" ? ".*" : char === "?" ? "." : char)).join("");
  // Globs are validated to [a-z0-9*?-], so nothing else needs escaping.
  return new RegExp(`^${source}$`).test(slug);
}

/** Parses `<org>/<collection-glob>:<role>`, splitting on the last colon. */
export function parseScopeArg(arg: string): Scope {
  const bad = () => new StorageError("invalid_argument", `Expected <org>/<collection-glob>:<role>, got "${arg}".`);
  const colon = arg.lastIndexOf(":");
  if (colon === -1) {
    throw bad();
  }
  const role = arg.slice(colon + 1);
  if (!(ROLES as readonly string[]).includes(role)) {
    throw bad();
  }
  const parsed = scopeSchema.safeParse({ collection: arg.slice(0, colon), role });
  if (!parsed.success) {
    throw bad();
  }
  return parsed.data;
}

export function formatScope(scope: Scope): string {
  return `${scope.collection}:${scope.role}`;
}

/** The SQL `LIKE` form of a collection glob. Slugs contain only [a-z0-9-], so no escaping is needed. */
export function scopeLikePattern(glob: string): string {
  return glob.replace(/\*/g, "%").replace(/\?/g, "_");
}
