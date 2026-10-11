import { runOperation } from "@storage/client";
import { ops, StorageError } from "@storage/core";
import { bootstrapAdmin } from "@storage/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

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

const setDefault = (input: { org?: string; clear?: boolean }, token?: string) =>
  h.runner(token).api.call(ops.setDefaultOrg, input);
const whoami = (token?: string) => h.runner(token).api.call(ops.whoami, {});

describe("set-default-org", () => {
  it("sets, reports in whoami, and clears the default org", async () => {
    expect((await whoami()).default_org).toBeNull();

    expect(await setDefault({ org: "acme" })).toEqual({ default_org: "acme" });
    expect((await whoami()).default_org).toBe("acme");
    expect((await runOperation(ops.whoami, {}, h.runner())).default_org).toBe("acme");

    expect(await setDefault({ clear: true })).toEqual({ default_org: null });
    expect((await whoami()).default_org).toBeNull();
  });

  it("is per user", async () => {
    const other = await h.addUser("olga@acme.com", "reader");
    await setDefault({ org: "acme" });
    expect((await whoami(other)).default_org).toBeNull();
  });

  it("is not_found for an org the user has no org-level grant in, or that doesn't exist", async () => {
    await bootstrapAdmin(h.db, { org: "beta", email: "admin@beta.com" });
    await expectError(setDefault({ org: "beta" }), "not_found");
    await expectError(setDefault({ org: "nope" }), "not_found");
    expect((await whoami()).default_org).toBeNull();
  });

  it("is not_found for an org where the user only has a collection grant", async () => {
    await runOperation(ops.create, { uri: "storage://acme/docs/" }, h.runner());
    const scoped = await h.addUser("carl@acme.com", "reader", { collectionSlug: "docs" });
    await expectError(setDefault({ org: "acme" }, scoped), "not_found");
  });

  it("is forbidden for a scoped token, a child token, a service token and a share link", async () => {
    const scoped = await h.createToken(h.adminToken, { scopes: [{ collection: "acme/*", role: "writer" }] });
    await expectError(setDefault({ org: "acme" }, scoped), "forbidden");

    const child = await h.createToken(scoped, { scopes: [{ collection: "acme/*", role: "reader" }] });
    await expectError(setDefault({ org: "acme" }, child), "forbidden");

    await h.runner().api.call(ops.serviceCreate, { org: "acme", name: "bugbot" });
    const { token: service } = await h.runner().api.call(ops.tokenCreate, { name: "bot", service: "acme/bugbot" });
    await expectError(setDefault({ org: "acme" }, service), "forbidden");
    expect((await whoami(service)).default_org).toBeNull();

    await runOperation(ops.create, { uri: "storage://acme/docs/" }, h.runner());
    const { secret } = await h.runner().api.call(ops.linkCreate, { uri: "storage://acme/docs/", expires_in_days: 7 });
    await expectError(setDefault({ org: "acme" }, secret), "forbidden");
    expect((await whoami(secret)).default_org).toBeNull();

    expect((await whoami()).default_org).toBeNull();
  });

  it("is invalid_argument with both org and clear, or with neither", async () => {
    await expectError(setDefault({ org: "acme", clear: true }), "invalid_argument");
    await expectError(setDefault({}), "invalid_argument");
    await expectError(setDefault({ clear: false }), "invalid_argument");
  });
});
