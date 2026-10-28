// HMAC signatures for webhooks (BACKEND_PLAN §8.4): Clerk (Svix) and the billing provider.
// Verify the exact raw bytes (plugins/raw-body.ts) before parsing or trusting anything in the payload.
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@mp/contracts";

export type HmacAlgorithm = "sha256" | "sha512";
export type SignatureEncoding = "hex" | "base64";

export function webhookRejected(reason: string): AppError {
  return new AppError("unauthorized", 401, reason);
}

/** Constant-time string comparison (also for Graph `clientState`). False on any length difference. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Compare anyway so timing does not depend on where the strings differ.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function signHmac(
  secret: string | Buffer,
  payload: string | Buffer,
  algorithm: HmacAlgorithm = "sha256",
  encoding: SignatureEncoding = "hex",
): string {
  return createHmac(algorithm, secret).update(payload).digest(encoding);
}

export interface HmacVerifyInput {
  secret: string | Buffer;
  /** Exact raw request body (or the provider's signed string). */
  payload: string | Buffer;
  /** Signature from the header, without any `sha256=` style prefix. */
  signature: string;
  algorithm?: HmacAlgorithm;
  encoding?: SignatureEncoding;
}

/** True when `signature` is the HMAC of `payload` under `secret`. Constant-time. */
export function verifyHmacSignature(input: HmacVerifyInput): boolean {
  const encoding = input.encoding ?? "hex";
  const expected = Buffer.from(signHmac(input.secret, input.payload, input.algorithm, encoding), encoding);
  const actual = Buffer.from(input.signature, encoding);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Rejects a signed timestamp (epoch seconds) outside ±`toleranceSeconds` of now, against replays. */
export function assertFreshTimestamp(timestampSeconds: number, nowMs: number, toleranceSeconds = 300): void {
  if (!Number.isFinite(timestampSeconds)) throw webhookRejected("The webhook timestamp is invalid.");
  if (Math.abs(nowMs / 1000 - timestampSeconds) > toleranceSeconds) {
    throw webhookRejected("The webhook timestamp is too old or in the future.");
  }
}
