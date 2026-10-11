import type { Db } from "./db/index.js";
import { isConsumerDomain } from "./principals.js";
import type { SecretBox } from "./secret-box.js";
import { type GitHubConnector, GitHubTokenRevoked } from "./signin/github.js";

/** A principal the caller acts as besides itself, with a name for people to read. */
export interface Group {
  /** What grants store, for example `google-domain:acme.com`. */
  principal: string;
  /** For example `acme.com`, or a GitHub login. */
  name: string;
}

export interface MembershipResolver {
  /** The groups a user belongs to right now. Never throws for a missing account; it returns fewer groups. */
  forUser(userId: string, now: Date): Promise<Group[]>;
}

export interface MembershipOptions {
  db: Db;
  /** Extra consumer email domains, lowercased. The built-in list always applies. */
  consumerDomains: readonly string[];
  /** Null when GitHub isn't configured; org and team groups are then never returned. */
  github: GitHubConnector | null;
  box: SecretBox;
  /** How long fetched GitHub memberships are trusted. */
  ttlSeconds: number;
}

const RETRY_SECONDS = 60;

interface TokenRow {
  subject: string;
  access_token: string | null;
  token_scopes: string | null;
}

/** True if the comma-separated scopes include `read:org`. */
export function hasOrgScope(scopes: string | null): boolean {
  return (scopes ?? "").split(",").includes("read:org");
}

/** The account's GitHub token, or null unless it opens under this account's AAD and has the `read:org` scope. */
export function openGitHubToken(box: SecretBox, row: TokenRow): string | null {
  if (row.access_token === null || !hasOrgScope(row.token_scopes)) {
    return null;
  }
  return box.open(row.access_token, `github:${row.subject}`);
}

/**
 * Forgets a GitHub token that GitHub no longer honors, and the memberships fetched with it. `sealed` is the stored
 * token that failed: if the user reconnected in the meantime, the new token is left alone.
 */
export async function clearGitHubToken(db: Db, connectedAccountId: string, sealed: string): Promise<void> {
  await db
    .updateTable("connected_accounts")
    .set({ access_token: null, token_scopes: null, memberships: null, memberships_expires_at: null })
    .where("id", "=", connectedAccountId)
    .where("access_token", "=", sealed)
    .execute();
}

/** Records current names for group principals, so grants can show them. */
export async function saveGroupNames(db: Db, groups: readonly Group[], now: Date): Promise<void> {
  for (const group of groups) {
    await db
      .insertInto("github_principal_names")
      .values({ principal: group.principal, name: group.name, updated_at: now.toISOString() })
      .onConflict((oc) => oc.column("principal").doUpdateSet({ name: group.name, updated_at: now.toISOString() }))
      .execute();
  }
}

function parseGroups(json: string | null): Group[] {
  if (json === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((g): g is Group => typeof g?.principal === "string" && typeof g.name === "string")
      : [];
  } catch {
    return [];
  }
}

export function createMembershipResolver(options: MembershipOptions): MembershipResolver {
  const { db, consumerDomains, github, box, ttlSeconds } = options;
  const inFlight = new Map<string, Promise<Group[]>>();

  /**
   * Fetches memberships with the token and stores the outcome. Never throws because of GitHub. Writes apply only
   * while `sealed` is still the stored token, so a refresh that finishes after a reconnect can't undo it.
   */
  const refresh = async (accountId: string, sealed: string, token: string, now: Date): Promise<Group[]> => {
    let groups: Group[];
    try {
      groups = await (github as GitHubConnector).memberships(token);
    } catch (error) {
      if (error instanceof GitHubTokenRevoked) {
        await clearGitHubToken(db, accountId, sealed);
      } else {
        await db
          .updateTable("connected_accounts")
          .set({
            memberships: null,
            memberships_expires_at: null,
            memberships_retry_at: new Date(now.getTime() + RETRY_SECONDS * 1000).toISOString(),
          })
          .where("id", "=", accountId)
          .where("access_token", "=", sealed)
          .execute();
      }
      return [];
    }
    await db
      .updateTable("connected_accounts")
      .set({
        memberships: JSON.stringify(groups),
        memberships_expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
        memberships_retry_at: null,
      })
      .where("id", "=", accountId)
      .where("access_token", "=", sealed)
      .execute();
    await saveGroupNames(db, groups, now);
    return groups;
  };

  return {
    async forUser(userId, now) {
      const groups: Group[] = [];

      const account = await db
        .selectFrom("connected_accounts")
        .select([
          "id",
          "subject",
          "login",
          "access_token",
          "token_scopes",
          "memberships",
          "memberships_expires_at",
          "memberships_retry_at",
        ])
        .where("user_id", "=", userId)
        .where("provider", "=", "github")
        .executeTakeFirst();
      if (account) {
        groups.push({ principal: `github-user:${account.subject}`, name: account.login });
        const token = github === null ? null : openGitHubToken(box, account);
        if (token !== null && account.access_token !== null) {
          const at = now.getTime();
          if (account.memberships_expires_at !== null && new Date(account.memberships_expires_at).getTime() > at) {
            groups.push(...parseGroups(account.memberships));
          } else if (account.memberships_retry_at === null || new Date(account.memberships_retry_at).getTime() <= at) {
            let pending = inFlight.get(account.id);
            if (pending === undefined) {
              pending = refresh(account.id, account.access_token, token, now).finally(() =>
                inFlight.delete(account.id),
              );
              inFlight.set(account.id, pending);
            }
            groups.push(...(await pending));
          }
        }
      }

      const google = await db
        .selectFrom("identities")
        .select("hd")
        .where("user_id", "=", userId)
        .where("provider", "=", "google")
        .executeTakeFirst();
      if (google?.hd && !isConsumerDomain(google.hd, consumerDomains)) {
        groups.push({ principal: `google-domain:${google.hd}`, name: google.hd });
      }
      return groups;
    },
  };
}
