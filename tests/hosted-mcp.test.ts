import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { descriptionFor, inputFor, operationsFor, ops } from "@storage/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, SERVER_URL } from "./harness.js";

let h: Harness;
const clients: Client[] = [];

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await h.cleanup();
});

const COLLECTION = "storage://acme/pr-482/";
const useS3 = Boolean(process.env.STORAGE_TEST_S3_ENDPOINT);

/** Connects an MCP client to the hosted server over Streamable HTTP. */
async function connect(token = h.adminToken): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${SERVER_URL}/mcp`), {
    fetch: h.fetch,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(transport);
  clients.push(c);
  return c;
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await c.callTool({ name, arguments: args })) as unknown as ToolResult;
}

function envelope(result: ToolResult): { code: string; message: string; hint?: string } {
  expect(result.isError).toBe(true);
  return (JSON.parse(result.content[0]?.text ?? "") as { error: { code: string; message: string; hint?: string } })
    .error;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Creates the collection and puts `bytes` at `name` through the hosted tools. */
async function seed(c: Client, name: string, bytes: Buffer | string, content_type?: string): Promise<string> {
  await call(c, "create", { uri: COLLECTION });
  const uri = `${COLLECTION}${name}`;
  const result = await call(c, "put", { uri, bytes: Buffer.from(bytes).toString("base64"), content_type });
  expect(result.isError).toBeFalsy();
  return uri;
}

function textOf(result: ToolResult): string {
  return result.content.map((b) => b.text ?? "").join("\n");
}

async function rpc(method: string, init: { headers?: Record<string, string>; body?: unknown } = {}) {
  return h.fetch(`${SERVER_URL}/mcp`, {
    method,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

describe("tools/list", () => {
  it("lists the hosted operations and no internal ones", async () => {
    const c = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(operationsFor("hosted").map((o) => o.name));
    expect(names).not.toContain("push");
    expect(names).not.toContain("pull");
    for (const hidden of [
      "upload_initiate",
      "upload_commit",
      "download_url",
      "token_create",
      "token_list",
      "token_revoke",
    ]) {
      expect(names).not.toContain(hidden);
    }
  });

  it("publishes hosted schemas, descriptions and hints", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const put = tools.find((t) => t.name === "put");
    expect(put?.inputSchema.required).toEqual(expect.arrayContaining(["bytes", "uri"]));
    expect(put?.inputSchema.properties).not.toHaveProperty("file");
    expect(tools.find((t) => t.name === "get")?.inputSchema.properties).not.toHaveProperty("to");
    for (const spec of operationsFor("hosted")) {
      const tool = tools.find((t) => t.name === spec.name);
      expect(tool?.description).toBe(descriptionFor(spec, "hosted"));
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: spec.access === "read",
        destructiveHint: spec.destructive === true,
      });
      expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(
        Object.keys(inputFor(spec, "hosted").shape).sort(),
      );
    }
  });

  it("hides write tools from reader-only tokens", async () => {
    const reader = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/*", role: "reader" }] });
    const writer = await h.createToken(h.adminToken, {
      scopes: [
        { collection: "acme/*", role: "reader" },
        { collection: "acme/pr-*", role: "writer" },
      ],
    });
    const readerNames = (await (await connect(reader)).listTools()).tools.map((t) => t.name);
    for (const hidden of ["create", "put", "delete"]) {
      expect(readerNames).not.toContain(hidden);
    }
    expect(readerNames).toContain("get");
    const writerNames = (await (await connect(writer)).listTools()).tools.map((t) => t.name);
    for (const shown of ["create", "put", "delete"]) {
      expect(writerNames).toContain(shown);
    }
  });
});

describe("allowed_tools", () => {
  it("lists only the allowed tools and rejects calls to others", async () => {
    await call(await connect(), "create", { uri: COLLECTION });
    const created = await h.runner().api.call(ops.tokenCreate, {
      name: "ro",
      scopes: [{ collection: "acme/*", role: "writer" }],
      allowed_tools: ["get", "list"],
    });
    const c = await connect(created.token);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect([...names].sort()).toEqual(["get", "list", "whoami"]);

    expect((await call(c, "list", { uri: COLLECTION })).isError).toBeFalsy();
    const put = await call(c, "put", { uri: `${COLLECTION}x.txt`, bytes: Buffer.from("x").toString("base64") });
    expect(envelope(put).code).toBe("forbidden");
    expect(envelope(put).message).toContain("This token can't call");
  });
});

describe("auth", () => {
  it("returns 401 with a Bearer challenge when no token is sent", async () => {
    const res = await rpc("POST", { body: INITIALIZE });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("returns 401 for an invalid token", async () => {
    const res = await rpc("POST", { body: INITIALIZE, headers: { authorization: "Bearer not-a-token" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("returns 401 for a revoked token", async () => {
    const api = h.runner().api;
    const created = await api.call(ops.tokenCreate, {
      name: "temp",
      scopes: [{ collection: "acme/*", role: "reader" }],
    });
    await api.call(ops.tokenRevoke, { id: created.id });
    const res = await rpc("POST", { body: INITIALIZE, headers: { authorization: `Bearer ${created.token}` } });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("answers GET and DELETE with 405", async () => {
    const headers = { authorization: `Bearer ${h.adminToken}` };
    expect((await rpc("GET", { headers })).status).toBe(405);
    expect((await rpc("DELETE", { headers })).status).toBe(405);
  });

  it("rejects JSON-RPC batches, so one small request can't fan out into many inline reads", async () => {
    const c = await connect();
    const uri = await seed(c, "notes.txt", "hello", "text/plain");
    const get = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "get", arguments: { uri, delivery: "inline" } },
    });
    const response = await rpc("POST", {
      headers: { authorization: `Bearer ${h.adminToken}`, "mcp-protocol-version": "2025-03-26" },
      body: [get(1), get(2)],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32600 }, id: null });
  });

  it("rejects a body that isn't JSON with a parse error", async () => {
    const response = await h.fetch(`${SERVER_URL}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${h.adminToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32700 } });
  });
});

describe("put", () => {
  it("uploads base64 bytes and guesses the content type", async () => {
    const c = await connect();
    await call(c, "create", { uri: COLLECTION });
    const uri = `${COLLECTION}notes/hello.txt`;
    const bytes = Buffer.from("hello\n");
    const result = await call(c, "put", { uri, bytes: bytes.toString("base64") });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      version: 1,
      size: 6,
      sha256: sha256(bytes),
      deduplicated: false,
    });
    expect(result.structuredContent?.content_type).toMatch(/^text\/plain/);
    const stat = await call(c, "stat", { uri });
    expect(stat.structuredContent).toMatchObject({ version: 1, size: 6, sha256: sha256(bytes) });
  });

  it("reports deduplicated for identical bytes at another path", async () => {
    const c = await connect();
    await seed(c, "a.txt", "same bytes");
    const result = await call(c, "put", {
      uri: `${COLLECTION}b.txt`,
      bytes: Buffer.from("same bytes").toString("base64"),
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.deduplicated).toBe(true);
  });

  it("enforces if_match and honours idempotency_key", async () => {
    const c = await connect();
    const uri = await seed(c, "v.txt", "one");
    const two = await call(c, "put", { uri, bytes: Buffer.from("two").toString("base64") });
    expect(two.structuredContent?.version).toBe(2);
    const stale = await call(c, "put", { uri, bytes: Buffer.from("three").toString("base64"), if_match: "1" });
    expect(envelope(stale).code).toBe("precondition_failed");

    const args = { uri, bytes: Buffer.from("four").toString("base64"), idempotency_key: "key-1" };
    const first = await call(c, "put", args);
    const second = await call(c, "put", args);
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(second.structuredContent?.version).toBe(first.structuredContent?.version);
  });

  it("rejects bytes over the upload limit with too_large", async () => {
    const c = await connect();
    await call(c, "create", { uri: COLLECTION });
    const result = await call(c, "put", {
      uri: `${COLLECTION}big.bin`,
      bytes: Buffer.alloc(4097, 1).toString("base64"),
    });
    const error = envelope(result);
    expect(error.code).toBe("too_large");
    expect(error.message).toContain("4096");
    expect(error.hint).toMatch(/storage/i);
    expect(error.hint).toContain("CLI");
  });

  it("accepts bytes exactly at the upload limit", async () => {
    const c = await connect();
    await call(c, "create", { uri: COLLECTION });
    const result = await call(c, "put", {
      uri: `${COLLECTION}edge.bin`,
      bytes: Buffer.alloc(4096, 1).toString("base64"),
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.size).toBe(4096);
  });

  it("requires bytes and does not accept a local file", async () => {
    const c = await connect();
    await call(c, "create", { uri: COLLECTION });
    const uri = `${COLLECTION}passwd`;
    const result = await call(c, "put", { uri, file: "/etc/passwd" });
    expect(envelope(result).code).toBe("invalid_argument");
    expect((await call(c, "stat", { uri })).isError).toBe(true);
    const listed = await call(c, "list", { uri: COLLECTION });
    expect(listed.structuredContent?.objects).toEqual([]);
  });

  it("accepts a put above the MCP SDK's 4 MiB default body limit when the config allows it", async () => {
    const big = await createHarness({ config: { maxFileSize: 8 * 1024 * 1024, mcpMaxUploadBytes: 6 * 1024 * 1024 } });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`${SERVER_URL}/mcp`), {
        fetch: big.fetch,
        requestInit: { headers: { authorization: `Bearer ${big.adminToken}` } },
      });
      const c = new Client({ name: "test", version: "0" });
      await c.connect(transport);
      try {
        await call(c, "create", { uri: COLLECTION });
        const bytes = Buffer.alloc(5 * 1024 * 1024, 7);
        const result = await call(c, "put", { uri: `${COLLECTION}big.bin`, bytes: bytes.toString("base64") });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ size: bytes.length, sha256: sha256(bytes) });
      } finally {
        await c.close();
      }
    } finally {
      await big.cleanup();
    }
  });

  it("rejects invalid base64", async () => {
    const c = await connect();
    await call(c, "create", { uri: COLLECTION });
    const result = await call(c, "put", { uri: `${COLLECTION}x.txt`, bytes: "not base64!!" });
    expect(envelope(result).code).toBe("invalid_argument");
  });

  it("forbids a reader-scoped token from calling put", async () => {
    await call(await connect(), "create", { uri: COLLECTION });
    const reader = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/*", role: "reader" }] });
    const c = await connect(reader);
    const result = await call(c, "put", { uri: `${COLLECTION}x.txt`, bytes: Buffer.from("x").toString("base64") });
    expect(envelope(result).code).toBe("forbidden");
  });
});

describe("get", () => {
  it("returns a signed url and fetch commands by default", async () => {
    const c = await connect();
    const uri = await seed(c, "hello.txt", "hello\n", "text/plain");
    const before = Date.now();
    const result = await call(c, "get", { uri });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as Record<string, unknown> & { fetch: { command: string; curl: string } };
    expect(out.delivery).toBe("ref");
    expect(out).not.toHaveProperty("path");
    const url = out.url as string;
    if (useS3) {
      expect(() => new URL(url)).not.toThrow();
    } else {
      expect(url.startsWith(`${SERVER_URL}/v1/blobs/`)).toBe(true);
    }
    const expires = Date.parse(out.url_expires_at as string);
    expect(Math.abs(expires - (before + 300_000))).toBeLessThan(60_000);
    expect(out.fetch.command).toBe(`storage get ${uri} --to .`);
    expect(out.fetch.curl).toBe(`curl -fsSL -o 'hello.txt' '${url}'`);
    const res = await h.fetch(url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString("utf8")).toBe("hello\n");
  });

  it("quotes single quotes in the curl filename", async () => {
    const c = await connect();
    const uri = await seed(c, "it's.txt", "quoted", "text/plain");
    const result = await call(c, "get", { uri });
    expect(result.isError).toBeFalsy();
    const fetchInfo = result.structuredContent?.fetch as { curl: string };
    expect(fetchInfo.curl).toContain(`-o 'it'\\''s.txt'`);
  });

  it("honours a version selector and keeps it in fetch.command", async () => {
    const c = await connect();
    const uri = await seed(c, "v.txt", "first", "text/plain");
    await call(c, "put", { uri, bytes: Buffer.from("second").toString("base64"), content_type: "text/plain" });
    const result = await call(c, "get", { uri: `${uri}@1` });
    expect(result.structuredContent?.version).toBe(1);
    expect(result.structuredContent?.size).toBe(5);
    const fetchInfo = result.structuredContent?.fetch as { command: string } | undefined;
    expect(fetchInfo?.command).toContain(`${uri}@1`);
  });

  it("returns text inline wrapped in an untrusted-content tag", async () => {
    const c = await connect();
    const uri = await seed(c, "notes.txt", "hello agent", "text/plain");
    const result = await call(c, "get", { uri, delivery: "inline" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.delivery).toBe("inline");
    expect(result.structuredContent).not.toHaveProperty("url");
    expect(result.structuredContent).not.toHaveProperty("path");
    const text = textOf(result);
    expect(text).toContain("hello agent");
    const nonce = text.match(/<untrusted-content-([0-9a-f]+)>/)?.[1];
    expect(nonce).toBeDefined();
    expect(text.indexOf(`</untrusted-content-${nonce}>`)).toBeGreaterThan(text.indexOf("hello agent"));
  });

  it("returns images inline as image blocks", async () => {
    const c = await connect();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
    const uri = await seed(c, "pixel.png", bytes, "image/png");
    const result = await call(c, "get", { uri, delivery: "inline" });
    expect(result.structuredContent?.delivery).toBe("inline");
    expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", data: bytes.toString("base64") });
  });

  it("falls back to ref when inline content is over the limit", async () => {
    const c = await connect();
    const uri = await seed(c, "big.txt", "x".repeat(2000), "text/plain");
    const result = await call(c, "get", { uri, delivery: "inline" });
    expect(result.structuredContent?.delivery).toBe("ref");
    expect(result.structuredContent?.url).toEqual(expect.any(String));
    expect(result.structuredContent?.note).toContain("1024");
  });

  it("falls back to ref for binary content types", async () => {
    const c = await connect();
    const uri = await seed(c, "blob.bin", Buffer.from([1, 2, 3]), "application/octet-stream");
    const result = await call(c, "get", { uri, delivery: "inline" });
    expect(result.structuredContent?.delivery).toBe("ref");
    expect(result.structuredContent?.url).toEqual(expect.any(String));
    expect(result.structuredContent?.note).toEqual(expect.any(String));
  });

  it("falls back to ref when declared text isn't valid UTF-8", async () => {
    const c = await connect();
    const uri = await seed(c, "bad.txt", Buffer.from([0xff, 0xfe, 0x00]), "text/plain");
    const result = await call(c, "get", { uri, delivery: "inline" });
    expect(result.structuredContent?.delivery).toBe("ref");
    expect(result.structuredContent?.url).toEqual(expect.any(String));
    expect(result.structuredContent?.note).toEqual(expect.any(String));
  });

  it("uses the token's default_delivery when none is given", async () => {
    const seeder = await connect();
    const uri = await seed(seeder, "notes.txt", "hello agent", "text/plain");
    const token = await h.createToken(h.adminToken, {
      scopes: [{ collection: "acme/*", role: "reader" }],
      default_delivery: "inline",
    });
    const result = await call(await connect(token), "get", { uri });
    expect(result.structuredContent?.delivery).toBe("inline");
  });

  it("rejects a prefix uri with invalid_argument", async () => {
    const c = await connect();
    await seed(c, "notes/a.txt", "a", "text/plain");
    const result = await call(c, "get", { uri: `${COLLECTION}notes/` });
    expect(envelope(result).code).toBe("invalid_argument");
  });

  it("returns not_found for an unknown object", async () => {
    const c = await connect();
    await call(c, "create", { uri: COLLECTION });
    const result = await call(c, "get", { uri: `${COLLECTION}missing.txt` });
    expect(envelope(result).code).toBe("not_found");
  });

  it("forbids a token scoped to another collection", async () => {
    // tests/tokens.test.ts: a scope that doesn't cover an existing collection is `forbidden`.
    const c = await connect();
    const uri = await seed(c, "a.txt", "a", "text/plain");
    const token = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/other", role: "reader" }] });
    const result = await call(await connect(token), "get", { uri });
    expect(envelope(result).code).toBe("forbidden");
  });
});

describe("other tools", () => {
  it("matches the API for whoami, collections, list, history and delete", async () => {
    const c = await connect();
    const uri = await seed(c, "a.txt", "one", "text/plain");
    await call(c, "put", { uri, bytes: Buffer.from("two").toString("base64"), content_type: "text/plain" });
    const api = h.runner().api;

    const whoami = await call(c, "whoami", {});
    expect(whoami.structuredContent).toEqual(await api.call(ops.whoami, {}));

    const collections = await call(c, "collections", {});
    expect(collections.structuredContent).toEqual(await api.call(ops.collections, { limit: 50 }));

    const list = await call(c, "list", { uri: COLLECTION });
    expect(list.structuredContent).toEqual(await api.call(ops.list, { uri: COLLECTION }));

    const history = await call(c, "history", { uri });
    expect(history.structuredContent).toEqual(await api.call(ops.history, { uri }));
    expect(history.structuredContent?.current_version).toBe(2);

    const deleted = await call(c, "delete", { uri });
    expect(deleted.isError).toBeFalsy();
    expect(deleted.structuredContent).toEqual({ deleted: [{ uri, path: "a.txt" }] });
    const after = await call(c, "get", { uri });
    expect(envelope(after).code).toBe("not_found");
  });

  it("does not offer push", async () => {
    const c = await connect();
    const outcome = await c.callTool({ name: "push", arguments: { dir: "/tmp", uri: COLLECTION } }).then(
      (r) => r as ToolResult,
      () => "rejected" as const,
    );
    if (outcome !== "rejected") {
      expect(outcome.isError).toBe(true);
    }
  });
});
