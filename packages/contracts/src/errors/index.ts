// Error contract (BACKEND_PLAN §8.1): every error is RFC 9457 `application/problem+json` with a `code`.
// Services throw `AppError(code, status, detail)`; apps/api maps it to a Problem body.
import { z } from "zod";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/**
 * Stable machine-readable codes. BACKEND_PLAN §8.1 lists validation_failed, not_found, forbidden, conflict,
 * entitlement_required, mfa_required and rate_limited; the rest cover HTTP cases the platform answers itself
 * (Q-030). Add codes here only; never rename one, clients switch on them.
 */
export const ERROR_CODES = [
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "entitlement_required",
  "mfa_required",
  "rate_limited",
  "idempotency_key_reused",
  "precondition_required",
  "payload_too_large",
  "unsupported_media_type",
  "bad_request",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** Default HTTP status per code. `AppError` may override it. */
export const DEFAULT_STATUS: Readonly<Record<ErrorCode, number>> = {
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  entitlement_required: 403,
  mfa_required: 403,
  rate_limited: 429,
  idempotency_key_reused: 422,
  precondition_required: 428,
  payload_too_large: 413,
  unsupported_media_type: 415,
  bad_request: 400,
  internal_error: 500,
};

/** Short, static, human-readable summary per code (RFC 9457 `title`). Never contains user data. */
export const TITLES: Readonly<Record<ErrorCode, string>> = {
  validation_failed: "Validation failed",
  unauthorized: "Authentication required",
  forbidden: "Forbidden",
  not_found: "Not found",
  conflict: "Conflict",
  entitlement_required: "Upgrade required",
  mfa_required: "Multi-factor authentication required",
  rate_limited: "Too many requests",
  idempotency_key_reused: "Idempotency key reused",
  precondition_required: "Precondition required",
  payload_too_large: "Payload too large",
  unsupported_media_type: "Unsupported media type",
  bad_request: "Bad request",
  internal_error: "Internal error",
};

/** RFC 9457 `type`: a relative URI reference per code (the product domain is not decided yet, Q-030). */
export function problemType(code: ErrorCode): string {
  return `/problems/${code}`;
}

export const ProblemFieldSchema = z
  .object({
    in: z.enum(["body", "querystring", "params", "headers"]).describe("Where the invalid value was sent"),
    path: z.string().describe("Dot path inside that part, e.g. `schedule.dayOfMonth`; empty for the root"),
    message: z.string(),
  })
  .meta({ id: "ProblemField" });

export type ProblemField = z.infer<typeof ProblemFieldSchema>;

export const ProblemSchema = z
  .object({
    type: z.string().describe("URI reference identifying the problem type"),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string().optional(),
    instance: z.string().optional().describe("Request path, without the query string"),
    code: ErrorCodeSchema,
    requestId: z.string().optional(),
    fields: z.array(ProblemFieldSchema).optional().describe("Per-field errors for validation_failed"),
    current: z.unknown().optional().describe("The current resource, on a version conflict (If-Match)"),
  })
  .meta({ id: "Problem", description: "RFC 9457 problem details" });

export type Problem = z.infer<typeof ProblemSchema>;

export interface AppErrorOptions {
  fields?: ProblemField[];
  /** Current resource for a 409 version conflict. */
  current?: unknown;
  /** Extra response headers, e.g. `Retry-After`. */
  headers?: Record<string, string>;
  cause?: unknown;
}

/**
 * The only error services should throw on purpose. `detail` is sent to the client and kept in logs
 * (`expose: true`), so it must never contain PII, amounts or free text from user data (hard rule 8).
 */
export class AppError extends Error {
  override readonly name = "AppError";
  /** The logger keeps the message of exposed errors only (packages/observability). */
  readonly expose = true;
  readonly status: number;
  readonly fields: ProblemField[] | undefined;
  readonly current: unknown;
  readonly headers: Record<string, string>;

  constructor(
    readonly code: ErrorCode,
    status: number = DEFAULT_STATUS[code],
    readonly detail?: string,
    options: AppErrorOptions = {},
  ) {
    super(detail ?? TITLES[code], options.cause === undefined ? undefined : { cause: options.cause });
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`AppError status must be 400-599, got ${status}`);
    }
    this.status = status;
    this.fields = options.fields;
    this.current = options.current;
    this.headers = options.headers ?? {};
  }

  /** Problem body for this error. `instance` and `requestId` come from the request. */
  toProblem(context: { instance?: string; requestId?: string } = {}): Problem {
    return {
      type: problemType(this.code),
      title: TITLES[this.code],
      status: this.status,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      ...(context.instance !== undefined ? { instance: context.instance } : {}),
      code: this.code,
      ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
      ...(this.fields !== undefined ? { fields: this.fields } : {}),
      ...(this.current !== undefined ? { current: this.current } : {}),
    };
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
