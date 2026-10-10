import { StorageError } from "./errors.js";
import { type Scope, scopeSchema } from "./schemas.js";
import { ROLES, roleAtLeast } from "./spec.js";

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

/**
 * True if `parent` gives at least the access of `child`: the same org, a role at least as high, and every
 * collection the child's glob can match is matched by the parent's glob. `?` in the parent matches one
 * character that isn't `*`, so it never covers a child's `*`.
 */
export function scopeCovers(parent: Scope, child: Scope): boolean {
  const split = (collection: string) => {
    const slash = collection.indexOf("/");
    return { org: collection.slice(0, slash), glob: collection.slice(slash + 1) };
  };
  const p = split(parent.collection);
  const c = split(child.collection);
  if (p.org !== c.org || !roleAtLeast(parent.role, child.role)) {
    return false;
  }
  // Globs are validated to [a-z0-9*?-], so nothing else needs escaping.
  const source = [...p.glob].map((char) => (char === "*" ? ".*" : char === "?" ? "[^*]" : char)).join("");
  return new RegExp(`^${source}$`).test(c.glob);
}
