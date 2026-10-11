import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runOperation } from "@storage/client";
import { type LifecycleRule, ops, StorageError } from "@storage/core";
import { bootstrapAdmin } from "@storage/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeGitHubApp, fakeGitHubApp } from "./fake-github-app.js";
import { createHarness, type Harness, SERVER_URL } from "./harness.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ORG = "storage://acme/";
const C1 = "storage://acme/c1/";
const C2 = "storage://acme/c2/";
const A = "storage://acme/c1/a.txt";
const TARGET = "github:acme/web#482";
const SECRET = "test-webhook-secret-1234";
const KEY = "acme/web#482";
const INSTALLATION = "1001";

let h: Harness;
let github: FakeGitHubApp;

beforeEach(async () => {
  github = fakeGitHubApp();
  h = await createHarness({ githubApp: github });
  github.pulls.set(KEY, openPull());
  await linkInstallation("acme");
  await runOperation(ops.create, { uri: C1 }, h.runner());
});

/** Links a GitHub App installation to the org directly, as a completed install flow would. */
async function linkInstallation(orgSlug: string, installationId = INSTALLATION, login = "acme") {
  const org = await h.db.selectFrom("orgs").select("id").where("slug", "=", orgSlug).executeTakeFirstOrThrow();
  await h.db
    .insertInto("github_installations")
    .values({
      id: `ghi_${orgSlug}_${installationId}`,
      org_id: org.id,
      installation_id: installationId,
      account_login: login,
      account_type: "Organization",
      created_by: "user:test",
      created_at: h.now().toISOString(),
    })
    .execute();
}

/** Creates the org `beta` with its own admin, a collection, and the same installation linked. */
async function betaOrg(): Promise<string> {
  const beta = await bootstrapAdmin(h.db, { org: "beta", email: "admin@beta.com" });
  await linkInstallation("beta");
  await runOperation(ops.create, { uri: "storage://beta/c/" }, h.runner(beta.token));
  return beta.token;
}

afterEach(async () => {
  await h.cleanup();
});

async function expectError(promise: Promise<unknown>, code: string): Promise<StorageError> {
  const error = await promise.then(
    () => {
      throw new Error(`Expected a ${code} error`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StorageError);
  expect((error as StorageError).code).toBe(code);
  return error as StorageError;
}

async function put(uri: string, content: string, token?: string) {
  const path = join(h.dir, `src-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(path, content);
  return runOperation(ops.put, { file: path, uri, content_type: "text/plain" }, h.runner(token));
}

function stat(uri: string) {
  return runOperation(ops.stat, { uri }, h.runner());
}

function bind(uri: string, target: string, token?: string) {
  return runOperation(ops.bind, { uri, target }, h.runner(token));
}

function unbind(uri: string, token?: string) {
  return runOperation(ops.unbind, { uri }, h.runner(token));
}

function setRules(rules: unknown[], token?: string, uri = C1) {
  return runOperation(ops.setLifecycle, { uri, rules: rules as LifecycleRule[] }, h.runner(token));
}

function lifecycle(uri = C1, token?: string) {
  return runOperation(ops.lifecycle, { uri }, h.runner(token));
}

async function auditEvents(action: string) {
  const { events } = await runOperation(ops.audit, { uri: ORG, limit: 100 }, h.runner());
  return events.filter((e) => e.action === action);
}

const closedRule = (prefix: string, after: string) => ({
  prefix,
  delete_after_event: { event: "binding.closed", after },
});
const mergedRule = (prefix: string, after: string) => ({
  prefix,
  delete_after_event: { event: "binding.merged", after },
});

interface Pull {
  number?: number;
  state: "open" | "closed";
  merged_at: string | null;
  closed_at: string | null;
  updated_at: string;
}

function openPull(updatedAt = h.now().toISOString()): Pull {
  return { state: "open", merged_at: null, closed_at: null, updated_at: updatedAt };
}

function closedPull(at = h.now().toISOString(), merged = false): Pull {
  return { state: "closed", merged_at: merged ? at : null, closed_at: at, updated_at: at };
}

/** Sends a pull_request delivery for acme/web#482 (or `repo`), signed with `secret` unless `secret` is null. */
function deliverPull(
  action: string,
  pull: Pull,
  options: { secret?: string | null; repo?: string; installation?: number } = {},
) {
  return deliver(
    "pull_request",
    {
      action,
      installation: { id: options.installation ?? 1001 },
      repository: { name: options.repo ?? "web", owner: { login: "acme" } },
      pull_request: { number: pull.number ?? 482, ...pull },
    },
    options,
  );
}

function deliver(event: string, payload: unknown, options: { secret?: string | null; rawBody?: string } = {}) {
  const body = options.rawBody ?? JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": event };
  if (options.secret !== null) {
    headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", options.secret ?? SECRET)
      .update(body)
      .digest("hex")}`;
  }
  return h.fetch(`${SERVER_URL}/v1/github/webhook`, { method: "POST", headers, body });
}

async function deliverOk(action: string, pull: Pull) {
  const response = await deliverPull(action, pull);
  expect(response.status).toBe(200);
  return (await response.json()) as { ok: boolean; bindings: number };
}

describe("bind and unbind", () => {
  it("binds a collection, normalizing the target, and shows it in lifecycle and the audit log", async () => {
    const out = await bind(C1, "github:Acme/Web#482");
    expect(out.changed).toBe(true);
    expect(out.uri).toBe(C1);
    expect(out.binding).toMatchObject({
      target: TARGET,
      url: "https://github.com/acme/web/pull/482",
      state: "open",
      closed_at: null,
      merged_at: null,
      poll_error: null,
    });
    expect((await lifecycle()).binding).toMatchObject({ target: TARGET, state: "open" });
    expect(github.calls).toEqual([{ installationId: INSTALLATION, key: KEY }]);
    const events = await auditEvents("binding.create");
    expect(events).toHaveLength(1);
    expect(events[0]?.target).toBe(C1);
    expect(events[0]?.detail).toMatchObject({ target: TARGET });
    for (const action of ["binding.closed", "binding.merged", "binding.reopened"]) {
      expect(await auditEvents(action)).toEqual([]);
    }
  });

  it("starts a binding to a merged PR as merged with its times and records no state event", async () => {
    const at = new Date(h.now().getTime() - DAY).toISOString();
    github.pulls.set(KEY, closedPull(at, true));
    const out = await bind(C1, TARGET);
    expect(out.binding).toMatchObject({ state: "merged", closed_at: at, merged_at: at, updated_at: at });
    expect(await auditEvents("binding.merged")).toEqual([]);
    expect(await auditEvents("binding.create")).toHaveLength(1);
  });

  it("is a no-op to bind the same target again in any case", async () => {
    await bind(C1, TARGET);
    const again = await bind(C1, "github:ACME/Web#482");
    expect(again.changed).toBe(false);
    expect(again.binding?.target).toBe(TARGET);
    expect(await auditEvents("binding.create")).toHaveLength(1);
  });

  it("conflicts on another target, on a target bound elsewhere in the org, and allows it in another org", async () => {
    await runOperation(ops.create, { uri: C2 }, h.runner());
    await bind(C1, TARGET);
    github.pulls.set("acme/web#999", openPull());

    const other = await expectError(bind(C1, "github:acme/web#999"), "conflict");
    expect(other.hint).toContain("unbind");
    const taken = await expectError(bind(C2, TARGET), "conflict");
    expect(taken.message).toContain("c1");
    expect((await lifecycle(C2)).binding).toBeNull();

    const beta = await betaOrg();
    const out = await bind("storage://beta/c/", TARGET, beta);
    expect(out.changed).toBe(true);
    expect(out.binding?.target).toBe(TARGET);
  });

  it("refuses to bind without a covering installation, on GitHub failures, or without the app, and stores nothing", async () => {
    const install = await expectError(bind(C1, "github:other/web#1"), "precondition_failed");
    expect(install.message).toMatch(/No GitHub installation in (storage:\/\/)?acme\/? covers other/);
    expect(install.hint).toContain("storage github install storage://acme/");

    github.pulls.set(KEY, { status: 404 });
    await expectError(bind(C1, TARGET), "not_found");
    github.pulls.set(KEY, { status: 403 });
    const hidden = await expectError(bind(C1, TARGET), "not_found");
    expect(hidden.message).toMatch(/isn't visible to the GitHub App in (storage:\/\/)?acme/);
    github.pulls.set(KEY, { status: 500 });
    await expectError(bind(C1, TARGET), "unavailable");
    github.pulls.set(KEY, new Error("connection reset"));
    await expectError(bind(C1, TARGET), "unavailable");
    expect((await lifecycle()).binding).toBeNull();
    expect(await auditEvents("binding.create")).toEqual([]);

    await h.cleanup();
    h = await createHarness();
    await runOperation(ops.create, { uri: C1 }, h.runner());
    await expectError(bind(C1, TARGET), "unavailable");
    expect((await lifecycle()).binding).toBeNull();
  });

  const invalidTargets = [
    "github:acme/web",
    "github:acme#1",
    "gh:acme/web#1",
    "github:acme/web#0",
    "github:acme/web#01",
    "github:-acme/web#1",
    "github:acme/..#1",
  ];
  for (const target of invalidTargets) {
    it(`rejects the target ${target} with invalid_argument`, async () => {
      await expectError(bind(C1, target), "invalid_argument");
      expect((await lifecycle()).binding).toBeNull();
    });
  }

  it("forbids readers, shuts out share links, and rejects object URIs", async () => {
    const reader = await h.addUser("rita@acme.com", "reader");
    const { secret } = await h.runner().api.call(ops.linkCreate, { uri: C1, expires_in_days: 7 });
    await expectError(bind(C1, TARGET, reader), "forbidden");
    await expectError(bind(C1, TARGET, secret), "forbidden");
    await expectError(bind(A, TARGET), "invalid_argument");
    expect((await lifecycle()).binding).toBeNull();
  });

  it("unbinds, audits binding.delete, and reports changed false when there is no binding", async () => {
    await bind(C1, TARGET);
    const out = await unbind(C1);
    expect(out).toMatchObject({ uri: C1, binding: null, changed: true });
    expect((await lifecycle()).binding).toBeNull();
    const events = await auditEvents("binding.delete");
    expect(events).toHaveLength(1);
    expect(events[0]?.target).toBe(C1);
    expect(events[0]?.detail).toMatchObject({ target: TARGET });

    expect(await unbind(C1)).toMatchObject({ binding: null, changed: false });
    expect(await auditEvents("binding.delete")).toHaveLength(1);
  });
});

describe("event rules", () => {
  it("accepts delete_after_event rules", async () => {
    const rules = [closedRule("videos/", "7d"), mergedRule("", "12h")];
    const out = await setRules(rules);
    expect(out.rules).toEqual(rules);
    expect((await lifecycle()).rules).toEqual(rules);
  });

  const invalid: Array<[string, unknown[]]> = [
    ["an unknown event", [{ prefix: "", delete_after_event: { event: "binding.opened", after: "7d" } }]],
    ["binding.reopened", [{ prefix: "", delete_after_event: { event: "binding.reopened", after: "7d" } }]],
    ["a bad after", [{ prefix: "", delete_after_event: { event: "binding.closed", after: "7" } }]],
    ["an extra key", [{ prefix: "", delete_after_event: { event: "binding.closed", after: "7d", extra: 1 } }]],
    [
      "both delete_after and delete_after_event",
      [{ prefix: "", delete_after: "7d", delete_after_event: { event: "binding.closed", after: "7d" } }],
    ],
  ];
  for (const [name, rules] of invalid) {
    it(`rejects ${name} with invalid_argument`, async () => {
      await expectError(setRules(rules), "invalid_argument");
      expect((await lifecycle()).rules).toEqual([]);
    });
  }

  it("lists a rule as waiting while the PR is open, and deletes nothing", async () => {
    await put(`${C1}videos/a.mp4`, "va");
    await put(`${C1}videos/b.mp4`, "vb");
    await bind(C1, TARGET);
    await setRules([closedRule("videos/", "7d"), closedRule("empty/", "7d")]);

    const out = await lifecycle();
    expect(out.scheduled).toEqual([]);
    expect(out.next).toBeNull();
    expect(out.waiting).toEqual([
      { prefix: "videos/", event: "binding.closed", after: "7d", objects: 2 },
      { prefix: "empty/", event: "binding.closed", after: "7d", objects: 0 },
    ]);
    expect(out.binding?.state).toBe("open");

    h.advance(60 * DAY);
    expect((await h.runMaintenance()).expiredObjects).toBe(0);
    expect((await stat(`${C1}videos/a.mp4`)).version).toBe(1);
  });
});

describe("webhook", () => {
  it("applies a merged delivery and moves closed and merged rules to scheduled", async () => {
    await put(`${C1}closed/x`, "cx");
    await put(`${C1}merged/y`, "my");
    await bind(C1, TARGET);
    await setRules([closedRule("closed/", "7d"), mergedRule("merged/", "3d")]);
    const at = h.now().toISOString();

    expect(await deliverOk("closed", closedPull(at, true))).toEqual({ ok: true, bindings: 1 });

    const out = await lifecycle();
    expect(out.binding).toMatchObject({ target: TARGET, state: "merged", closed_at: at, merged_at: at });
    expect(out.waiting).toEqual([]);
    const byPrefix = (prefix: string) => out.scheduled.find((s) => s.prefix === prefix);
    expect(byPrefix("closed/")).toMatchObject({
      delete_after_event: { event: "binding.closed", after: "7d" },
      at: new Date(new Date(at).getTime() + 7 * DAY).toISOString(),
      due: false,
      objects: 1,
    });
    expect(byPrefix("merged/")).toMatchObject({
      delete_after_event: { event: "binding.merged", after: "3d" },
      at: new Date(new Date(at).getTime() + 3 * DAY).toISOString(),
      due: false,
      objects: 1,
    });

    const events = await auditEvents("binding.merged");
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("system:github");
    expect(events[0]?.target).toBe(C1);
    expect(events[0]?.detail).toMatchObject({ target: TARGET, source: "webhook" });
  });

  it("applies a close without merge, leaving merged rules waiting", async () => {
    await put(`${C1}closed/x`, "cx");
    await put(`${C1}merged/y`, "my");
    await bind(C1, TARGET);
    await setRules([closedRule("closed/", "7d"), mergedRule("merged/", "3d")]);
    const at = h.now().toISOString();

    await deliverOk("closed", closedPull(at, false));

    const out = await lifecycle();
    expect(out.binding).toMatchObject({ state: "closed", closed_at: at, merged_at: null });
    expect(out.scheduled.map((s) => s.prefix)).toEqual(["closed/"]);
    expect(out.waiting).toEqual([{ prefix: "merged/", event: "binding.merged", after: "3d", objects: 1 }]);
    const events = await auditEvents("binding.closed");
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("system:github");
    expect(await auditEvents("binding.merged")).toHaveLength(0);
  });

  it("expires governed objects once the delay has passed and refuses puts into the prefix", async () => {
    await put(`${C1}videos/a.mp4`, "va");
    await put(`${C1}docs/d.txt`, "d");
    await bind(C1, TARGET);
    await setRules([closedRule("videos/", "7d")]);
    await deliverOk("closed", closedPull());

    h.advance(7 * DAY - HOUR);
    expect((await h.runMaintenance()).expiredObjects).toBe(0);

    h.advance(2 * HOUR);
    expect((await h.runMaintenance()).expiredObjects).toBe(1);
    await expectError(stat(`${C1}videos/a.mp4`), "not_found");
    expect((await stat(`${C1}docs/d.txt`)).version).toBe(1);
    const events = await auditEvents("object.expire");
    expect(events).toHaveLength(1);
    expect(events[0]?.detail.paths).toContain("videos/a.mp4");
    await expectError(put(`${C1}videos/new.mp4`, "nv"), "precondition_failed");
  });

  it("reopens before the due time, cancelling the rule", async () => {
    await put(`${C1}videos/a.mp4`, "va");
    await bind(C1, TARGET);
    await setRules([closedRule("videos/", "7d")]);
    await deliverOk("closed", closedPull());
    h.advance(DAY);
    await deliverOk("reopened", openPull());

    const out = await lifecycle();
    expect(out.binding).toMatchObject({ state: "open", closed_at: null, merged_at: null });
    expect(out.scheduled).toEqual([]);
    expect(out.waiting).toEqual([{ prefix: "videos/", event: "binding.closed", after: "7d", objects: 1 }]);
    const events = await auditEvents("binding.reopened");
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("system:github");

    h.advance(30 * DAY);
    expect((await h.runMaintenance()).expiredObjects).toBe(0);
    expect((await stat(`${C1}videos/a.mp4`)).version).toBe(1);
  });

  it("reopens after expiry, leaving expired objects deleted and making the prefix writable", async () => {
    await put(`${C1}videos/a.mp4`, "va");
    await bind(C1, TARGET);
    await setRules([closedRule("videos/", "1d")]);
    await deliverOk("closed", closedPull());
    h.advance(2 * DAY);
    expect((await h.runMaintenance()).expiredObjects).toBe(1);
    await expectError(put(`${C1}videos/new.mp4`, "nv"), "precondition_failed");

    await deliverOk("reopened", openPull());
    await expectError(stat(`${C1}videos/a.mp4`), "not_found");
    expect((await put(`${C1}videos/new.mp4`, "nv")).version).toBe(1);
    expect((await h.runMaintenance()).expiredObjects).toBe(0);
    expect((await stat(`${C1}videos/new.mp4`)).version).toBe(1);
  });

  it("answers 401 to unsigned, wrongly signed and tampered deliveries and changes nothing", async () => {
    await bind(C1, TARGET);
    const pull = closedPull(h.now().toISOString(), true);
    const unsigned = await deliverPull("closed", pull, { secret: null });
    expect(unsigned.status).toBe(401);
    expect(((await unsigned.json()) as { error: { code: string } }).error.code).toBe("unauthenticated");
    expect((await deliverPull("closed", pull, { secret: "another-secret-12345678" })).status).toBe(401);
    // Signed over a different body than the one sent.
    const body = JSON.stringify({ action: "closed" });
    const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    const tampered = await h.fetch(`${SERVER_URL}/v1/github/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signature,
      },
      body: `${body} `,
    });
    expect(tampered.status).toBe(401);

    expect((await lifecycle()).binding?.state).toBe("open");
    expect(await auditEvents("binding.merged")).toHaveLength(0);
  });

  it("is a 404 without the GitHub App", async () => {
    await h.cleanup();
    h = await createHarness();
    const response = await deliver("ping", { zen: "hi" });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("answers ping with 200", async () => {
    const response = await deliver("ping", { zen: "Keep it logically awesome." });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rejects a signed malformed payload with 400 invalid_argument", async () => {
    const response = await deliver("pull_request", { action: "closed" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_argument");
  });

  it("ignores a delivery with an older updated_at than the last applied", async () => {
    await bind(C1, TARGET);
    const t = h.now().getTime();
    await deliverOk("edited", openPull(new Date(t + HOUR).toISOString()));
    const stale = closedPull(new Date(t).toISOString(), true);
    const out = await deliverOk("closed", stale);
    expect(out.bindings).toBe(0);

    const binding = (await lifecycle()).binding;
    expect(binding).toMatchObject({ state: "open", closed_at: null, merged_at: null });
    expect(binding?.updated_at).toBe(new Date(t + HOUR).toISOString());
    expect(await auditEvents("binding.merged")).toHaveLength(0);
  });

  it("updates bindings to the same PR in two orgs with one delivery", async () => {
    const beta = await betaOrg();
    await bind(C1, TARGET);
    await bind("storage://beta/c/", TARGET, beta);

    const other = await deliverPull("closed", closedPull(h.now().toISOString(), true), { installation: 2002 });
    expect(other.status).toBe(200);
    expect(((await other.json()) as { bindings: number }).bindings).toBe(0);
    expect((await lifecycle()).binding?.state).toBe("open");
    expect((await lifecycle("storage://beta/c/", beta)).binding?.state).toBe("open");

    expect(await deliverOk("closed", closedPull(h.now().toISOString(), true))).toEqual({ ok: true, bindings: 2 });
    expect((await lifecycle()).binding?.state).toBe("merged");
    expect((await lifecycle("storage://beta/c/", beta)).binding?.state).toBe("merged");
  });

  it("returns 200 and changes nothing for other events and actions", async () => {
    await bind(C1, TARGET);
    const push = await deliver("push", {
      ref: "refs/heads/main",
      repository: { name: "web", owner: { login: "acme" } },
    });
    expect(push.status).toBe(200);
    const labeled = await deliverPull("labeled", closedPull(h.now().toISOString(), true));
    expect(labeled.status).toBe(200);
    expect(((await labeled.json()) as { bindings: number }).bindings).toBe(0);

    expect((await lifecycle()).binding?.state).toBe("open");
    expect(await auditEvents("binding.merged")).toHaveLength(0);
  });

  it("unlinks a deleted installation from every org, and the next poll reports it without calling GitHub", async () => {
    const beta = await betaOrg();
    await bind(C1, TARGET);
    await bind("storage://beta/c/", TARGET, beta);
    const callsBefore = github.calls.length;

    const response = await deliver("installation", { action: "deleted", installation: { id: 1001 } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, bindings: 0 });

    expect(await h.db.selectFrom("github_installations").selectAll().execute()).toEqual([]);
    const events = await h.db.selectFrom("audit_events").selectAll().where("action", "=", "github.uninstall").execute();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.actor === "system:github")).toBe(true);

    h.advance(16 * MINUTE);
    await h.runMaintenance();
    expect(github.calls).toHaveLength(callsBefore);
    expect((await lifecycle()).binding).toMatchObject({
      state: "open",
      poll_error: expect.stringMatching(
        /^The GitHub installation for github:acme\/web#482 was removed from (storage:\/\/)?acme\/?\.$/,
      ),
    });
    expect((await lifecycle("storage://beta/c/", beta)).binding?.poll_error).toMatch(
      /was removed from (storage:\/\/)?beta\/?\.$/,
    );
  });
});

describe("polling", () => {
  it("applies a merged PR from a poll through the installation; merged bindings are never polled again", async () => {
    await bind(C1, TARGET);
    const at = h.now().toISOString();
    github.calls.length = 0;
    github.pulls.set(KEY, closedPull(at, true));
    h.advance(16 * MINUTE); // past the poll interval; bind may or may not count as a poll

    const first = await h.runMaintenance();
    expect(first.polledBindings).toBe(1);
    expect(github.calls).toEqual([{ installationId: INSTALLATION, key: KEY }]);
    expect((await lifecycle()).binding).toMatchObject({ state: "merged", closed_at: at, merged_at: at });
    const events = await auditEvents("binding.merged");
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("system:github");
    expect(events[0]?.detail).toMatchObject({ target: TARGET, source: "poll" });

    expect((await h.runMaintenance()).polledBindings).toBe(0);
    h.advance(DAY);
    expect((await h.runMaintenance()).polledBindings).toBe(0);
    expect(github.calls).toHaveLength(1);
  });

  it("polls an open PR again only after the interval", async () => {
    await bind(C1, TARGET);
    github.calls.length = 0;
    h.advance(16 * MINUTE); // past the poll interval; bind may or may not count as a poll

    expect((await h.runMaintenance()).polledBindings).toBe(1);
    expect((await lifecycle()).binding?.state).toBe("open");
    h.advance(10 * MINUTE);
    expect((await h.runMaintenance()).polledBindings).toBe(0);
    h.advance(6 * MINUTE);
    expect((await h.runMaintenance()).polledBindings).toBe(1);
    expect(github.calls).toHaveLength(2);
  });

  it("records a 404 as poll_error without changing state, and clears it on a later success", async () => {
    await bind(C1, TARGET);
    const open = github.pulls.get(KEY);
    github.pulls.set(KEY, { status: 404 });
    h.advance(16 * MINUTE); // past the poll interval; bind may or may not count as a poll

    await h.runMaintenance();
    expect((await lifecycle()).binding).toMatchObject({
      state: "open",
      poll_error: `GitHub returned 404 for ${TARGET}.`,
    });

    if (open) github.pulls.set(KEY, open);
    h.advance(16 * MINUTE);
    await h.runMaintenance();
    expect((await lifecycle()).binding).toMatchObject({ state: "open", poll_error: null });
  });

  it("records a thrown error as a Couldn't reach GitHub poll_error", async () => {
    await bind(C1, TARGET);
    github.pulls.set(KEY, new Error("connection reset"));
    h.advance(16 * MINUTE); // past the poll interval; bind may or may not count as a poll

    await h.runMaintenance();
    expect((await lifecycle()).binding).toMatchObject({
      state: "open",
      poll_error: `Couldn't reach GitHub for ${TARGET}.`,
    });
  });

  it("polls nothing without the GitHub App", async () => {
    await h.cleanup();
    h = await createHarness();
    await runOperation(ops.create, { uri: C1 }, h.runner());
    const org = await h.db.selectFrom("orgs").select("id").where("slug", "=", "acme").executeTakeFirstOrThrow();
    const collection = await h.db
      .selectFrom("collections")
      .select("id")
      .where("org_id", "=", org.id)
      .where("slug", "=", "c1")
      .executeTakeFirstOrThrow();
    await h.db
      .insertInto("bindings")
      .values({
        id: "bnd_test",
        org_id: org.id,
        collection_id: collection.id,
        kind: "github",
        target: TARGET,
        owner: "acme",
        repo: "web",
        number: 482,
        state: "open",
        closed_at: null,
        merged_at: null,
        source_updated_at: null,
        polled_at: null,
        poll_error: null,
        installation_id: INSTALLATION,
        created_by: "user:test",
        created_at: h.now().toISOString(),
      })
      .execute();
    const result = await h.runMaintenance();
    expect(result.polledBindings).toBe(0);
    expect((await lifecycle()).binding).toMatchObject({ state: "open", poll_error: null });
  });
});

describe("org default rules", () => {
  it("stores defaults, shows them, and copies them only into newly created collections", async () => {
    const defaults = [{ prefix: "tmp/", delete_after: "7d" }, closedRule("", "30d")];
    const set = await setRules(defaults, undefined, ORG);
    expect(set).toMatchObject({
      rules: defaults,
      changed: true,
      scheduled: [],
      waiting: [],
      next: null,
      binding: null,
    });
    expect(await lifecycle(ORG)).toMatchObject({
      rules: defaults,
      scheduled: [],
      waiting: [],
      next: null,
      binding: null,
    });
    const events = await auditEvents("lifecycle.set");
    expect(events.map((e) => e.target)).toEqual([ORG]);

    const created = await runOperation(ops.create, { uri: C2 }, h.runner());
    expect(created.created).toBe(true);
    expect((await lifecycle(C2)).rules).toEqual(defaults);
    expect((await lifecycle(C1)).rules).toEqual([]);

    const changed = [{ prefix: "", keep_versions: 3 }];
    await setRules(changed, undefined, ORG);
    expect((await lifecycle(ORG)).rules).toEqual(changed);
    expect((await lifecycle(C2)).rules).toEqual(defaults);

    const again = await runOperation(ops.create, { uri: C2 }, h.runner());
    expect(again.created).toBe(false);
    expect((await lifecycle(C2)).rules).toEqual(defaults);
  });

  it("refuses collection admins, org writers and scoped tokens on org set-lifecycle", async () => {
    const collectionAdmin = await h.addUser("cathy@acme.com", "admin", { collectionSlug: "c1" });
    const writer = await h.addUser("wes@acme.com", "writer");
    const scoped = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/*", role: "admin" }] });
    const rules = [{ prefix: "", keep_versions: 2 }];
    await expectError(setRules(rules, writer, ORG), "forbidden");
    await expectError(setRules(rules, scoped, ORG), "forbidden");
    // Like grants on an org URI: without an org-level grant the org isn't revealed.
    await expectError(setRules(rules, collectionAdmin, ORG), "not_found");
    expect((await lifecycle(ORG)).rules).toEqual([]);
  });
});

describe("rule resolution with event rules", () => {
  it("expires objects at whichever of a time rule and an event rule comes first", async () => {
    await put(A, "one");
    await bind(C1, TARGET);
    await setRules([{ prefix: "", delete_after: "90d" }, closedRule("", "7d")]);
    await deliverOk("closed", closedPull());
    h.advance(8 * DAY);

    expect((await h.runMaintenance()).expiredObjects).toBe(1);
    await expectError(stat(A), "not_found");
  });

  it("keeps a longer-prefix event rule alive past a shorter time rule while the PR is open", async () => {
    await put(`${C1}keep/x`, "kx");
    await put(A, "one");
    await bind(C1, TARGET);
    await deliverOk("opened", openPull());
    await setRules([{ prefix: "", delete_after: "1d" }, closedRule("keep/", "365d")]);
    h.advance(2 * DAY);

    await h.runMaintenance();
    expect((await stat(`${C1}keep/x`)).version).toBe(1);
    await expectError(stat(A), "not_found");
  });
});
