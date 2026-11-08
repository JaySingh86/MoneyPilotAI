import pino from "pino";
import type { DestinationStream, Logger } from "pino";

/**
 * Field names that must never reach logs (CLAUDE.md hard rule 8): credentials, contact details,
 * names, money and free text from emails or bank files. Matched at the root and two levels deep.
 */
export const SENSITIVE_KEYS = [
  // credentials
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "apiKey",
  "password",
  "secret",
  "authorization",
  "Authorization",
  "cookie",
  "set-cookie",
  "code",
  "state",
  // auth flows (WP-33): provider-style names as well as ours
  "refresh_token",
  "access_token",
  "id_token",
  "token_hash",
  "tokenHash",
  "newPassword",
  "mfaCode",
  "otpauthUri",
  "challengeId",
  "error_description",
  // people
  "email",
  "emails",
  "phone",
  "firstName",
  "lastName",
  "fullName",
  "address",
  // money
  "amount",
  "amountCents",
  "actualAmountCents",
  "previousAmountCents",
  "balance",
  "balanceCents",
  "endBalanceCents",
  "totalCents",
  "safeToSpendCents",
  "cushionCents",
  "targetCents",
  "savedCents",
  "monthlyCents",
  "accountNumber",
  // free text from emails and imports
  "description",
  "subject",
  "body",
  "text",
];

function keyPath(prefix: string, key: string): string {
  const safe = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `["${key}"]`;
  return prefix ? `${prefix}${safe}` : safe.startsWith(".") ? safe.slice(1) : safe;
}

/** pino redact paths: root, one level and two levels deep for every sensitive key. */
export const REDACT_PATHS = SENSITIVE_KEYS.flatMap((key) => [
  keyPath("", key),
  keyPath("*", key),
  keyPath("*.*", key),
]);

interface ErrorLike {
  name?: string;
  code?: unknown;
  stack?: string;
  expose?: boolean;
  message?: string;
}

/**
 * Error serializer. Messages can carry user data (an email address, an amount), so only errors
 * marked `expose: true` (our AppError) keep their message. The stack keeps frames, not the message line.
 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { type: typeof err };
  const e = err as ErrorLike;
  const frames = (e.stack ?? "").split("\n").slice(1).join("\n");
  return {
    type: e.name,
    // Logged as errorCode: plain `code` is redacted because OAuth authorization codes use that name.
    ...(e.code !== undefined ? { errorCode: e.code } : {}),
    ...(e.expose === true ? { message: e.message } : {}),
    stack: frames,
  };
}

export type { Logger };

export function createLogger(
  service: string,
  level = process.env.LOG_LEVEL ?? "info",
  destination?: DestinationStream,
): Logger {
  const options = {
    name: service,
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    serializers: { err: serializeError, error: serializeError },
    base: { service },
  };
  return destination ? pino(options, destination) : pino(options);
}
