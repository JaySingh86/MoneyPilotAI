// The email delivery port. Implementations: SES (production), SMTP to Mailpit (local development) and an
// in-memory fake (tests). Nothing here reads a database.

export interface EmailMessage {
  /** One recipient address. */
  to: string;
  /** Single line, no amounts (lock-screen privacy, BACKEND_PLAN §7.6). */
  subject: string;
  text: string;
  html: string;
  /** Extra headers such as `List-Unsubscribe`. */
  headers?: Record<string, string>;
}

export interface SentEmail {
  /** The provider's id for the message; SES echoes it in its Delivery, Bounce and Complaint events. */
  providerMessageId: string;
}

export interface EmailSender {
  /** Throws {@link EmailSendError}; any other error is treated as retryable by callers. */
  send(message: EmailMessage): Promise<SentEmail>;
}

/**
 * A failed send. `code` is a short machine code ("ses:Throttling", "smtp:ECONNREFUSED") and the only text
 * kept: provider messages can quote the address, so they are never stored or logged.
 */
export class EmailSendError extends Error {
  override readonly name = "EmailSendError";
  constructor(
    readonly code: string,
    /** True when trying again later can succeed (throttling, outage); false for a rejected message. */
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

/** A short safe code from any thrown value. */
export function errorCode(error: unknown): string {
  if (error instanceof EmailSendError) return error.code;
  return "unknown";
}
