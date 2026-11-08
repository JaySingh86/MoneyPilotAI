// Amazon SES (API v2) sender. The client is injectable so tests never reach AWS. Sent with the configuration
// set that routes Delivery, Bounce and Complaint events to SNS → /webhooks/ses-events (BACKEND_PLAN §7.6).
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { EmailSendError, type EmailMessage, type EmailSender, type SentEmail } from "./types";

/** The slice of `SESv2Client` this sender uses. */
export interface SesClientLike {
  send(command: SendEmailCommand): Promise<{ MessageId?: string | undefined }>;
}

export interface SesSenderOptions {
  /** `MoneyPilot <notifications@mail.example>`; a verified identity on the dedicated mail subdomain. */
  from: string;
  configurationSet?: string | undefined;
  client: SesClientLike;
}

/** SESv2 error names that mean "try again later". Everything else (rejected, suspended, invalid) is final. */
const RETRYABLE = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "LimitExceededException",
  "ServiceUnavailableException",
  "InternalServiceErrorException",
  "InternalFailure",
  "RequestTimeout",
  "RequestTimeoutException",
  "TimeoutError",
  "NetworkingError",
]);

export function classifySesError(error: unknown): EmailSendError {
  const e = (typeof error === "object" && error !== null ? error : {}) as {
    name?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: number };
    $retryable?: unknown;
  };
  const name = typeof e.name === "string" && e.name.length <= 60 ? e.name : "Error";
  const status = e.$metadata?.httpStatusCode;
  const retryable =
    RETRYABLE.has(name) ||
    (typeof status === "number" && (status >= 500 || status === 429)) ||
    (typeof e.code === "string" &&
      ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(e.code)) ||
    e.$retryable !== undefined;
  return new EmailSendError(`ses:${name.replace(/[^A-Za-z0-9]/g, "")}`, retryable);
}

export function createSesSender(options: SesSenderOptions): EmailSender {
  return {
    async send(message: EmailMessage): Promise<SentEmail> {
      const command = new SendEmailCommand({
        FromEmailAddress: options.from,
        Destination: { ToAddresses: [message.to] },
        ...(options.configurationSet ? { ConfigurationSetName: options.configurationSet } : {}),
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: message.text, Charset: "UTF-8" },
              Html: { Data: message.html, Charset: "UTF-8" },
            },
            ...(message.headers
              ? { Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })) }
              : {}),
          },
        },
      });
      let result: { MessageId?: string | undefined };
      try {
        result = await options.client.send(command);
      } catch (error) {
        throw classifySesError(error);
      }
      if (!result.MessageId) throw new EmailSendError("ses:NoMessageId", true);
      return { providerMessageId: result.MessageId };
    },
  };
}

/** A real client for a region (credentials come from the AWS default chain). */
export function createSesClient(region: string): SesClientLike {
  return new SESv2Client({ region });
}
