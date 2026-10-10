import { StorageError } from "@storage/core";

export const DEVICE_CLIENT_ID = "storage-cli";

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

interface OAuthResponse {
  status: number;
  body: Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function describe(response: OAuthResponse): string {
  return str(response.body.error_description) ?? str(response.body.error) ?? `HTTP ${response.status}`;
}

/** POSTs a form to the server. A non-JSON body comes back as an empty object, so callers see only the status. */
async function postForm(
  server: string,
  path: string,
  form: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<OAuthResponse> {
  let response: Response;
  try {
    response = await fetchFn(`${server}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (error) {
    throw new StorageError(
      "unavailable",
      `Can't reach the Storage server at ${server}: ${(error as Error).message}`,
      "Check STORAGE_SERVER and that the server is running.",
    );
  }
  const text = await response.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON; leave the body empty.
  }
  return { status: response.status, body };
}

/** Starts the OAuth device flow and returns the code the user enters in the browser. */
export async function startDeviceLogin(
  server: string,
  options: { fetch?: typeof fetch } = {},
): Promise<DeviceAuthorization> {
  const base = server.replace(/\/+$/, "");
  const response = await postForm(
    base,
    "/oauth/device_authorization",
    { client_id: DEVICE_CLIENT_ID },
    options.fetch ?? fetch,
  );
  const { body } = response;
  if (response.status === 400 && body.error === "invalid_request") {
    throw new StorageError(
      "unavailable",
      str(body.error_description) ?? "Browser sign-in isn't available on this server.",
      "Pipe a Storage token to `storage login --with-token` instead.",
    );
  }
  const deviceCode = str(body.device_code);
  const userCode = str(body.user_code);
  const verificationUri = str(body.verification_uri);
  const verificationUriComplete = str(body.verification_uri_complete);
  if (
    response.status !== 200 ||
    deviceCode === undefined ||
    userCode === undefined ||
    verificationUri === undefined ||
    verificationUriComplete === undefined ||
    typeof body.expires_in !== "number" ||
    typeof body.interval !== "number"
  ) {
    throw new StorageError("internal", `Couldn't start browser sign-in: ${describe(response)}.`);
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn: body.expires_in,
    interval: body.interval,
  };
}

/** Polls the token endpoint until the user finishes (or abandons) the browser sign-in. */
export async function pollDeviceToken(
  server: string,
  auth: DeviceAuthorization,
  options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {},
): Promise<{ token: string; expiresIn: number }> {
  const base = server.replace(/\/+$/, "");
  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const deadline = now().getTime() + auth.expiresIn * 1000;
  let interval = auth.interval;
  const expired = () =>
    new StorageError(
      "unauthenticated",
      "The sign-in code expired before sign-in finished.",
      "Run `storage login` again.",
    );

  for (;;) {
    await sleep(interval * 1000);
    const response = await postForm(
      base,
      "/oauth/token",
      { grant_type: DEVICE_GRANT_TYPE, device_code: auth.deviceCode, client_id: DEVICE_CLIENT_ID },
      fetchFn,
    );
    const { body } = response;
    if (response.status === 200) {
      const token = str(body.access_token);
      if (token === undefined || typeof body.expires_in !== "number") {
        throw new StorageError("internal", "Server returned an unexpected sign-in response.");
      }
      return { token, expiresIn: body.expires_in };
    }
    const error = str(body.error);
    if (error === "expired_token") {
      throw expired();
    }
    if (error === "access_denied") {
      throw new StorageError(
        "unauthenticated",
        "Sign-in was cancelled or refused in the browser.",
        "Run `storage login` again.",
      );
    }
    if (error === "authorization_pending" || error === "slow_down") {
      if (error === "slow_down") {
        interval += 5;
      }
      if (now().getTime() >= deadline) {
        throw expired();
      }
      continue;
    }
    throw new StorageError("unauthenticated", `Sign-in failed: ${describe(response)}.`);
  }
}
