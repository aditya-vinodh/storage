import { httpStatusFor, StorageError } from "@storage/core";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { recordAuditAs } from "../audit.js";
import { hashToken, insertToken, USER_TOKEN_PREFIX } from "../auth.js";
import { newId } from "../ids.js";
import { escapeHtml, messagePage, page } from "./pages.js";
import { type IdentityProvider, type ProviderIdentity, SignInError } from "./providers.js";
import { describeRedirectTarget, isValidRedirectUri, MAX_REDIRECT_URI_LENGTH } from "./redirect-uri.js";
import {
  addSeconds,
  codeChallenge,
  INVALID_LINK,
  NOT_CONFIGURED,
  oauthError,
  oauthJson,
  resolveUser,
  type SignInEnv,
  sameHash,
  startProviderSignIn,
  token,
} from "./shared.js";

/*
 * Storage as an OAuth 2.1 authorization server for its own /mcp endpoint (MCP authorization spec, 2025-06-18):
 * RFC 9728 and RFC 8414 metadata, RFC 7591 registration of public clients, authorization code with PKCE (S256),
 * and rotating refresh tokens. Sign-in itself goes through the same providers as the device flow.
 */

const AUTHORIZATION_REQUEST_TTL_SECONDS = 600;
const CODE_TTL_SECONDS = 60;
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 86400;
const GRANT_MAX_AGE_SECONDS = 90 * 86400;
const REGISTRATION_MAX_BYTES = 16 * 1024;
const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME_LENGTH = 100;

const DEFAULT_GRANT_TYPES = ["authorization_code", "refresh_token"];
const PKCE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
};
const CORS_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/token",
];

const CONSENT_COOKIE = "storage_consent";
const CONSENT_COOKIE_ATTRS = { path: "/oauth/authorize/", httpOnly: true, sameSite: "Strict" } as const;

const INVALID_REQUEST_LINK = "This authorization link is invalid or has expired. Start again from your app.";

export interface AuthorizationCallbackInput {
  provider: IdentityProvider;
  requestId: string;
  code: string | undefined;
  providerError: string | undefined;
  codeVerifier: string;
  at: Date;
}

export interface OAuthHandlers {
  authorizationCodeGrant(c: Context, form: Record<string, string>): Promise<Response>;
  refreshTokenGrant(c: Context, form: Record<string, string>): Promise<Response>;
  authorizationCallback(c: Context, input: AuthorizationCallbackInput): Promise<Response>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(json: string): string[] {
  return JSON.parse(json) as string[];
}

/**
 * Mounts discovery, registration, the consent page and the authorization-code and refresh-token grants, and
 * returns the pieces the device-flow routes call: `/oauth/token` and the provider callback stay there.
 */
export function addOAuthRoutes(
  app: Hono,
  env: SignInEnv,
  now: () => Date,
  onError: (error: unknown) => void,
): OAuthHandlers {
  const { db, providers, publicUrl, configured } = env;
  const resourceUrl = `${publicUrl}/mcp`;

  // These endpoints never involve cookies, so a wildcard origin is safe.
  for (const path of CORS_PATHS) {
    app.use(path, async (c, next) => {
      if (c.req.method === "OPTIONS") {
        return c.body(null, 204, CORS_HEADERS);
      }
      await next();
      for (const [name, value] of Object.entries(CORS_HEADERS)) {
        c.res.headers.set(name, value);
      }
      return undefined;
    });
  }

  app.use(
    "/oauth/register",
    bodyLimit({
      maxSize: REGISTRATION_MAX_BYTES,
      onError: () => {
        const error = new StorageError("too_large", "Request body is too large.");
        return Response.json(error.toEnvelope(), { status: httpStatusFor(error.code) });
      },
    }),
  );

  const requireConfigured = () => {
    if (!configured) {
      throw new StorageError("not_found", "No such endpoint.");
    }
  };

  const protectedResource = (c: Context) => {
    requireConfigured();
    return oauthJson(c, {
      resource: resourceUrl,
      authorization_servers: [publicUrl],
      bearer_methods_supported: ["header"],
      resource_name: "Storage",
    });
  };
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  app.get("/.well-known/oauth-authorization-server", (c) => {
    requireConfigured();
    return oauthJson(c, {
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      registration_endpoint: `${publicUrl}/oauth/register`,
      device_authorization_endpoint: `${publicUrl}/oauth/device_authorization`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  app.post("/oauth/register", async (c) => {
    if (!configured) {
      return oauthError(c, "invalid_request", NOT_CONFIGURED);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return oauthError(c, "invalid_client_metadata", "The body must be a JSON object.");
    }
    if (!isRecord(body)) {
      return oauthError(c, "invalid_client_metadata", "The body must be a JSON object.");
    }

    const uris = body.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length < 1 ||
      uris.length > MAX_REDIRECT_URIS ||
      !uris.every((uri) => typeof uri === "string" && uri.length <= MAX_REDIRECT_URI_LENGTH && isValidRedirectUri(uri))
    ) {
      return oauthError(
        c,
        "invalid_redirect_uri",
        `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} https URLs, loopback http URLs or private-use scheme URIs, without fragments or credentials.`,
      );
    }
    const redirectUris = uris as string[];

    const method = body.token_endpoint_auth_method;
    if (method !== undefined && method !== "none") {
      return oauthError(c, "invalid_client_metadata", "Only public clients are supported.");
    }

    let grantTypes = DEFAULT_GRANT_TYPES;
    if (body.grant_types !== undefined) {
      const given = body.grant_types;
      if (
        !Array.isArray(given) ||
        given.length === 0 ||
        !given.every((grant) => typeof grant === "string" && DEFAULT_GRANT_TYPES.includes(grant))
      ) {
        return oauthError(
          c,
          "invalid_client_metadata",
          "grant_types must be a subset of authorization_code and refresh_token.",
        );
      }
      grantTypes = [...new Set(given as string[])];
    }

    const responseTypes = body.response_types;
    if (
      responseTypes !== undefined &&
      !(Array.isArray(responseTypes) && responseTypes.length === 1 && responseTypes[0] === "code")
    ) {
      return oauthError(c, "invalid_client_metadata", 'response_types must be ["code"].');
    }

    let clientName: string | null = null;
    if (body.client_name !== undefined) {
      const name = typeof body.client_name === "string" ? body.client_name.trim() : "";
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
      if (name.length < 1 || name.length > MAX_CLIENT_NAME_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
        return oauthError(
          c,
          "invalid_client_metadata",
          "client_name must be 1 to 100 characters without control characters.",
        );
      }
      clientName = name;
    }

    const at = now();
    const clientId = newId("mcp");
    await db
      .insertInto("oauth_clients")
      .values({
        id: clientId,
        client_name: clientName,
        redirect_uris: JSON.stringify(redirectUris),
        grant_types: JSON.stringify(grantTypes),
        created_at: at.toISOString(),
      })
      .execute();
    return oauthJson(
      c,
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(at.getTime() / 1000),
        ...(clientName === null ? {} : { client_name: clientName }),
        redirect_uris: redirectUris,
        grant_types: grantTypes,
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  const findClient = async (id: string | undefined) => {
    if (!id) {
      return undefined;
    }
    const row = await db.selectFrom("oauth_clients").selectAll().where("id", "=", id).executeTakeFirst();
    return (
      row && {
        ...row,
        redirectUris: parseStringArray(row.redirect_uris),
        grantTypes: parseStringArray(row.grant_types),
      }
    );
  };

  const isMcpResource = (resource: string) => resource === resourceUrl || resource === `${resourceUrl}/`;

  /** Redirects to the client's redirect URI with `params` added to its query. */
  const redirectToClient = (c: Context, redirectUri: string, params: Record<string, string | null | undefined>) => {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
    url.searchParams.set("iss", publicUrl);
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    return c.redirect(url.toString(), 302);
  };

  app.get("/oauth/authorize", async (c) => {
    if (!configured) {
      return messagePage(c, "Sign-in unavailable", NOT_CONFIGURED, 400);
    }
    const query = (name: string) => c.req.query(name);
    const client = await findClient(query("client_id"));
    const redirectUri = query("redirect_uri");
    if (!client || redirectUri === undefined || !client.redirectUris.includes(redirectUri)) {
      return messagePage(
        c,
        "Can't connect",
        "This app's client ID or redirect address isn't registered. Go back to the app and try again.",
        400,
      );
    }
    const state = query("state") || undefined;
    const fail = (error: string, description: string) =>
      redirectToClient(c, redirectUri, { error, error_description: description, state });

    if (query("response_type") !== "code") {
      return fail("unsupported_response_type", "Only response_type=code is supported.");
    }
    const challenge = query("code_challenge");
    if (challenge === undefined || !PKCE_PATTERN.test(challenge) || query("code_challenge_method") !== "S256") {
      return fail("invalid_request", "A PKCE code_challenge with code_challenge_method=S256 is required.");
    }
    const resource = query("resource");
    if (resource !== undefined && !isMcpResource(resource)) {
      return fail("invalid_target", `resource must be ${resourceUrl}.`);
    }
    if (!client.grantTypes.includes("authorization_code")) {
      return fail("unauthorized_client", "This client isn't registered for the authorization_code grant.");
    }

    const at = now();
    const requestId = newId("oar");
    const consentNonce = token();
    await db
      .insertInto("oauth_authorization_requests")
      .values({
        id: requestId,
        client_id: client.id,
        redirect_uri: redirectUri,
        state: state ?? null,
        code_challenge: challenge,
        resource: resource ?? null,
        status: "pending",
        user_id: null,
        code_hash: null,
        code_expires_at: null,
        approved_at: null,
        token_id: null,
        consent_hash: hashToken(consentNonce),
        created_at: at.toISOString(),
        expires_at: addSeconds(at, AUTHORIZATION_REQUEST_TTL_SECONDS).toISOString(),
      })
      .execute();

    setCookie(c, CONSENT_COOKIE, consentNonce, {
      ...CONSENT_COOKIE_ATTRS,
      maxAge: AUTHORIZATION_REQUEST_TTL_SECONDS,
      secure: env.secure,
    });

    const who =
      client.client_name === null
        ? "An unnamed app"
        : `An app calling itself &quot;${escapeHtml(client.client_name)}&quot;`;
    const links = providers
      .map(
        (provider) =>
          `<a class="button" href="${escapeHtml(`/oauth/authorize/start?request=${encodeURIComponent(requestId)}&provider=${encodeURIComponent(provider.id)}`)}">Continue with ${escapeHtml(provider.label)}</a>`,
      )
      .join("\n");
    return page(
      c,
      "Connect an app to Storage",
      `<p>${who} wants to connect to your Storage account. The app chose that name itself; Storage hasn't verified it.</p>
<p>After you sign in, you will be sent to: <strong>${escapeHtml(describeRedirectTarget(redirectUri))}</strong></p>
<p class="warning">It will be able to read, upload and delete your files and create share links as you. Only continue if you just connected Storage from an app you trust.</p>
${links}`,
    );
  });

  app.get("/oauth/authorize/start", async (c) => {
    if (!configured) {
      return messagePage(c, "Sign-in unavailable", NOT_CONFIGURED, 400);
    }
    const provider = providers.find((candidate) => candidate.id === c.req.query("provider"));
    if (!provider) {
      return messagePage(c, "Sign-in unavailable", "That sign-in provider isn't available on this server.", 400);
    }
    const requestId = c.req.query("request");
    const request = requestId
      ? await db
          .selectFrom("oauth_authorization_requests")
          .select(["id", "status", "expires_at", "consent_hash"])
          .where("id", "=", requestId)
          .executeTakeFirst()
      : undefined;
    const at = now();
    if (request?.status !== "pending" || new Date(request.expires_at).getTime() <= at.getTime()) {
      return messagePage(c, "Link not valid", INVALID_REQUEST_LINK, 400);
    }
    // Stops a link straight to /start from skipping the consent page: only the browser that was shown it has the cookie.
    const consent = getCookie(c, CONSENT_COOKIE);
    if (!consent || request.consent_hash === null || !sameHash(hashToken(consent), request.consent_hash)) {
      return messagePage(c, "Link not valid", INVALID_REQUEST_LINK, 400);
    }
    setCookie(c, CONSENT_COOKIE, "", { ...CONSENT_COOKIE_ATTRS, maxAge: 0, secure: env.secure });
    return startProviderSignIn(
      c,
      env,
      at,
      provider,
      { deviceAuthorizationId: null, authorizationRequestId: request.id },
      request.expires_at,
    );
  });

  const authorizationCallback = async (c: Context, input: AuthorizationCallbackInput): Promise<Response> => {
    const { provider, at } = input;
    const invalid = () => messagePage(c, "Sign-in link not valid", INVALID_LINK, 400);
    const request = await db
      .selectFrom("oauth_authorization_requests")
      .select(["id", "status", "expires_at", "client_id", "redirect_uri", "state"])
      .where("id", "=", input.requestId)
      .executeTakeFirst();
    if (request?.status !== "pending" || new Date(request.expires_at).getTime() <= at.getTime()) {
      return invalid();
    }
    const deny = async (description?: string) => {
      await db
        .updateTable("oauth_authorization_requests")
        .set({ status: "denied" })
        .where("id", "=", request.id)
        .where("status", "=", "pending")
        .execute();
      return redirectToClient(c, request.redirect_uri, {
        error: "access_denied",
        error_description: description,
        state: request.state,
      });
    };

    if (input.providerError !== undefined) {
      return deny();
    }
    let identity: ProviderIdentity;
    try {
      identity = await provider.exchange({
        code: input.code as string,
        redirectUri: `${publicUrl}/auth/${provider.id}/callback`,
        codeVerifier: input.codeVerifier,
      });
    } catch (error) {
      if (error instanceof SignInError) {
        return deny(error.message);
      }
      onError(error);
      return messagePage(c, "Sign-in failed", "Sign-in failed. Try again.", 502);
    }

    const userId = await resolveUser(db, identity, at);
    const code = `storage_code_${token()}`;
    const approved = await db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable("oauth_authorization_requests")
        .set({
          status: "approved",
          user_id: userId,
          code_hash: hashToken(code),
          code_expires_at: addSeconds(at, CODE_TTL_SECONDS).toISOString(),
          approved_at: at.toISOString(),
        })
        .where("id", "=", request.id)
        .where("status", "=", "pending")
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        return false;
      }
      await recordAuditAs(trx, `user:${userId}`, null, at, {
        orgId: null,
        action: "user.sign_in",
        target: `user:${userId}`,
        detail: { provider: identity.provider, email: identity.email, via: "mcp", client_id: request.client_id },
      });
      return true;
    });
    if (!approved) {
      return invalid();
    }
    return redirectToClient(c, request.redirect_uri, { code, state: request.state });
  };

  /** Revokes the access token behind a grant, which also ends every refresh token for it. */
  const revokeGrant = async (tokenId: string | null, at: Date) => {
    if (tokenId === null) {
      return;
    }
    await db
      .updateTable("tokens")
      .set({ revoked_at: at.toISOString() })
      .where("id", "=", tokenId)
      .where("revoked_at", "is", null)
      .execute();
  };

  const tokenResponse = (c: Context, accessToken: string, refreshToken: string) =>
    oauthJson(c, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
    });

  /** Inserts a refresh token for a grant and returns its secret. */
  const insertRefreshToken = async (
    trx: Pick<typeof db, "insertInto">,
    tokenId: string,
    clientId: string,
    at: Date,
    expiresAt: Date,
  ): Promise<string> => {
    const secret = `storage_rt_${token()}`;
    await trx
      .insertInto("oauth_refresh_tokens")
      .values({
        id: newId("rtk"),
        token_hash: hashToken(secret),
        token_id: tokenId,
        client_id: clientId,
        created_at: at.toISOString(),
        expires_at: expiresAt.toISOString(),
        used_at: null,
      })
      .execute();
    return secret;
  };

  const authorizationCodeGrant = async (c: Context, form: Record<string, string>): Promise<Response> => {
    const client = await findClient(form.client_id);
    if (!client) {
      return oauthError(c, "invalid_client", undefined, 401);
    }
    if (!form.code || !form.redirect_uri || !form.code_verifier) {
      return oauthError(c, "invalid_request", "code, redirect_uri and code_verifier are required.");
    }
    if (!client.grantTypes.includes("authorization_code")) {
      return oauthError(c, "unauthorized_client");
    }
    const row = await db
      .selectFrom("oauth_authorization_requests")
      .selectAll()
      .where("code_hash", "=", hashToken(form.code))
      .executeTakeFirst();
    if (!row || row.client_id !== client.id) {
      return oauthError(c, "invalid_grant");
    }
    const at = now();
    if (row.status === "consumed") {
      // A code used twice means it leaked: end the grant it produced (RFC 6749 section 4.1.2).
      await revokeGrant(row.token_id, at);
      return oauthError(c, "invalid_grant");
    }
    if (
      row.status !== "approved" ||
      row.user_id === null ||
      row.code_expires_at === null ||
      new Date(row.code_expires_at).getTime() <= at.getTime() ||
      row.redirect_uri !== form.redirect_uri ||
      !PKCE_PATTERN.test(form.code_verifier) ||
      !sameHash(hashToken(codeChallenge(form.code_verifier)), hashToken(row.code_challenge))
    ) {
      return oauthError(c, "invalid_grant");
    }
    if (form.resource !== undefined && !isMcpResource(form.resource)) {
      return oauthError(c, "invalid_target", `resource must be ${resourceUrl}.`);
    }

    const userId = row.user_id;
    const name = client.client_name === null ? "MCP client" : `MCP: ${client.client_name}`;
    const issued = await db.transaction().execute(async (trx) => {
      const claimed = await trx
        .updateTable("oauth_authorization_requests")
        .set({ status: "consumed" })
        .where("id", "=", row.id)
        .where("status", "=", "approved")
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) === 0) {
        return null;
      }
      const created = await insertToken(trx, {
        principal: `user:${userId}`,
        name,
        expiresAt: addSeconds(at, ACCESS_TOKEN_TTL_SECONDS),
        now: at,
        clientId: client.id,
      });
      const refreshToken = await insertRefreshToken(
        trx,
        created.id,
        client.id,
        at,
        addSeconds(at, REFRESH_TOKEN_TTL_SECONDS),
      );
      await trx
        .updateTable("oauth_authorization_requests")
        .set({ token_id: created.id })
        .where("id", "=", row.id)
        .execute();
      await recordAuditAs(trx, `user:${userId}`, created.id, at, {
        orgId: null,
        action: "token.create",
        target: created.id,
        detail: { name, via: "oauth", client_id: client.id },
      });
      return { accessToken: created.secret, refreshToken };
    });
    if (issued === null) {
      // Lost a race with another exchange of the same code: treat it as reuse.
      const winner = await db
        .selectFrom("oauth_authorization_requests")
        .select("token_id")
        .where("id", "=", row.id)
        .executeTakeFirst();
      await revokeGrant(winner?.token_id ?? null, at);
      return oauthError(c, "invalid_grant");
    }
    return tokenResponse(c, issued.accessToken, issued.refreshToken);
  };

  const refreshTokenGrant = async (c: Context, form: Record<string, string>): Promise<Response> => {
    const client = await findClient(form.client_id);
    if (!client) {
      return oauthError(c, "invalid_client", undefined, 401);
    }
    if (!form.refresh_token) {
      return oauthError(c, "invalid_request", "refresh_token is required.");
    }
    if (!client.grantTypes.includes("refresh_token")) {
      return oauthError(c, "unauthorized_client");
    }
    const row = await db
      .selectFrom("oauth_refresh_tokens")
      .selectAll()
      .where("token_hash", "=", hashToken(form.refresh_token))
      .executeTakeFirst();
    if (!row || row.client_id !== client.id) {
      return oauthError(c, "invalid_grant");
    }
    const at = now();
    if (row.used_at !== null) {
      // A refresh token used twice means it leaked: end the whole grant.
      await revokeGrant(row.token_id, at);
      return oauthError(c, "invalid_grant");
    }
    const grant = await db
      .selectFrom("tokens")
      .select(["id", "principal", "created_at", "revoked_at"])
      .where("id", "=", row.token_id)
      .executeTakeFirst();
    if (!grant || grant.revoked_at !== null || new Date(row.expires_at).getTime() <= at.getTime()) {
      return oauthError(c, "invalid_grant");
    }

    const accessToken = `${USER_TOKEN_PREFIX}${token()}`;
    const refreshExpiresAt = new Date(
      Math.min(
        addSeconds(at, REFRESH_TOKEN_TTL_SECONDS).getTime(),
        addSeconds(new Date(grant.created_at), GRANT_MAX_AGE_SECONDS).getTime(),
      ),
    );
    const issued = await db.transaction().execute(async (trx) => {
      const claimed = await trx
        .updateTable("oauth_refresh_tokens")
        .set({ used_at: at.toISOString() })
        .where("id", "=", row.id)
        .where("used_at", "is", null)
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) === 0) {
        return null;
      }
      // Rotate in place: the token keeps its id, and the old secret stops working at once.
      const rotated = await trx
        .updateTable("tokens")
        .set({ token_hash: hashToken(accessToken), expires_at: addSeconds(at, ACCESS_TOKEN_TTL_SECONDS).toISOString() })
        .where("id", "=", grant.id)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (Number(rotated.numUpdatedRows) === 0) {
        return null;
      }
      return insertRefreshToken(trx, grant.id, client.id, at, refreshExpiresAt);
    });
    if (issued === null) {
      await revokeGrant(row.token_id, at);
      return oauthError(c, "invalid_grant");
    }
    return tokenResponse(c, accessToken, issued);
  };

  return { authorizationCodeGrant, refreshTokenGrant, authorizationCallback };
}
