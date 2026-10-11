import type { Db } from "./db/index.js";
import { isConsumerDomain } from "./principals.js";

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
}

export function createMembershipResolver(options: MembershipOptions): MembershipResolver {
  const { db, consumerDomains } = options;
  return {
    async forUser(userId) {
      const groups: Group[] = [];

      const github = await db
        .selectFrom("connected_accounts")
        .select(["subject", "login"])
        .where("user_id", "=", userId)
        .where("provider", "=", "github")
        .executeTakeFirst();
      if (github) {
        groups.push({ principal: `github-user:${github.subject}`, name: github.login });
        // GitHub org and team groups join here: refresh the cached memberships of this connected account.
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
