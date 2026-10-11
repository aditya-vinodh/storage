import {
  type BindingTarget,
  findOperation,
  formatTarget,
  formatUri,
  isShorthand,
  type OperationSpec,
  ops,
  parseShorthand,
  pullRequestSlug,
  type Role,
  roleAtLeast,
  type Shorthand,
  StorageError,
} from "@storage/core";
import { requireAllowedTool, roleOnCollection, roleOnOrg, scopeRole } from "../auth.js";
import type { GitHubApp } from "../github/app.js";
import type { OpenPullResult } from "../github/pulls.js";
import { newId } from "../ids.js";
import { insertBinding, readPull } from "./bindings.js";
import { handle, type ServiceContext } from "./context.js";
import { retryOnUniqueViolation } from "./grants.js";
import { collectionUri } from "./resolve.js";

/** Resolving `gh-pr:` URIs to the PR's collection, creating and binding it on a write (docs/specs/gh-pr-shorthand.md). */

interface Candidate {
  org: { id: string; slug: string };
  installationId: string;
  orgRole: Role | null;
  /** The collection bound to the PR in this org, when the caller can read it. Only known for the `#<n>` form. */
  bound: { slug: string } | null;
}

export interface Resolved {
  uri: string;
  collection: string;
  target: string;
  created: boolean;
}

function describe(shorthand: Shorthand): string {
  const pr = "number" in shorthand.pr ? `#${shorthand.pr.number}` : `@${shorthand.pr.branch}`;
  return `gh-pr:${shorthand.owner}/${shorthand.repo}${pr}`;
}

/** True if the token's scopes allow anything in `org`. Unscoped tokens allow everything. */
function scopesTouchOrg(ctx: ServiceContext, org: string): boolean {
  const { scopes } = ctx.principal.token;
  return scopes === null || scopes.some((scope) => scope.collection.startsWith(`${org}/`));
}

/** The bound collection in an org, if the caller can read it. */
async function boundCollection(
  ctx: ServiceContext,
  org: { id: string; slug: string },
  target: string,
): Promise<{ id: string; slug: string } | null> {
  const row = await ctx.db
    .selectFrom("bindings")
    .innerJoin("collections", "collections.id", "bindings.collection_id")
    .select(["collections.id", "collections.slug"])
    .where("bindings.org_id", "=", org.id)
    .where("bindings.target", "=", target)
    .where("collections.state", "!=", "deleted")
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  const role = await roleOnCollection(ctx.db, ctx.principal, org.id, row.id, org.slug, row.slug);
  return role === null ? null : row;
}

/** The orgs this URI can resolve in for this caller (spec: "Which org a gh-pr: URI lands in"). */
async function candidates(
  ctx: ServiceContext,
  shorthand: Shorthand,
  create: boolean,
  orgHint: string | undefined,
): Promise<Candidate[]> {
  let query = ctx.db
    .selectFrom("github_installations")
    .innerJoin("orgs", "orgs.id", "github_installations.org_id")
    .select(["orgs.id", "orgs.slug", "github_installations.installation_id"])
    .where("github_installations.account_login", "=", shorthand.owner)
    .orderBy("orgs.slug")
    .orderBy("github_installations.created_at");
  if (orgHint !== undefined) {
    query = query.where("orgs.slug", "=", orgHint);
  }
  const rows = await query.execute();

  const found: Candidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    // An org can link one installation per account, but take the first if it ever has more.
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    const org = { id: row.id, slug: row.slug };
    if (!scopesTouchOrg(ctx, org.slug)) {
      continue;
    }
    const orgRole = await roleOnOrg(ctx.db, ctx.principal, org.id);
    const bound =
      "number" in shorthand.pr
        ? await boundCollection(
            ctx,
            org,
            formatTarget({ kind: "github", owner: shorthand.owner, repo: shorthand.repo, number: shorthand.pr.number }),
          )
        : null;
    const qualifies =
      bound !== null || (create ? orgRole !== null && roleAtLeast(orgRole, "writer") : orgRole !== null);
    if (qualifies) {
      found.push({ org, installationId: row.installation_id, orgRole, bound });
    }
  }
  return found;
}

async function lookUpBranch(
  githubApp: GitHubApp,
  candidate: Candidate,
  shorthand: Shorthand & { pr: { branch: string } },
): Promise<number> {
  const { owner, repo } = shorthand;
  const { branch } = shorthand.pr;
  let result: OpenPullResult;
  try {
    result = await githubApp.openPull(candidate.installationId, owner, repo, branch);
  } catch (error) {
    console.warn(`Couldn't look up the pull request for ${owner}/${repo}@${branch} on GitHub:`, error);
    throw new StorageError("unavailable", `Couldn't read ${owner}/${repo} from GitHub. Try again.`);
  }
  if (!result.ok) {
    if (result.status === 404 || result.status === 403) {
      throw new StorageError(
        "not_found",
        `github:${owner}/${repo} isn't visible to the GitHub App in ${formatUri({ org: candidate.org.slug })}.`,
        "Add the repository to the app's installation on GitHub.",
      );
    }
    throw new StorageError("unavailable", `Couldn't read ${owner}/${repo} from GitHub. Try again.`);
  }
  if (result.number === null) {
    throw new StorageError("not_found", `No open pull request in ${owner}/${repo} has the head branch ${branch}.`);
  }
  return result.number;
}

/** Creates the PR's collection and binds it, in one transaction. Returns the collection's slug. */
async function createBound(
  ctx: ServiceContext,
  githubApp: GitHubApp,
  candidate: Candidate,
  parsed: BindingTarget,
): Promise<{ slug: string; created: boolean }> {
  const { org } = candidate;
  const target = formatTarget(parsed);
  const orgUri = formatUri({ org: org.slug });
  const slug = pullRequestSlug(parsed.repo, parsed.number);
  const display = collectionUri(org.slug, slug);
  const scope = scopeRole(ctx.principal, org.slug, slug);
  if (scope === null || !roleAtLeast(scope, "writer")) {
    throw new StorageError(
      "forbidden",
      `This token's scopes don't allow creating ${display}.`,
      `Use a token with a scope for ${org.slug}/${slug}:writer.`,
    );
  }
  if (candidate.orgRole === null || !roleAtLeast(candidate.orgRole, "writer")) {
    throw new StorageError(
      "not_found",
      `No collection in ${orgUri} is bound to ${target}.`,
      "Ask an org writer to create it by writing to it.",
    );
  }

  const pull = await readPull(githubApp, candidate.installationId, parsed, orgUri);

  // A lost race on the slug or the binding reruns the transaction, which then finds the winner's collection.
  return retryOnUniqueViolation(() =>
    ctx.db.transaction().execute(async (trx) => {
      const raced = await trx
        .selectFrom("bindings")
        .innerJoin("collections", "collections.id", "bindings.collection_id")
        .select("collections.slug")
        .where("bindings.org_id", "=", org.id)
        .where("bindings.target", "=", target)
        .executeTakeFirst();
      if (raced) {
        return { slug: raced.slug, created: false };
      }
      const taken = await trx
        .selectFrom("collections")
        .select("id")
        .where("org_id", "=", org.id)
        .where("slug", "=", slug)
        .executeTakeFirst();
      if (taken) {
        throw new StorageError(
          "conflict",
          `${display} already exists and isn't bound to ${target}.`,
          `Bind it with: storage bind ${display} ${target}`,
        );
      }
      const orgRow = await trx
        .selectFrom("orgs")
        .select("default_lifecycle_rules")
        .where("id", "=", org.id)
        .executeTakeFirstOrThrow();
      const now = ctx.now().toISOString();
      const id = newId("col");
      await trx
        .insertInto("collections")
        .values({
          id,
          org_id: org.id,
          slug,
          title: `${parsed.owner}/${parsed.repo}#${parsed.number}`,
          description: null,
          tags: "[]",
          state: "active",
          lifecycle_rules: orgRow.default_lifecycle_rules,
          created_by: ctx.principal.id,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await insertBinding(trx, ctx, {
        orgId: org.id,
        collectionId: id,
        display,
        target: parsed,
        pull,
        installationId: candidate.installationId,
      });
      return { slug, created: true };
    }),
  );
}

/** Resolves a `gh-pr:` URI for `spec`, which must take the shorthand. */
export async function resolveShorthandUri(
  ctx: ServiceContext,
  spec: OperationSpec,
  input: string,
  orgHint?: string,
): Promise<Resolved> {
  if (spec.shorthand === undefined) {
    throw new StorageError("invalid_argument", `${spec.name} doesn't take gh-pr: URIs.`, "Use a storage:// URI.");
  }
  if (ctx.principal.link !== null) {
    throw new StorageError("forbidden", "Share links can't use gh-pr: URIs.", "Use the storage:// URI of the link.");
  }
  const shorthand = parseShorthand(input);
  const githubApp = ctx.githubApp;
  if (githubApp === null) {
    throw new StorageError("unavailable", "The GitHub App isn't configured on this server.");
  }
  const create = spec.shorthand === "create";
  const name = describe(shorthand);

  const found = await candidates(ctx, shorthand, create, orgHint);
  if (found.length > 1) {
    throw new StorageError(
      "invalid_argument",
      `${name} matches several orgs: ${found.map((candidate) => candidate.org.slug).join(", ")}.`,
      "Set STORAGE_ORG to one of them, or use a storage:// URI.",
    );
  }
  const candidate = found[0];
  if (candidate === undefined) {
    throw new StorageError(
      "not_found",
      orgHint === undefined
        ? `No org you can access has the GitHub App installed for ${shorthand.owner}.`
        : `${formatUri({ org: orgHint })} has no GitHub installation for ${shorthand.owner} that you can use.`,
      `Install the app with: storage github install storage://${orgHint ?? "<org>"}/`,
    );
  }

  const number =
    "number" in shorthand.pr
      ? shorthand.pr.number
      : await lookUpBranch(githubApp, candidate, shorthand as Shorthand & { pr: { branch: string } });
  const parsed: BindingTarget = { kind: "github", owner: shorthand.owner, repo: shorthand.repo, number };
  const target = formatTarget(parsed);

  let slug: string;
  let created = false;
  const bound = candidate.bound ?? (await boundCollection(ctx, candidate.org, target));
  if (bound !== null) {
    slug = bound.slug;
  } else if (create) {
    ({ slug, created } = await createBound(ctx, githubApp, candidate, parsed));
  } else {
    const orgUri = formatUri({ org: candidate.org.slug });
    throw new StorageError(
      "not_found",
      `No collection in ${orgUri} is bound to ${target}.`,
      `Write to it to create one, or bind one: storage bind storage://${candidate.org.slug}/<collection>/ ${target}`,
    );
  }

  const collection = collectionUri(candidate.org.slug, slug);
  return { uri: `${collection}${shorthand.rest}`, collection, target, created };
}

/**
 * Replaces a `gh-pr:` `uri` in an operation's raw input with the storage URI it resolves to. Inputs without one,
 * and operations that don't take the shorthand, pass through unchanged (the operation then rejects the shorthand).
 */
export async function rewriteShorthand(spec: OperationSpec, rawInput: unknown, ctx: ServiceContext): Promise<unknown> {
  if (spec.shorthand === undefined || rawInput === null || typeof rawInput !== "object") {
    return rawInput;
  }
  const uri = (rawInput as { uri?: unknown }).uri;
  if (typeof uri !== "string" || !isShorthand(uri)) {
    return rawInput;
  }
  const resolved = await resolveShorthandUri(ctx, spec, uri);
  return { ...rawInput, uri: resolved.uri };
}

export const resolveShorthandHandler = handle(ops.resolveShorthand, async (input, ctx) => {
  const spec = findOperation(input.operation);
  if (spec === undefined || spec.shorthand === undefined) {
    throw new StorageError("invalid_argument", `${input.operation} doesn't take gh-pr: URIs.`);
  }
  requireAllowedTool(ctx.principal, spec.name);
  return resolveShorthandUri(ctx, spec, input.uri, input.org);
});
