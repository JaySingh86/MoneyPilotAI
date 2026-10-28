// Svix signatures (Clerk webhooks, BACKEND_PLAN §8.4). Spec: the signed content is
// `${svix-id}.${svix-timestamp}.${body}`, HMAC-SHA256 with the base64 secret after `whsec_`, sent as a
// space-separated list of `v1,<base64>` in `svix-signature`.
import { assertFreshTimestamp, signHmac, verifyHmacSignature, webhookRejected } from "./hmac";

export interface SvixHeaders {
  "svix-id"?: string | string[] | undefined;
  "svix-timestamp"?: string | string[] | undefined;
  "svix-signature"?: string | string[] | undefined;
}

export interface SvixVerifyInput {
  /** `whsec_…` signing secret from Secrets Manager. */
  secret: string;
  headers: SvixHeaders;
  /** Exact raw request body. */
  rawBody: Buffer | string;
  nowMs?: number;
  toleranceSeconds?: number;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function secretBytes(secret: string): Buffer {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) throw new Error("Svix secret is empty or not base64");
  return bytes;
}

/** Throws 401 unless the request carries a valid, fresh Svix signature. Returns the message id. */
export function verifySvixSignature(input: SvixVerifyInput): { id: string; timestamp: number } {
  const id = single(input.headers["svix-id"]);
  const timestamp = single(input.headers["svix-timestamp"]);
  const signatures = single(input.headers["svix-signature"]);
  if (!id || !timestamp || !signatures) throw webhookRejected("The webhook signature headers are missing.");
  if (!/^\d{1,12}$/.test(timestamp)) throw webhookRejected("The webhook timestamp is invalid.");
  const seconds = Number(timestamp);
  assertFreshTimestamp(seconds, input.nowMs ?? Date.now(), input.toleranceSeconds);

  const key = secretBytes(input.secret);
  const body = typeof input.rawBody === "string" ? input.rawBody : input.rawBody.toString("utf8");
  const signed = `${id}.${timestamp}.${body}`;
  const valid = signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",", 2);
    return (
      version === "v1" &&
      signature !== undefined &&
      verifyHmacSignature({ secret: key, payload: signed, signature, encoding: "base64" })
    );
  });
  if (!valid) throw webhookRejected("The webhook signature is invalid.");
  return { id, timestamp: seconds };
}

/** Builds Svix headers for a body (tests and local tooling). */
export function signSvix(secret: string, id: string, timestampSeconds: number, body: string): SvixHeaders {
  const signature = signHmac(secretBytes(secret), `${id}.${timestampSeconds}.${body}`, "sha256", "base64");
  return { "svix-id": id, "svix-timestamp": String(timestampSeconds), "svix-signature": `v1,${signature}` };
}
