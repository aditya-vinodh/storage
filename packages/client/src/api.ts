import { errorEnvelopeSchema, type OperationSpec, StorageError } from "@storage/core";
import type { z } from "zod";

export interface ApiClientOptions {
  server: string;
  token: string | undefined;
  fetch?: typeof fetch;
}

/** Turns a non-2xx response into a StorageError, using the error envelope when the server sent one. */
export async function errorFromResponse(response: Response): Promise<StorageError> {
  const text = await response.text().catch(() => "");
  try {
    const envelope = errorEnvelopeSchema.safeParse(JSON.parse(text));
    if (envelope.success) {
      return StorageError.fromEnvelope(envelope.data);
    }
  } catch {
    // Not JSON; fall through.
  }
  const code = response.status >= 500 ? "unavailable" : "internal";
  return new StorageError(code, `Server responded ${response.status} ${response.statusText}`.trim());
}

/** Calls server-side operations at POST <server>/v1/ops/<name>. */
export class ApiClient {
  readonly server: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.server = options.server.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  async call<S extends OperationSpec>(spec: S, input: z.input<S["input"]>): Promise<z.output<S["output"]>> {
    if (this.#token === undefined) {
      throw new StorageError(
        "unauthenticated",
        "No credentials configured.",
        "Run `storage login`, or set STORAGE_TOKEN.",
      );
    }
    let response: Response;
    try {
      response = await this.#fetch(`${this.server}/v1/ops/${spec.name}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    } catch (error) {
      throw new StorageError(
        "unavailable",
        `Can't reach the Storage server at ${this.server}: ${(error as Error).message}`,
        "Check STORAGE_SERVER and that the server is running.",
      );
    }
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    const output = spec.output.safeParse(await response.json());
    if (!output.success) {
      throw new StorageError("internal", `Server returned an unexpected response for ${spec.name}.`);
    }
    return output.data as z.output<S["output"]>;
  }
}
