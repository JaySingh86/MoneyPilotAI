import type { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { describe, expect, it } from "vitest";
import { FakeEmailSender } from "./email/fake";
import { createEmailSender, EmailConfigError } from "./email/factory";
import { classifySesError, createSesSender } from "./email/ses";
import { classifySmtpError, createSmtpSender } from "./email/smtp";
import { EmailSendError } from "./email/types";
import { escapeHtml, singleLine, unescapeHtml } from "./escape";
import {
  INVITE_DAILY_QUOTA,
  SendQuotaExceededError,
  createInviteSender,
  createMemorySendQuota,
  inviteLink,
} from "./invite";
import { renderInviteEmail, renderNotificationEmail } from "./templates";

const EVIL = `<img src=x onerror=alert(1)> & "q" 'a'`;

describe("escaping", () => {
  it("round-trips through unescapeHtml, including text that already looks escaped", () => {
    for (const s of [EVIL, "&amp;lt;", "plain", "O'Brien & Sons"])
      expect(unescapeHtml(escapeHtml(s))).toBe(s);
  });
  it("singleLine removes line breaks (no header injection) and caps the length", () => {
    expect(singleLine("Hi\r\nBcc: evil@example.test")).toBe("Hi Bcc: evil@example.test");
    expect(singleLine("x".repeat(500), 20)).toHaveLength(20);
  });
});

describe("invite email", () => {
  const link = inviteLink("https://app.example.test/", "tok/en+1=");

  it("links to /invite?token= with the token encoded", () => {
    expect(link).toBe("https://app.example.test/invite?token=tok%2Fen%2B1%3D");
  });

  it("escapes names in the HTML part and keeps markup out of the subject", () => {
    const mail = renderInviteEmail({ inviterFirstName: EVIL, householdName: EVIL, link });
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(mail.subject).not.toContain("\n");
    expect(mail.html).toContain(escapeHtml(link));
  });

  it("does not double-escape names the API already escaped", () => {
    const mail = renderInviteEmail({
      inviterFirstName: "O&#39;Brien",
      householdName: "A&amp;B",
      link,
    });
    expect(mail.subject).toBe("O'Brien invited you to MoneyPilot");
    expect(mail.text).toContain("join A&B on");
    expect(mail.html).toContain("A&amp;B");
    expect(mail.html).not.toContain("&amp;amp;");
  });

  it("never asks the reader to pay anything", () => {
    const mail = renderInviteEmail({ inviterFirstName: "Sam", householdName: "Rivera", link });
    expect(`${mail.subject} ${mail.text}`).not.toMatch(/\bpay\b/i);
  });
});

describe("notification email", () => {
  it("uses the title as the subject, escapes everything and links inside the app only", () => {
    const mail = renderNotificationEmail({
      kind: "proposal",
      title: `${EVIL}\r\nBcc: x`,
      body: EVIL,
      deepLink: "/goals",
      appUrl: "https://app.example.test",
    });
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("https://app.example.test/goals");
    const off = renderNotificationEmail({
      kind: "system",
      title: "t",
      body: "b",
      deepLink: "//evil.example/x",
      appUrl: "https://app.example.test",
    });
    expect(off.html).not.toContain("evil.example");
  });

  it("offers a way to turn off non-essential kinds only", () => {
    const base = { title: "t", body: "b", appUrl: "https://app.example.test" };
    expect(renderNotificationEmail({ ...base, kind: "reminder" }).text).toContain("Turn these emails off");
    expect(renderNotificationEmail({ ...base, kind: "proposal" }).text).not.toContain(
      "Turn these emails off",
    );
  });
});

describe("invite sender", () => {
  const invite = {
    to: "jordan@example.test",
    token: "secret-token",
    householdName: "Rivera",
    inviterFirstName: "Sam",
    expiresAt: new Date("2026-11-11T00:00:00Z"),
    invitedByUserId: "00000000-0000-4000-8000-00000000000a",
  };

  it("sends one email whose link carries the token", async () => {
    const email = new FakeEmailSender();
    const sender = createInviteSender({
      email,
      quota: createMemorySendQuota(),
      appUrl: "https://app.example.test",
    });
    await sender.send(invite);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe("jordan@example.test");
    expect(email.sent[0]?.text).toContain("https://app.example.test/invite?token=secret-token");
  });

  it("stops at the per-user quota, and another user is unaffected", async () => {
    const email = new FakeEmailSender();
    let now = 0;
    const sender = createInviteSender({
      email,
      quota: createMemorySendQuota({ now: () => now }),
      appUrl: "https://app.example.test",
    });
    for (let i = 0; i < INVITE_DAILY_QUOTA; i++) await sender.send(invite);
    await expect(sender.send(invite)).rejects.toBeInstanceOf(SendQuotaExceededError);
    expect(email.sent).toHaveLength(INVITE_DAILY_QUOTA);
    await sender.send({ ...invite, invitedByUserId: "00000000-0000-4000-8000-00000000000b" });
    // the window slides
    now += 24 * 60 * 60 * 1000 + 1;
    await sender.send(invite);
  });

  it("does not send when the quota is spent, and rejects a relative app URL", async () => {
    const email = new FakeEmailSender();
    const sender = createInviteSender({
      email,
      quota: { consume: async () => false },
      appUrl: "https://app.example.test",
    });
    await expect(sender.send(invite)).rejects.toBeInstanceOf(SendQuotaExceededError);
    expect(email.sent).toHaveLength(0);
    expect(() =>
      createInviteSender({ email, quota: createMemorySendQuota(), appUrl: "/relative" }),
    ).toThrow();
  });
});

describe("SES sender", () => {
  const message = {
    to: "a@example.test",
    subject: "s",
    text: "t",
    html: "<p>t</p>",
    headers: { "X-A": "1" },
  };

  it("sends through the configuration set and returns the message id", async () => {
    const commands: SendEmailCommand[] = [];
    const sender = createSesSender({
      from: "MoneyPilot <n@mail.example.test>",
      configurationSet: "mp-events",
      client: {
        async send(command) {
          commands.push(command);
          return { MessageId: "ses-123" };
        },
      },
    });
    await expect(sender.send(message)).resolves.toEqual({ providerMessageId: "ses-123" });
    expect(commands[0]?.input.ConfigurationSetName).toBe("mp-events");
    expect(commands[0]?.input.Destination?.ToAddresses).toEqual(["a@example.test"]);
    expect(commands[0]?.input.Content?.Simple?.Headers).toEqual([{ Name: "X-A", Value: "1" }]);
  });

  it("classifies errors without keeping the provider's message", async () => {
    const throttled = Object.assign(new Error("a@example.test is over quota"), {
      name: "ThrottlingException",
    });
    const rejected = Object.assign(new Error("Address a@example.test is not verified"), {
      name: "MessageRejected",
      $metadata: { httpStatusCode: 400 },
    });
    const outage = Object.assign(new Error("x"), { name: "Weird", $metadata: { httpStatusCode: 503 } });
    expect(classifySesError(throttled)).toMatchObject({ code: "ses:ThrottlingException", retryable: true });
    expect(classifySesError(rejected)).toMatchObject({ code: "ses:MessageRejected", retryable: false });
    expect(classifySesError(outage).retryable).toBe(true);
    expect(classifySesError(rejected).message).not.toContain("example.test");
    const sender = createSesSender({
      from: "n@mail.example.test",
      client: {
        async send() {
          throw rejected;
        },
      },
    });
    await expect(sender.send(message)).rejects.toMatchObject({
      code: "ses:MessageRejected",
      retryable: false,
    });
  });
});

describe("SMTP (Mailpit) sender", () => {
  it("hands the message to the transport and returns its id", async () => {
    const seen: unknown[] = [];
    const sender = createSmtpSender({
      from: "n@moneypilot.test",
      transport: {
        async sendMail(mail) {
          seen.push(mail);
          return { messageId: "<abc@moneypilot.test>" };
        },
      },
    });
    const sent = await sender.send({ to: "a@example.test", subject: "s", text: "t", html: "h" });
    expect(sent.providerMessageId).toBe("<abc@moneypilot.test>");
    expect(seen[0]).toMatchObject({ from: "n@moneypilot.test", to: "a@example.test", subject: "s" });
  });

  it("without a transport message id, uses a random one (not a shared constant)", async () => {
    const sender = createSmtpSender({ from: "n@moneypilot.test", transport: { sendMail: async () => ({}) } });
    const mail = { to: "a@example.test", subject: "s", text: "t", html: "h" };
    const a = (await sender.send(mail)).providerMessageId;
    const b = (await sender.send(mail)).providerMessageId;
    expect(a).not.toBe(b);
    expect(a).not.toContain("smtp-unknown");
  });

  it("connection failures retry; a 5xx rejection does not", () => {
    expect(classifySmtpError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toMatchObject({
      code: "smtp:ECONNREFUSED",
      retryable: true,
    });
    expect(
      classifySmtpError(Object.assign(new Error("x"), { code: "EENVELOPE", responseCode: 550 })),
    ).toMatchObject({
      retryable: false,
    });
    expect(classifySmtpError(Object.assign(new Error("x"), { responseCode: 451 })).retryable).toBe(true);
  });
});

describe("createEmailSender", () => {
  it("defaults to SMTP outside production and refuses to guess in production", () => {
    expect(() => createEmailSender({ NODE_ENV: "development" })).not.toThrow();
    expect(() => createEmailSender({ NODE_ENV: "production" })).toThrow(EmailConfigError);
    expect(() => createEmailSender({ NODE_ENV: "production", EMAIL_TRANSPORT: "smtp" })).toThrow(
      EmailConfigError,
    );
    expect(() => createEmailSender({ NODE_ENV: "production", EMAIL_TRANSPORT: "ses" })).toThrow(/EMAIL_FROM/);
    expect(() =>
      createEmailSender({
        NODE_ENV: "production",
        EMAIL_TRANSPORT: "ses",
        EMAIL_FROM: "n@mail.example.test",
        AWS_REGION: "us-east-1",
      }),
    ).not.toThrow();
  });
});

describe("FakeEmailSender", () => {
  it("fails on demand, in order", async () => {
    const fake = new FakeEmailSender();
    fake.failNext(new EmailSendError("x", true));
    const msg = { to: "a@example.test", subject: "s", text: "t", html: "h" };
    await expect(fake.send(msg)).rejects.toBeInstanceOf(EmailSendError);
    await expect(fake.send(msg)).resolves.toEqual({ providerMessageId: expect.stringMatching(/^fake-/) });
  });
});
