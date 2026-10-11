import { createMigrator } from "@storage/server";
import { afterEach, describe, expect, it } from "vitest";
import { openTestDatabase, type TestDatabase } from "./backends.js";

let database: TestDatabase | undefined;

afterEach(async () => {
  await database?.cleanup();
  database = undefined;
});

const AT = "2026-01-01T00:00:00.000Z";

describe("0008_google_only_sign_in", () => {
  it("revokes GitHub users' sign-in tokens and descendants, and removes GitHub identities and states", async () => {
    database = await openTestDatabase({ migrate: false });
    const db = database.db;
    const migrator = await createMigrator(db);
    const first = await migrator.migrateTo("0007_mcp_oauth");
    expect(first.error).toBeUndefined();

    // The typed Db doesn't describe the pre-0008 schema's fixtures, so go through a loose handle.
    // biome-ignore lint/suspicious/noExplicitAny: pre-0008 fixtures
    const raw = db as unknown as { insertInto(t: string): any; selectFrom(t: string): any };
    const token = (id: string, parent: string | null) =>
      raw
        .insertInto("tokens")
        .values({
          id,
          token_hash: `hash_${id}`,
          principal: "user:usr_g1",
          created_at: AT,
          parent_id: parent,
        })
        .execute();
    const user = (id: string, email: string) =>
      raw.insertInto("users").values({ id, email, name: null, created_at: AT }).execute();
    const identity = (id: string, userId: string, provider: string, subject: string) =>
      raw
        .insertInto("identities")
        .values({ id, user_id: userId, provider, subject, email: "x@example.com", created_at: AT, last_sign_in_at: AT })
        .execute();
    const device = (id: string, userId: string, tokenId: string) =>
      raw
        .insertInto("device_authorizations")
        .values({
          id,
          device_code_hash: `dch_${id}`,
          user_code: `UC-${id}`,
          client_id: "storage-cli",
          status: "approved",
          user_id: userId,
          interval_seconds: 5,
          created_at: AT,
          expires_at: AT,
          approved_at: AT,
          token_id: tokenId,
        })
        .execute();

    await user("usr_g1", "g1@example.com");
    await user("usr_g2", "g2@example.com");
    await identity("idn_g1_gh", "usr_g1", "github", "gh-1");
    await identity("idn_g1_go", "usr_g1", "google", "go-1");
    await identity("idn_g2_go", "usr_g2", "google", "go-2");
    for (const [id, parent] of [
      ["tok_t1", null],
      ["tok_t2", null],
      ["tok_c", "tok_t1"],
      ["tok_d", "tok_c"],
      ["tok_u", null],
    ] as const) {
      await token(id, parent);
    }
    await device("dev_g1", "usr_g1", "tok_t1");
    await device("dev_g2", "usr_g2", "tok_u");
    await raw
      .insertInto("oauth_clients")
      .values({
        id: "mcp_c1",
        client_name: "Cursor",
        redirect_uris: '["https://client.example/cb"]',
        grant_types: '["authorization_code"]',
        created_at: AT,
      })
      .execute();
    await raw
      .insertInto("oauth_authorization_requests")
      .values({
        id: "oar_1",
        client_id: "mcp_c1",
        redirect_uri: "https://client.example/cb",
        code_challenge: "chal",
        status: "approved",
        user_id: "usr_g1",
        approved_at: AT,
        token_id: "tok_t2",
        created_at: AT,
        expires_at: AT,
      })
      .execute();
    await raw
      .insertInto("sign_in_states")
      .values({
        id: "sis_gh",
        state_hash: "sh_gh",
        browser_hash: "bh",
        provider: "github",
        code_verifier: "v",
        device_authorization_id: "dev_g2",
        created_at: AT,
        expires_at: AT,
      })
      .execute();

    const second = await migrator.migrateToLatest();
    expect(second.error).toBeUndefined();
    expect(second.results?.every((r) => r.status === "Success")).toBe(true);

    const revoked = async (id: string) =>
      (await raw.selectFrom("tokens").select("revoked_at").where("id", "=", id).executeTakeFirstOrThrow()).revoked_at;
    for (const id of ["tok_t1", "tok_t2", "tok_c", "tok_d"]) {
      expect(await revoked(id), id).not.toBeNull();
    }
    expect(await revoked("tok_u")).toBeNull();

    const identities = await raw.selectFrom("identities").select(["user_id", "provider", "subject"]).execute();
    expect(identities).toHaveLength(2);
    expect(identities).toContainEqual({ user_id: "usr_g1", provider: "google", subject: "go-1" });
    expect(identities).toContainEqual({ user_id: "usr_g2", provider: "google", subject: "go-2" });

    const states = await raw.selectFrom("sign_in_states").select("provider").execute();
    expect(states.filter((r: { provider: string }) => r.provider === "github")).toEqual([]);
  });
});
