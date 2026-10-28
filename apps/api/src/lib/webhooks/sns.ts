// Amazon SNS message signatures (SES inbound and SES events, BACKEND_PLAN §8.4):
// - the topic ARN must be allowlisted, and its region fixes the only SNS host we talk to;
// - the signing certificate comes only from `https://sns.<region>.amazonaws.com/…pem`, must be in date,
//   and must be issued to SNS (subject CN `sns.amazonaws.com` or `sns.<region>.amazonaws.com`);
// - only SignatureVersion 2 (RSA-SHA256) is accepted;
// - a SubscribeURL is followed only on that same host, for an allowlisted topic.
// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
import { verify, X509Certificate } from "node:crypto";
import { z } from "zod";
import { parseJsonSafely } from "../json";
import { webhookRejected } from "./hmac";

const SnsMessageSchema = z.object({
  Type: z.enum(["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"]),
  MessageId: z.string().min(1),
  TopicArn: z.string().min(1),
  Subject: z.string().optional(),
  Message: z.string(),
  Timestamp: z.string().min(1),
  SignatureVersion: z.string(),
  Signature: z.string().min(1),
  SigningCertURL: z.string().min(1),
  SubscribeURL: z.string().optional(),
  Token: z.string().optional(),
  UnsubscribeURL: z.string().optional(),
});

export type SnsMessage = z.infer<typeof SnsMessageSchema>;

/** Loads a PEM certificate by URL. Inject a fake in tests. */
export type CertificateLoader = (url: string) => Promise<string>;

export interface SnsVerifyOptions {
  /** Only these topics are accepted (one per SES receipt rule / configuration set). */
  allowedTopicArns: readonly string[];
  /** Our AWS region (config). When set, the topic must be in it. Default: the topic ARN's region. */
  region?: string;
  loadCertificate: CertificateLoader;
  nowMs?: number;
  /** Reject messages older than this. Default 1 hour (SNS retries for up to about an hour). */
  maxAgeMs?: number;
}

/** AWS region names: `us-east-1`, `eu-central-2`, `us-gov-west-1`. */
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const TOPIC_ARN = /^arn:aws:sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9_-]{1,256}$/;

/** The region in an SNS topic ARN, or null when the ARN is malformed. */
export function topicRegion(topicArn: string): string | null {
  const region = TOPIC_ARN.exec(topicArn)?.[1];
  return region && REGION.test(region) ? region : null;
}

/** The only SNS host for a region: `sns.<region>.amazonaws.com`. */
export function snsHost(region: string): string {
  if (!REGION.test(region)) throw new Error(`Not an AWS region: ${region}`);
  return `sns.${region}.amazonaws.com`;
}

function parseHttpsUrl(value: string, host: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const ok =
    url.protocol === "https:" &&
    url.hostname === host &&
    url.port === "" &&
    url.username === "" &&
    url.password === "";
  return ok ? url : null;
}

/** True for `https://sns.<region>.amazonaws.com/….pem` (that exact host; no credentials, port or query). */
export function isTrustedSigningCertUrl(value: string, region: string): boolean {
  const url = parseHttpsUrl(value, snsHost(region));
  return url !== null && url.search === "" && url.pathname.endsWith(".pem");
}

/** The canonical string SNS signs: `Key\nValue\n` for the type's keys in byte order. */
export function snsStringToSign(message: SnsMessage): string {
  const keys =
    message.Type === "Notification"
      ? (["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const)
      : (["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"] as const);
  let out = "";
  for (const key of keys) {
    const value = message[key];
    if (value === undefined) {
      if (key === "Subject") continue;
      throw webhookRejected("The SNS message is missing a signed field.");
    }
    out += `${key}\n${value}\n`;
  }
  return out;
}

function commonNames(subject: string): string[] {
  return subject
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("CN="))
    .map((line) => line.slice(3));
}

/** Parses the signing certificate and checks it is in date and issued to SNS. Throws 401. */
export function checkSigningCertificate(pem: string, region: string, nowMs: number): X509Certificate {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    throw webhookRejected("The SNS signing certificate could not be loaded.");
  }
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || nowMs < from || nowMs > to) {
    throw webhookRejected("The SNS signing certificate is expired or not yet valid.");
  }
  const allowed = new Set(["sns.amazonaws.com", snsHost(region)]);
  if (!commonNames(cert.subject).some((cn) => allowed.has(cn))) {
    throw webhookRejected("The SNS signing certificate was not issued to SNS.");
  }
  return cert;
}

function topicRegionFor(message: SnsMessage, options: SnsVerifyOptions): string {
  if (!options.allowedTopicArns.includes(message.TopicArn)) {
    throw webhookRejected("The SNS topic is not allowed.");
  }
  const region = topicRegion(message.TopicArn);
  if (!region || (options.region !== undefined && region !== options.region)) {
    throw webhookRejected("The SNS topic is not in our region.");
  }
  return region;
}

/** Parses and verifies an SNS POST body (a JSON string). Throws 401 on any failure. */
export async function verifySnsMessage(body: unknown, options: SnsVerifyOptions): Promise<SnsMessage> {
  let candidate = body;
  if (typeof body === "string") {
    try {
      candidate = parseJsonSafely(body);
    } catch {
      throw webhookRejected("The SNS message is not valid JSON.");
    }
  }
  const parsed = SnsMessageSchema.safeParse(candidate);
  if (!parsed.success) throw webhookRejected("The SNS message is malformed.");
  const message = parsed.data;

  if (message.SignatureVersion !== "2") {
    throw webhookRejected("Only SNS SignatureVersion 2 (SHA256) is accepted.");
  }
  const region = topicRegionFor(message, options);
  if (!isTrustedSigningCertUrl(message.SigningCertURL, region)) {
    throw webhookRejected("The SNS signing certificate URL is not trusted.");
  }
  const sentAt = Date.parse(message.Timestamp);
  const now = options.nowMs ?? Date.now();
  if (
    !Number.isFinite(sentAt) ||
    now - sentAt > (options.maxAgeMs ?? 60 * 60 * 1000) ||
    sentAt - now > 5 * 60 * 1000
  ) {
    throw webhookRejected("The SNS message timestamp is out of range.");
  }

  let pem: string;
  try {
    pem = await options.loadCertificate(message.SigningCertURL);
  } catch {
    throw webhookRejected("The SNS signing certificate could not be loaded.");
  }
  const cert = checkSigningCertificate(pem, region, now);
  const ok = verify(
    "sha256",
    Buffer.from(snsStringToSign(message), "utf8"),
    cert.publicKey,
    Buffer.from(message.Signature, "base64"),
  );
  if (!ok) throw webhookRejected("The SNS signature is invalid.");
  return message;
}

/**
 * The URL to GET to confirm a subscription, for a message `verifySnsMessage` already accepted. Only an
 * HTTPS `ConfirmSubscription` call on the topic's own SNS host, for an allowlisted topic, is returned.
 */
export function trustedSubscribeUrl(
  message: SnsMessage,
  options: Pick<SnsVerifyOptions, "allowedTopicArns" | "region">,
): string {
  if (message.Type !== "SubscriptionConfirmation" || !message.SubscribeURL) {
    throw webhookRejected("The SNS message is not a subscription confirmation.");
  }
  const region = topicRegionFor(message, { ...options, loadCertificate: async () => "" });
  const url = parseHttpsUrl(message.SubscribeURL, snsHost(region));
  if (
    !url ||
    url.searchParams.get("Action") !== "ConfirmSubscription" ||
    url.searchParams.get("TopicArn") !== message.TopicArn
  ) {
    throw webhookRejected("The SNS SubscribeURL is not trusted.");
  }
  return url.toString();
}

/**
 * Default loader: fetches the certificate over HTTPS from an SNS host and caches it per URL for the
 * process. `verifySnsMessage` has already pinned the URL to the topic's region.
 */
export function createCertificateLoader(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): CertificateLoader {
  const cache = new Map<string, Promise<string>>();
  return (url) => {
    let host: string | null = null;
    try {
      host = new URL(url).hostname;
    } catch {
      host = null;
    }
    const region = host?.match(/^sns\.(.+)\.amazonaws\.com$/)?.[1];
    if (!region || !REGION.test(region) || !isTrustedSigningCertUrl(url, region)) {
      return Promise.reject(new Error("untrusted certificate URL"));
    }
    let pending = cache.get(url);
    if (!pending) {
      pending = (async () => {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
        if (!res.ok) throw new Error(`certificate fetch failed: ${res.status}`);
        const pem = await res.text();
        if (!pem.includes("-----BEGIN CERTIFICATE-----")) throw new Error("not a PEM certificate");
        return pem;
      })();
      pending.catch(() => cache.delete(url));
      cache.set(url, pending);
    }
    return pending;
  };
}
