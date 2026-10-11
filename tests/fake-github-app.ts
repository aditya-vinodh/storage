import type { GitHubApp, Installation } from "@storage/server";
import { SignInError } from "@storage/server";

export interface FakePull {
  state: "open" | "closed";
  closed_at: string | null;
  merged_at: string | null;
  updated_at: string;
}

export type PullAnswer = FakePull | { status: number } | Error;

export interface FakeGitHubApp extends GitHubApp {
  /** `owner/repo#n` (lowercase) -> the pull request, a `{ status }` failure, or an Error to throw. Missing is a 404. */
  pulls: Map<string, PullAnswer>;
  /** Every `pull` call, in order. */
  calls: { installationId: string; key: string }[];
  /** Authorization code -> user token returned by exchangeCode. Unknown codes throw SignInError. */
  codes: Map<string, string>;
  /** User token -> the installations GET /user/installations returns. */
  installations: Map<string, Installation[]>;
}

export function fakeGitHubApp(
  options: {
    pulls?: Record<string, PullAnswer>;
    codes?: Record<string, string>;
    installations?: Record<string, Installation[]>;
  } = {},
): FakeGitHubApp {
  const fake: FakeGitHubApp = {
    pulls: new Map(Object.entries(options.pulls ?? {})),
    calls: [],
    codes: new Map(Object.entries(options.codes ?? {})),
    installations: new Map(Object.entries(options.installations ?? {})),
    installUrl(state) {
      return `http://github.test/apps/storage-test/installations/new?state=${encodeURIComponent(state)}`;
    },
    async exchangeCode(code) {
      const token = fake.codes.get(code);
      if (token === undefined) {
        throw new SignInError("GitHub refused the authorization.");
      }
      return token;
    },
    async userInstallations(userToken) {
      return fake.installations.get(userToken) ?? [];
    },
    async pull(installationId, owner, repo, number) {
      const key = `${owner}/${repo}#${number}`.toLowerCase();
      fake.calls.push({ installationId, key });
      const answer = fake.pulls.get(key);
      if (answer === undefined) {
        return { ok: false, status: 404 };
      }
      if (answer instanceof Error) {
        throw answer;
      }
      if ("status" in answer) {
        return { ok: false, status: answer.status };
      }
      return { ok: true, pull: answer };
    },
  };
  return fake;
}
