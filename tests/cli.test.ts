import { stat as fsStat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { runCli } from "@storage/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_S3_ENDPOINT } from "./backends.js";
import { captureStream, createHarness, type Harness, SERVER_URL } from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

async function cli(args: string[], env: Record<string, string | undefined> = {}, stdin?: string) {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli(args, {
    env: {
      STORAGE_SERVER: SERVER_URL,
      STORAGE_TOKEN: h.adminToken,
      STORAGE_HOME: join(h.dir, "home"),
      STORAGE_CONFIG_DIR: join(h.dir, "config"),
      ...env,
    },
    cwd: h.dir,
    stdout: stdout.stream,
    stderr: stderr.stream,
    ...(stdin === undefined ? {} : { stdin: Readable.from([Buffer.from(stdin)]) }),
    fetch: h.fetch,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** Runs the CLI with no credentials in the environment, so only saved profiles apply. */
function bare(args: string[], env: Record<string, string | undefined> = {}, stdin?: string) {
  return cli(args, { STORAGE_SERVER: undefined, STORAGE_TOKEN: undefined, ...env }, stdin);
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

  it.skipIf(TEST_S3_ENDPOINT !== undefined)("fails inline get when the stored bytes were corrupted", async () => {
    await cli(["create", "storage://acme/pr-482/"]);
    await writeFile(join(h.dir, "after.png"), "png-bytes");
    await cli(["put", "after.png", AFTER]);

    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.isFile()) {
          files.push(path);
        }
      }
    };
    await walk(join(h.dir, "blobs"));
    expect(files).toHaveLength(1);
    await writeFile(files[0] ?? "", "xxx-bytes");

    const get = await cli(["get", AFTER, "--delivery", "inline"]);
    expect(get.code).not.toBe(0);
    expect(get.stderr).toContain("sha256");
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

describe("storage login", () => {
  const configDir = () => join(h.dir, "config");

  it("checks a token from stdin, saves it to the default profile, and uses it", async () => {
    const login = await bare(["login", "--server", `${SERVER_URL}/`, "--with-token"], {}, `${h.adminToken}\n`);
    expect(login).toMatchObject({ code: 0, stderr: "" });
    const { principal } = JSON.parse((await cli(["whoami", "--json"])).stdout) as { principal: string };
    expect(login.stdout).toBe(`Logged in to ${SERVER_URL} as ${principal} (profile default).\n`);

    const configToml = await readFile(join(configDir(), "config.toml"), "utf8");
    expect(configToml).toContain('default_profile = "default"');
    expect(configToml).toContain(`server = "${SERVER_URL}"`);
    expect(configToml).not.toContain(h.adminToken);
    expect(await readFile(join(configDir(), "credentials.toml"), "utf8")).toContain(h.adminToken);
    if (process.platform !== "win32") {
      expect((await fsStat(join(configDir(), "credentials.toml"))).mode & 0o777).toBe(0o600);
    }

    const whoami = await bare(["whoami"]);
    expect(whoami.code).toBe(0);
    expect(whoami.stdout).toMatch(new RegExp(`^${principal}\\n  acme \\(admin\\)\\ntoken tok_\\w+: full access\\n$`));
    const config = await bare(["config", "--json"]);
    expect(JSON.parse(config.stdout)).toEqual({
      profile: "default",
      server: SERVER_URL,
      server_source: "profile",
      token_source: "credentials",
      config_file: join(configDir(), "config.toml"),
      credentials_file: join(configDir(), "credentials.toml"),
      home: join(h.dir, "home"),
    });
    expect(config.stdout).not.toContain(h.adminToken);
  });

  it("keeps other profiles separate until selected", async () => {
    const bobToken = await h.addUser("bob@acme.com", "reader");
    await bare(["login", "--server", SERVER_URL, "--token", h.adminToken]);
    const ci = await bare(["--profile", "ci", "login", "--server", SERVER_URL, "--token", bobToken, "--json"]);
    expect(ci.code).toBe(0);
    expect(JSON.parse(ci.stdout)).toEqual({
      profile: "ci",
      server: SERVER_URL,
      principal: "user:usr_bobacmecom",
      orgs: [{ slug: "acme", name: expect.any(String), role: "reader" }],
    });

    expect((await bare(["whoami"])).stdout).toMatch(/^user:(?!usr_bobacmecom)/);
    expect((await bare(["--profile", "ci", "whoami"])).stdout).toMatch(/^user:usr_bobacmecom\n/);
    expect((await bare(["whoami"], { STORAGE_PROFILE: "ci" })).stdout).toMatch(/^user:usr_bobacmecom\n/);
    expect((await bare(["--profile", "../x", "whoami"])).code).toBe(2);
  });

  it("never sends a saved token to a server other than the profile's", async () => {
    await bare(["login", "--server", SERVER_URL, "--with-token"], {}, h.adminToken);
    const elsewhere = await bare(["whoami"], { STORAGE_SERVER: "http://elsewhere.test" });
    expect(elsewhere.code).toBe(3);
    expect(elsewhere.stderr).toContain("error: No credentials configured.");
    const config = JSON.parse((await bare(["config", "--json"], { STORAGE_SERVER: "http://elsewhere.test" })).stdout);
    expect(config).toMatchObject({
      server: "http://elsewhere.test",
      server_source: "STORAGE_SERVER",
      token_source: "none",
    });

    expect((await bare(["whoami"], { STORAGE_SERVER: `${SERVER_URL}/` })).code).toBe(0);
  });

  it("refuses bad tokens and missing input without saving anything", async () => {
    const wrong = await bare(["login", "--server", SERVER_URL, "--with-token"], {}, "storage_pat_wrong\n");
    expect(wrong.code).toBe(3);
    await expect(fsStat(join(configDir(), "credentials.toml"))).rejects.toThrow();

    // This harness has no sign-in providers, so browser sign-in is unavailable.
    const noToken = await bare(["login", "--server", SERVER_URL]);
    expect(noToken.code).not.toBe(0);
    expect(noToken.stderr).toContain("hint: Pipe a Storage token to `storage login --with-token` instead.");

    expect((await bare(["login", "--with-token"], {}, "\n")).code).toBe(2);
    expect((await bare(["login", "--server", "ftp://x", "--token", h.adminToken])).code).toBe(2);
    expect((await bare(["login", "--with-token", "--token", h.adminToken], {}, h.adminToken)).code).toBe(2);
  });

  it("notes when the environment overrides the saved login", async () => {
    const login = await cli(["login", "--with-token"], {}, h.adminToken);
    expect(login.code).toBe(0);
    expect(login.stderr).toBe("note: STORAGE_TOKEN is set and takes precedence over the saved token.\n");
  });

  it("logs out by deleting the saved token", async () => {
    await bare(["login", "--server", SERVER_URL, "--with-token"], {}, h.adminToken);
    expect(await bare(["logout"])).toMatchObject({ code: 0, stdout: "Logged out of profile default.\n" });
    expect(await readFile(join(configDir(), "credentials.toml"), "utf8")).not.toContain(h.adminToken);
    expect((await bare(["whoami"])).code).toBe(3);
    expect(await bare(["logout", "--json"])).toMatchObject({
      code: 0,
      stdout: '{"profile":"default","removed":false}\n',
    });
  });
});

describe("storage service", () => {
  it("creates a service and a service token whose secret starts with storage_svc_", async () => {
    const service = await cli(["service", "create", "acme", "bugbot"]);
    expect(service.code).toBe(0);
    expect(service.stdout).toContain("Created service service:acme/bugbot.");

    const token = await cli(["token", "create", "--service", "acme/bugbot", "--name", "bot"]);
    expect(token.code).toBe(0);
    const lines = token.stdout.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toMatch(/^storage_svc_\S+$/);
  });
});

describe("storage token", () => {
  const SCOPE = "acme/pr-*:writer";

  it("creates a token and prints the secret on the last line", async () => {
    const created = await cli(["token", "create", "--name", "ci", "--scope", SCOPE]);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain(SCOPE);
    const lines = created.stdout.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toMatch(/^storage_pat_\S+$/);

    const json = await cli(["token", "create", "--name", "ci2", "--scope", SCOPE, "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      token: expect.stringMatching(/^storage_pat_/),
      name: "ci2",
      scopes: [{ collection: "acme/pr-*", role: "writer" }],
    });
  });

  it("rejects a malformed --scope before calling the server", async () => {
    const bad = await cli(["token", "create", "--name", "ci", "--scope", "acme/pr-*"], { STORAGE_SERVER: undefined });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("Expected <org>/<collection-glob>:<role>");
  });

  it("lists and revokes tokens; a scoped token lists only itself and its children", async () => {
    const created = JSON.parse((await cli(["token", "create", "--name", "ci", "--scope", SCOPE, "--json"])).stdout) as {
      token: string;
      id: string;
    };

    const list = await cli(["token", "list"]);
    expect(list.code).toBe(0);
    const rows = list.stdout.trimEnd().split("\n");
    expect(rows[0]).toMatch(/^ID\s+NAME\s+SCOPES/);
    expect(list.stdout).toContain("(full access)");
    expect(rows.find((r) => r.includes("(full access)"))).toMatch(/^\S+\s+\*\s/);
    const ci = rows.find((r) => r.includes(SCOPE));
    expect(ci).toContain(created.id);
    expect(ci).not.toMatch(/\*\s+ci/);

    const scopedList = await cli(["token", "list"], { STORAGE_TOKEN: created.token });
    expect(scopedList.code).toBe(0);
    expect(scopedList.stdout).toContain(created.id);
    expect(scopedList.stdout).not.toContain("(full access)");

    const revoked = await cli(["token", "revoke", created.id]);
    expect(revoked).toMatchObject({ code: 0, stdout: `Revoked token ${created.id}.\n` });
    expect((await cli(["whoami"], { STORAGE_TOKEN: created.token })).code).toBe(3);
  });
});

describe("storage mcp", () => {
  it("answers over stdio, writes only JSON-RPC to stdout, and exits when stdin ends", async () => {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    };
    const { code, stdout } = await cli(["mcp"], {}, `${JSON.stringify(initialize)}\n`);
    expect(code).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ id: 1, result: { serverInfo: { name: "storage" } } });
  });
});
