// In-memory sender for tests: records every message, can be told to fail.
import { randomUUID } from "node:crypto";
import type { EmailMessage, EmailSender, EmailSendError, SentEmail } from "./types";

export class FakeEmailSender implements EmailSender {
  readonly sent: Array<EmailMessage & { providerMessageId: string }> = [];
  private failures: EmailSendError[] = [];

  /** The next sends fail, in order, with these errors. */
  failNext(...errors: EmailSendError[]): void {
    this.failures.push(...errors);
  }

  async send(message: EmailMessage): Promise<SentEmail> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    const providerMessageId = `fake-${randomUUID()}`;
    this.sent.push({ ...message, providerMessageId });
    return { providerMessageId };
  }
}
