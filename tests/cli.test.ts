import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "@storage/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureStream, createHarness, type Harness, SERVER_URL } from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

async function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli(args, {
    env: { STORAGE_SERVER: SERVER_URL, STORAGE_TOKEN: h.adminToken, STORAGE_HOME: join(h.dir, "home"), ...env },
    cwd: h.dir,
    stdout: stdout.stream,
    stderr: stderr.stream,
    fetch: h.fetch,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const AFTER = "storage://acme/pr-482/screenshots/after.png";

describe("storage CLI", () => {
  it("generates one command per public operation and hides internal ones", async () => {
    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    for (const name of [
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
    ]) {
      expect(help.stdout).toMatch(new RegExp(`^\\s+${name}\\b`, "m"));
    }
    expect(help.stdout).not.toMatch(/upload_initiate|upload_commit|download_url/);

    const putHelp = await cli(["put", "--help"]);
    expect(putHelp.stdout).toContain("--content-type <value>");
    expect(putHelp.stdout).toContain("--meta <key=value>");
    expect(putHelp.stdout).toContain("--if-match <value>");
  });

  it("runs the create, put, list, get, stat, history, delete loop", async () => {
    expect(await cli(["create", "storage://acme/pr-482/", "--title", "PR 482"])).toMatchObject({
      code: 0,
      stdout: "Created storage://acme/pr-482/\n",
    });

    await writeFile(join(h.dir, "after.png"), "png-bytes");
    const put = await cli(["put", "after.png", AFTER, "--meta", "route=/settings", "--meta", "state=after", "--json"]);
    expect(put.code).toBe(0);
    expect(JSON.parse(put.stdout)).toMatchObject({
      uri: AFTER,
      version: 1,
      content_type: "image/png",
      meta: { route: "/settings", state: "after" },
      deduplicated: false,
    });

    const list = await cli(["list", "storage://acme/pr-482/"]);
    expect(list.stdout).toMatch(/^screenshots\/\s+1 object\s+9 B/m);

    const get = await cli(["get", AFTER]);
    expect(get.code).toBe(0);
    const path = get.stdout.trim();
    expect(path).toBe(join(h.dir, "home", "cache", "acme", "pr-482", "screenshots", "after.png"));
    expect(await readFile(path, "utf8")).toBe("png-bytes");

    expect((await cli(["get", AFTER, "--delivery", "inline"])).stdout).toBe("png-bytes");

    const stat = await cli(["stat", AFTER]);
    expect(stat.stdout).toContain(`${AFTER}@1 (current)`);
    expect(stat.stdout).toMatch(/meta\.route\s+\/settings/);

    expect((await cli(["history", AFTER])).stdout).toMatch(/^v1\*\s+9 B/);

    const del = await cli(["delete", "storage://acme/pr-482/screenshots/", "--recursive"]);
    expect(del.stdout).toBe(`Deleted 1 object:\n  ${AFTER}\n`);
  });

  it("pushes and pulls directories", async () => {
    await cli(["create", "storage://acme/pr-482/"]);
    await mkdir(join(h.dir, "artifacts", "mobile"), { recursive: true });
    await writeFile(join(h.dir, "artifacts", "a.png"), "a");
    await writeFile(join(h.dir, "artifacts", "mobile", "b.png"), "bb");

    const plan = await cli(["push", "artifacts", "storage://acme/pr-482/shots/", "--dry-run"]);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toMatch(/^Dry run, nothing changed\. storage:\/\/acme\/pr-482\/shots\/: 2 would upload/);
    expect((await cli(["list", "storage://acme/pr-482/", "--json"])).stdout).toContain('"objects":[]');

    const push = await cli(["push", "artifacts", "storage://acme/pr-482/shots/"]);
    expect(push.stdout).toMatch(/: 2 uploaded, 0 unchanged, 0 deleted\n/);
    expect(push.stdout).toMatch(/^\s+uploaded\s+shots\/mobile\/b\.png\s+v1, 2 B$/m);

    await writeFile(join(h.dir, "artifacts", "a.png"), "a2");
    const repush = await cli(["push", "artifacts", "storage://acme/pr-482/shots/", "--glob", "*.png", "--json"]);
    expect(JSON.parse(repush.stdout)).toMatchObject({ unchanged: 0, uploaded: [{ path: "shots/a.png", version: 2 }] });

    const pull = await cli(["pull", "storage://acme/pr-482/shots/", "--to", "out"]);
    expect(pull.code).toBe(0);
    expect(pull.stdout).toBe(
      `Pulled 2 files from storage://acme/pr-482/shots/ into ${join(h.dir, "out")} (2 downloaded, 0 already present)\n` +
        `${join(h.dir, "out", "a.png")}\n${join(h.dir, "out", "mobile", "b.png")}\n`,
    );
    expect(await readFile(join(h.dir, "out", "a.png"), "utf8")).toBe("a2");

    const wrongKind = await cli(["get", "storage://acme/pr-482/shots/"]);
    expect(wrongKind.code).toBe(2);
    expect(wrongKind.stderr).toContain("hint: Download everything under it with: storage pull");
  });

  it("maps errors to exit codes and the JSON error envelope", async () => {
    const missing = await cli(["stat", "storage://acme/nope/x.png", "--json"]);
    expect(missing.code).toBe(5);
    expect(JSON.parse(missing.stderr)).toEqual({
      error: {
        code: "not_found",
        message: "Collection storage://acme/nope/ not found.",
        hint: "Create it with: storage create storage://acme/nope/",
      },
    });

    const human = await cli(["stat", "storage://acme/nope/x.png"]);
    expect(human.stderr).toBe(
      "error: Collection storage://acme/nope/ not found.\nhint: Create it with: storage create storage://acme/nope/\n",
    );

    expect((await cli(["put"])).code).toBe(2);
    expect((await cli(["get", "not-a-uri"])).code).toBe(2);
    expect((await cli(["get", AFTER, "--delivery", "carrier-pigeon"])).code).toBe(2);
    expect((await cli(["whoami"], { STORAGE_TOKEN: undefined })).code).toBe(3);
    expect((await cli(["whoami"], { STORAGE_TOKEN: "storage_pat_wrong" })).code).toBe(3);
  });
});
