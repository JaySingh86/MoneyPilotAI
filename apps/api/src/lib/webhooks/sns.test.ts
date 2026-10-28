import { sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { expectWebhookRejected as rejects, makeTestCertificate } from "../testing";
import {
  checkSigningCertificate,
  createCertificateLoader,
  isTrustedSigningCertUrl,
  snsStringToSign,
  topicRegion,
  trustedSubscribeUrl,
  verifySnsMessage,
  type SnsMessage,
} from "./sns";

const REGION = "us-east-1";
const TOPIC = "arn:aws:sns:us-east-1:123456789012:mp-ses-inbound";
const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem";
const DAY = 24 * 60 * 60 * 1000;

const sns = makeTestCertificate("sns.amazonaws.com");
const regional = makeTestCertificate("sns.us-east-1.amazonaws.com");
const impostor = makeTestCertificate("evil.example");
// After the certificates exist, so every one is already valid at NOW.
const NOW = Date.now();

function signed(overrides: Partial<SnsMessage> = {}, keyPem = sns.keyPem): SnsMessage {
  const base: SnsMessage = {
    Type: "Notification",
    MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
    TopicArn: TOPIC,
    Subject: "Amazon SES Email Receipt Notification",
    Message: '{"notificationType":"Received"}',
    Timestamp: new Date(NOW - 60_000).toISOString(),
    SignatureVersion: "2",
    Signature: "",
    SigningCertURL: CERT_URL,
    ...overrides,
  };
  const signature = sign("sha256", Buffer.from(snsStringToSign(base)), keyPem);
  return { ...base, Signature: signature.toString("base64") };
}

const options = {
  allowedTopicArns: [TOPIC],
  region: REGION,
  loadCertificate: async () => sns.certPem,
  nowMs: NOW,
};

describe("SNS message verification", () => {
  it("accepts a SignatureVersion 2 notification from a JSON string", async () => {
    await expect(verifySnsMessage(JSON.stringify(signed()), options)).resolves.toMatchObject({
      TopicArn: TOPIC,
    });
  });

  it("accepts a certificate issued to the regional SNS name", async () => {
    const msg = signed({}, regional.keyPem);
    await expect(
      verifySnsMessage(msg, { ...options, loadCertificate: async () => regional.certPem }),
    ).resolves.toBeDefined();
  });

  it("takes the region from the topic ARN when none is configured", async () => {
    const { region: _region, ...noRegion } = options;
    await expect(verifySnsMessage(signed(), noRegion)).resolves.toBeDefined();
  });

  it("signs notifications without a Subject and subscription confirmations", async () => {
    await expect(verifySnsMessage(signed({ Subject: undefined }), options)).resolves.toBeDefined();
    const confirmation = signed({
      Type: "SubscriptionConfirmation",
      Subject: undefined,
      SubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=tok`,
      Token: "tok",
    });
    await expect(verifySnsMessage(confirmation, options)).resolves.toMatchObject({ Token: "tok" });
  });

  it("builds the canonical string in key order", () => {
    const msg = signed();
    expect(snsStringToSign(msg)).toBe(
      'Message\n{"notificationType":"Received"}\nMessageId\n22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324\n' +
        `Subject\nAmazon SES Email Receipt Notification\nTimestamp\n${msg.Timestamp}\n` +
        `TopicArn\n${TOPIC}\nType\nNotification\n`,
    );
  });

  it("rejects SignatureVersion 1 (SHA1)", async () => {
    const base = signed({ SignatureVersion: "1" });
    const sha1 = sign("sha1", Buffer.from(snsStringToSign(base)), sns.keyPem).toString("base64");
    await rejects(verifySnsMessage({ ...base, Signature: sha1 }, options), /SignatureVersion 2/);
  });

  it("rejects a certificate URL on the S3 host, another region, http, or a lookalike host", async () => {
    for (const url of [
      "https://sns.s3.amazonaws.com/SimpleNotificationService-abc.pem",
      "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem",
      "http://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem",
      "https://sns.us-east-1.amazonaws.com.evil.example/x.pem",
    ]) {
      await rejects(verifySnsMessage(signed({ SigningCertURL: url }), options), /certificate URL/);
    }
  });

  it("rejects an expired certificate", async () => {
    const later = NOW + 3 * DAY;
    const msg = signed({ Timestamp: new Date(later - 60_000).toISOString() });
    await rejects(verifySnsMessage(msg, { ...options, nowMs: later }), /expired/);
  });

  it("rejects a certificate not issued to SNS", async () => {
    const msg = signed({}, impostor.keyPem);
    await rejects(
      verifySnsMessage(msg, { ...options, loadCertificate: async () => impostor.certPem }),
      /not issued to SNS/,
    );
  });

  it("rejects tampering, unknown topics, topics in another region and stale messages", async () => {
    await rejects(verifySnsMessage({ ...signed(), Message: "{}" }, options), /signature is invalid/);
    await rejects(verifySnsMessage(signed({ TopicArn: `${TOPIC}-other` }), options), /topic is not allowed/);
    const euTopic = "arn:aws:sns:eu-west-1:123456789012:mp-ses-inbound";
    await rejects(
      verifySnsMessage(signed({ TopicArn: euTopic }), { ...options, allowedTopicArns: [euTopic] }),
      /region/,
    );
    await rejects(
      verifySnsMessage(signed({ Timestamp: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() }), options),
      /timestamp/,
    );
    await rejects(verifySnsMessage("{not json", options), /JSON/);
    await rejects(verifySnsMessage({ Type: "Notification" }, options), /malformed/);
    await rejects(
      verifySnsMessage(signed(), { ...options, loadCertificate: async () => "garbage" }),
      /could not be loaded/,
    );
    await rejects(
      verifySnsMessage(signed(), {
        ...options,
        loadCertificate: async () => {
          throw new Error("network");
        },
      }),
      /could not be loaded/,
    );
  });
});

describe("signing certificate checks", () => {
  it("accepts an in-date SNS certificate", () => {
    expect(checkSigningCertificate(sns.certPem, REGION, NOW).subject).toContain("CN=sns.amazonaws.com");
  });

  it("rejects a certificate that is not yet valid", async () => {
    await rejects(() => checkSigningCertificate(sns.certPem, REGION, NOW - DAY), /not yet valid/);
  });
});

describe("SNS hosts", () => {
  it.each([
    ["https://sns.us-east-1.amazonaws.com/SimpleNotificationService-x.pem", true],
    ["https://sns.s3.amazonaws.com/x.pem", false],
    ["https://sns.eu-west-1.amazonaws.com/x.pem", false],
    ["http://sns.us-east-1.amazonaws.com/x.pem", false],
    ["https://sns.us-east-1.amazonaws.com:8443/x.pem", false],
    ["https://user@sns.us-east-1.amazonaws.com/x.pem", false],
    ["https://sns.us-east-1.amazonaws.com/x.pem?y=1", false],
    ["https://sns.us-east-1.amazonaws.com/x.txt", false],
    ["not a url", false],
  ])("isTrustedSigningCertUrl(%s) = %s", (url, expected) => {
    expect(isTrustedSigningCertUrl(url, REGION)).toBe(expected);
  });

  it("reads the region from a topic ARN", () => {
    expect(topicRegion(TOPIC)).toBe("us-east-1");
    expect(topicRegion("arn:aws:sns:s3:123456789012:t")).toBeNull();
    expect(topicRegion("arn:aws:s3:::bucket")).toBeNull();
  });
});

describe("trustedSubscribeUrl", () => {
  const confirm = (url: string, topic = TOPIC): SnsMessage =>
    signed({
      Type: "SubscriptionConfirmation",
      Subject: undefined,
      SubscribeURL: url,
      Token: "tok",
      TopicArn: topic,
    });
  const good = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=tok`;

  it("returns an HTTPS ConfirmSubscription URL on the topic's SNS host", () => {
    expect(trustedSubscribeUrl(confirm(good), options)).toBe(new URL(good).toString());
  });

  it("rejects other hosts, schemes, actions, topics and message types", async () => {
    await rejects(
      () => trustedSubscribeUrl(confirm(good.replace("https:", "http:")), options),
      /SubscribeURL/,
    );
    await rejects(
      () => trustedSubscribeUrl(confirm(good.replace("sns.us-east-1", "sns.s3")), options),
      /SubscribeURL/,
    );
    await rejects(() =>
      trustedSubscribeUrl(confirm(good.replace("us-east-1.amazonaws.com", "evil.example")), options),
    );
    await rejects(() =>
      trustedSubscribeUrl(confirm(good.replace("ConfirmSubscription", "Unsubscribe")), options),
    );
    await rejects(
      () => trustedSubscribeUrl(confirm(good.replace(TOPIC, `${TOPIC}-x`)), options),
      /SubscribeURL/,
    );
    await rejects(() => trustedSubscribeUrl(confirm(good, `${TOPIC}-x`), options), /topic is not allowed/);
    await rejects(() => trustedSubscribeUrl(signed(), options), /not a subscription confirmation/);
  });
});

describe("default certificate loader", () => {
  it("fetches trusted URLs once and caches them", async () => {
    const fetchImpl = vi.fn(async () => new Response(sns.certPem, { status: 200 }));
    const load = createCertificateLoader(fetchImpl as unknown as typeof fetch);
    await expect(load(CERT_URL)).resolves.toBe(sns.certPem);
    await expect(load(CERT_URL)).resolves.toBe(sns.certPem);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(load("https://sns.s3.amazonaws.com/x.pem")).rejects.toThrow();
    await expect(load("https://evil.example/x.pem")).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects non-certificates and does not cache failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>", { status: 200 }))
      .mockResolvedValueOnce(new Response(sns.certPem, { status: 200 }));
    const load = createCertificateLoader(fetchImpl as unknown as typeof fetch);
    await expect(load(CERT_URL)).rejects.toThrow(/PEM/);
    await expect(load(CERT_URL)).resolves.toContain("BEGIN CERTIFICATE");
  });
});
