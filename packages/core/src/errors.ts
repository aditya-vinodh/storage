import { z } from "zod";

export const ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "precondition_failed",
  "too_large",
  "quota_exceeded",
  "blocked_by_policy",
  "rate_limited",
  "invalid_argument",
  "unavailable",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    hint: z.string().optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export class StorageError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.hint = hint;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint === undefined ? {} : { hint: this.hint }),
      },
    };
  }

  static fromEnvelope(envelope: ErrorEnvelope): StorageError {
    return new StorageError(envelope.error.code, envelope.error.message, envelope.error.hint);
  }
}

const HTTP_STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  too_large: 413,
  quota_exceeded: 403,
  blocked_by_policy: 403,
  rate_limited: 429,
  invalid_argument: 400,
  unavailable: 503,
  internal: 500,
};

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

/** CLI exit codes from design doc §10.4. */
export const EXIT_CODES = {
  success: 0,
  other: 1,
  usage: 2,
  auth: 3,
  network: 4,
  notFound: 5,
  conflict: 6,
  policy: 7,
} as const;

const EXIT_CODE_BY_ERROR: Record<ErrorCode, number> = {
  unauthenticated: EXIT_CODES.auth,
  forbidden: EXIT_CODES.auth,
  not_found: EXIT_CODES.notFound,
  conflict: EXIT_CODES.conflict,
  precondition_failed: EXIT_CODES.conflict,
  too_large: EXIT_CODES.policy,
  quota_exceeded: EXIT_CODES.policy,
  blocked_by_policy: EXIT_CODES.policy,
  rate_limited: EXIT_CODES.network,
  invalid_argument: EXIT_CODES.usage,
  unavailable: EXIT_CODES.network,
  internal: EXIT_CODES.other,
};

export function exitCodeFor(code: ErrorCode): number {
  return EXIT_CODE_BY_ERROR[code];
}
