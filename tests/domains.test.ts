import { ApiClient, runOperation } from "@storage/client";
import { ops, StorageError } from "@storage/core";
import { afterEach, describe, expect, it } from "vitest";
import { fakeProvider, signInWithGoogle } from "./fake-idp.js";
import { createHarness, type Harness, type HarnessOptions, SERVER_URL } from "./harness.js";

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const C = "storage://acme/c/";
const OTHER = "storage://acme/other/";

const google = (subject: string, email: string, hd: string | null) => ({
  provider: "google" as const,
  subject,
  email,
  name: null,
  hd,
});

const accounts = {
  alice: google("g-A", "alice@acme.com", "acme.com"),
  // The same Google account (subject g-A) after its Workspace domain changed.
  "alice-other": google("g-A", "alice@acme.com", "other.com"),
  bob: google("g-B", "bob@other.com", "other.com"),
  carol: google("g-C", "carol@gmail.com", null),
  // An @acme.com email with no hd claim: must never count as a member of acme.com.
  dave: google("g-D", "dave@acme.com", null),
};

async function setup(config?: HarnessOptions["config"]): Promise<Harness> {
  h = await createHarness({
    signIn: { providers: [fakeProvider("google", accounts)] },
    ...(config ? { config } : {}),
  });
  return h;
}

function api(harness: Harness, token: string): ApiClient {
  return new ApiClient({ server: SERVER_URL, token, fetch: harness.fetch });
}

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

const whoami = (harness: Harness, token: string) => runOperation(ops.whoami, {}, harness.runner(token));
const list = (harness: Harness, token: string, uri: string) => runOperation(ops.list, { uri }, harness.runner(token));
const share = (harness: Harness, uri: string, principal: string, role: "reader" | "admin" = "reader") =>
  runOperation(ops.share, { uri, principal, role }, harness.runner());

async function createCollection(harness: Harness, uri = C): Promise<void> {
  await runOperation(ops.create, { uri }, harness.runner());
}

describe("google-domain principals", () => {
  it("gives a user with a matching hd access to a domain-shared collection and shows the group in whoami", async () => {
    const harness = await setup();
    await createCollection(harness);
    await share(harness, C, "google-domain:acme.com");

    const token = await signInWithGoogle(harness, "alice");
    expect((await list(harness, token, C)).uri).toBe(C);
    expect((await whoami(harness, token)).groups).toEqual([{ principal: "google-domain:acme.com", name: "acme.com" }]);
  });

  it("denies a different hd, a user with no hd, and an @acme.com email without an hd claim", async () => {
    const harness = await setup();
    await createCollection(harness);
    await share(harness, C, "google-domain:acme.com");

    const expectedGroups: Record<string, unknown[]> = {
      bob: [{ principal: "google-domain:other.com", name: "other.com" }],
      carol: [],
      dave: [],
    };
    for (const [code, groups] of Object.entries(expectedGroups)) {
      const token = await signInWithGoogle(harness, code);
      await expectError(list(harness, token, C), "not_found");
      expect((await whoami(harness, token)).groups).toEqual(groups);
    }
  });

  it("lowercases the domain on share and shows its name in the share result and in grants", async () => {
    const harness = await setup();
    await createCollection(harness);

    const shared = await share(harness, C, "google-domain:ACME.com");
    expect(shared.grant).toMatchObject({ principal: "google-domain:acme.com", name: "acme.com", role: "reader" });

    const rows = await harness.db
      .selectFrom("grants")
      .select("principal")
      .where("principal", "like", "google-domain:%")
      .execute();
    expect(rows).toEqual([{ principal: "google-domain:acme.com" }]);

    const grants = await runOperation(ops.grants, { uri: C }, harness.runner());
    expect(grants.grants.find((g) => g.principal === "google-domain:acme.com")).toMatchObject({ name: "acme.com" });
  });

  it("refuses to share with a consumer domain, built in or added through config", async () => {
    const harness = await setup({ consumerDomains: ["example.org"] });
    await createCollection(harness);

    await expectError(share(harness, C, "google-domain:gmail.com"), "invalid_argument");
    await expectError(share(harness, C, "google-domain:example.org"), "invalid_argument");

    const rows = await harness.db
      .selectFrom("grants")
      .select("principal")
      .where("principal", "like", "google-domain:%")
      .execute();
    expect(rows).toEqual([]);
  });

  it("refuses to share without a Google provider, but still unshares an existing domain grant", async () => {
    h = await createHarness();
    const harness = h;
    await createCollection(harness);
    await expectError(share(harness, C, "google-domain:acme.com"), "invalid_argument");

    // Insert the grant directly: it can't be created through share on this server.
    const collection = await harness.db
      .selectFrom("collections")
      .select(["id", "org_id"])
      .where("slug", "=", "c")
      .executeTakeFirstOrThrow();
    await harness.db
      .insertInto("grants")
      .values({
        id: "grt_domain_acme",
        principal: "google-domain:acme.com",
        role: "reader",
        org_id: collection.org_id,
        collection_id: collection.id,
        created_at: new Date().toISOString(),
      })
      .execute();

    const removed = await runOperation(ops.unshare, { uri: C, principal: "google-domain:acme.com" }, harness.runner());
    expect(removed.removed.principal).toBe("google-domain:acme.com");
    const grants = await runOperation(ops.grants, { uri: C }, harness.runner());
    expect(grants.grants.filter((g) => g.principal.startsWith("google-domain:"))).toEqual([]);
  });

  it("updates membership on a new sign-in with a different hd, for tokens issued before and after", async () => {
    const harness = await setup();
    await createCollection(harness);
    await createCollection(harness, OTHER);
    await share(harness, C, "google-domain:acme.com");
    await share(harness, OTHER, "google-domain:other.com");

    const before = await signInWithGoogle(harness, "alice");
    expect((await list(harness, before, C)).uri).toBe(C);
    await expectError(list(harness, before, OTHER), "not_found");

    const after = await signInWithGoogle(harness, "alice-other");
    for (const token of [before, after]) {
      await expectError(list(harness, token, C), "not_found");
      expect((await list(harness, token, OTHER)).uri).toBe(OTHER);
      expect((await whoami(harness, token)).groups).toEqual([
        { principal: "google-domain:other.com", name: "other.com" },
      ]);
    }
  });

  it("doesn't let a token scoped to another collection use a domain grant", async () => {
    const harness = await setup();
    await createCollection(harness);
    await createCollection(harness, OTHER);
    await share(harness, C, "google-domain:acme.com");
    await share(harness, OTHER, "google-domain:acme.com");

    const token = await signInWithGoogle(harness, "alice");
    const scoped = await harness.createToken(token, { scopes: [{ collection: "acme/other", role: "reader" }] });
    expect((await list(harness, scoped, OTHER)).uri).toBe(OTHER);
    await expectError(list(harness, scoped, C), "forbidden");
  });

  it("lets a user who is admin only through a domain grant create a working share link that dies with the grant", async () => {
    const harness = await setup();
    await createCollection(harness);
    await share(harness, C, "google-domain:acme.com", "admin");

    const token = await signInWithGoogle(harness, "alice");
    const link = await api(harness, token).call(ops.linkCreate, { uri: C, expires_in_days: 1 });
    expect(link.secret.startsWith("storage_link_")).toBe(true);
    expect((await list(harness, link.secret, C)).uri).toBe(C);

    await runOperation(ops.unshare, { uri: C, principal: "google-domain:acme.com" }, harness.runner());
    await expectError(list(harness, link.secret, C), "unauthenticated");
  });

  it("gives services and share links no groups in whoami", async () => {
    const harness = await setup();
    await createCollection(harness);
    await api(harness, harness.adminToken).call(ops.serviceCreate, { org: "acme", name: "bot" });
    const service = await api(harness, harness.adminToken).call(ops.tokenCreate, {
      name: "bot",
      service: "acme/bot",
    });
    const link = await api(harness, harness.adminToken).call(ops.linkCreate, { uri: C, expires_in_days: 1 });

    expect((await whoami(harness, service.token)).groups).toEqual([]);
    expect((await whoami(harness, link.secret)).groups).toEqual([]);
  });

  it("rejects malformed domains with invalid_argument", async () => {
    const harness = await setup();
    await createCollection(harness);
    for (const principal of ["google-domain:acme", "google-domain:-a.com", "google-domain:a_b.com"]) {
      await expectError(share(harness, C, principal), "invalid_argument");
    }
  });
});
