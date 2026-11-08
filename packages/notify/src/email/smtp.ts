import { randomUUID } from "node:crypto";
// SMTP sender for local development: Mailpit on localhost:1025 (docker-compose, .env.example). No TLS, no auth.
import nodemailer from "nodemailer";
import { EmailSendError, type EmailMessage, type EmailSender, type SentEmail } from "./types";

/** The slice of a nodemailer transport this sender uses. */
export interface SmtpTransportLike {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    headers?: Record<string, string> | undefined;
  }): Promise<{ messageId?: string }>;
}

export interface SmtpSenderOptions {
  from: string;
  transport: SmtpTransportLike;
}

export function classifySmtpError(error: unknown): EmailSendError {
  const e = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    responseCode?: unknown;
  };
  const code = typeof e.code === "string" ? e.code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) : "";
  const response = typeof e.responseCode === "number" ? e.responseCode : null;
  // 5xx from the server is a final rejection; connection problems and 4xx are worth retrying.
  const retryable = response === null ? true : response < 500;
  return new EmailSendError(`smtp:${code || (response !== null ? String(response) : "Error")}`, retryable);
}

export function createSmtpSender(options: SmtpSenderOptions): EmailSender {
  return {
    async send(message: EmailMessage): Promise<SentEmail> {
      let info: { messageId?: string };
      try {
        info = await options.transport.sendMail({
          from: options.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: message.headers,
        });
      } catch (error) {
        throw classifySmtpError(error);
      }
      return { providerMessageId: info.messageId ?? randomUUID() };
    },
  };
}

/** Mailpit-style transport: plain SMTP, no TLS upgrade, short timeouts so a dead dev stack fails fast. */
export function createLocalSmtpTransport(host: string, port: number): SmtpTransportLike {
  return nodemailer.createTransport({
    host,
    port,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  });
}
