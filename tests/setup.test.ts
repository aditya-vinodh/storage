import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "@storage/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveInBrowser, fakeProvider } from "./fake-idp.js";
import { captureStream, createHarness, type Harness, SERVER_URL } from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = await createHarness({
    signIn: {
      providers: [
        fakeProvider("google", { dana: { provider: "google", subject: "g-D", email: "dana@gmail.com", name: "Dana" } }),
      ],
    },
  });
});

afterEach(async () => {
  await h.cleanup();
});

/** A fake agent CLI: `installed` lists the agents present and `registered` the ones that already have the server. */
function fakeAgents(installed: string[], registered: string[] = []) {
  const calls: string[][] = [];
  const exec = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (!installed.includes(command)) {
      return { code: null, output: "" };
    }
    if (args[1] === "get") {
      return registered.includes(command) ? { code: 0, output: "storage" } : { code: 1, output: "not found" };
    }
    return { code: 0, output: "" };
  };
  return { exec, calls };
}

/** Runs `storage setup`, approving the browser sign-in as dana the first time the CLI waits. */
async function setup(args: string[], agents: ReturnType<typeof fakeAgents>) {
  const stdout = captureStream();
  const stderr = captureStream();
  let signedIn = false;
  const code = await runCli(args, {
    env: {
      STORAGE_SERVER: SERVER_URL,
      STORAGE_HOME: join(h.dir, "home"),
      STORAGE_CONFIG_DIR: join(h.dir, "config"),
      HOME: join(h.dir, "user-home"),
    },
    cwd: h.dir,
    stdout: stdout.stream,
    stderr: stderr.stream,
    fetch: h.fetch,
    exec: agents.exec,
    selfCommand: ["/usr/local/bin/storage"],
    sleep: async () => {
      if (signedIn) {
        return;
      }
      signedIn = true;
      const userCode = /the code (\S+)\.$/m.exec(stderr.text())?.[1];
      expect(userCode).toBeDefined();
      const callback = await approveInBrowser(h, userCode as string, { provider: "google", code: "dana" });
      expect(callback.status).toBe(200);
    },
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), signedIn };
}

describe("storage setup", () => {
  it("signs in and registers the MCP server with the agents it finds", async () => {
    const cursorDir = join(h.dir, "user-home", ".cursor");
    await mkdir(cursorDir, { recursive: true });
    await writeFile(join(cursorDir, "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other" } } }));
    const agents = fakeAgents(["claude"]);

    const out = await setup(["setup"], agents);

    expect(out.code).toBe(0);
    expect(out.signedIn).toBe(true);
    expect(out.stdout).toContain(`Signed in to ${SERVER_URL} as user:`);
    expect(out.stdout).toContain("Claude Code: added");
    expect(out.stdout).toContain("Codex: not found");
    expect(out.stdout).toContain("Cursor: added");
    expect(agents.calls).toContainEqual([
      "claude",
      "mcp",
      "add",
      "--scope",
      "user",
      "storage",
      "--",
      "/usr/local/bin/storage",
      "mcp",
    ]);
    const cursor = JSON.parse(await readFile(join(cursorDir, "mcp.json"), "utf8"));
    expect(cursor.mcpServers).toEqual({
      other: { command: "other" },
      storage: { command: "/usr/local/bin/storage", args: ["mcp"] },
    });
    const credentials = await readFile(join(h.dir, "config", "credentials.toml"), "utf8");
    expect(credentials).toContain("storage_");
  });

  it("reuses a working saved token and leaves agents that already have the server alone", async () => {
    await setup(["setup", "--no-agents"], fakeAgents([]));
    const agents = fakeAgents(["claude", "codex"], ["claude", "codex"]);

    const again = await setup(["setup"], agents);

    expect(again.code).toBe(0);
    expect(again.signedIn).toBe(false);
    expect(again.stdout).toContain("Claude Code: already set up");
    expect(again.stdout).toContain("Codex: already set up");
    expect(agents.calls.some((call) => call.includes("add"))).toBe(false);
  });

  it("passes a non-default profile through to the MCP command", async () => {
    const agents = fakeAgents(["codex"]);

    const out = await setup(["--profile", "work", "setup"], agents);

    expect(out.code).toBe(0);
    expect(agents.calls).toContainEqual([
      "codex",
      "mcp",
      "add",
      "storage",
      "--",
      "/usr/local/bin/storage",
      "--profile",
      "work",
      "mcp",
    ]);
  });

  it("prints the command to add by hand when no agent is installed", async () => {
    const out = await setup(["setup"], fakeAgents([]));

    expect(out.code).toBe(0);
    expect(out.stdout).toContain("No agents found.");
    expect(out.stdout).toContain("/usr/local/bin/storage mcp");
  });

  it("only signs in with --no-agents", async () => {
    const agents = fakeAgents(["claude"]);

    const out = await setup(["setup", "--no-agents"], agents);

    expect(out.code).toBe(0);
    expect(agents.calls).toEqual([]);
  });
});
