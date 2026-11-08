// Picks the email transport from configuration. Production must say what it wants: there is no silent default
// that would "send" nothing (the lesson of Q-081).
import { createSesClient, createSesSender } from "./ses";
import { createLocalSmtpTransport, createSmtpSender } from "./smtp";
import type { EmailSender } from "./types";

export interface EmailEnv {
  NODE_ENV?: string | undefined;
  /** `ses` or `smtp`. Default: `smtp` outside production; required in production. */
  EMAIL_TRANSPORT?: string | undefined;
  /** `MoneyPilot <notifications@mail.example>`. Required for SES. */
  EMAIL_FROM?: string | undefined;
  SES_CONFIGURATION_SET?: string | undefined;
  AWS_REGION?: string | undefined;
  SMTP_HOST?: string | undefined;
  SMTP_PORT?: string | undefined;
}

export class EmailConfigError extends Error {
  override readonly name = "EmailConfigError";
}

const LOCAL_FROM = "MoneyPilot <notifications@moneypilot.test>";

export function createEmailSender(env: EmailEnv): EmailSender {
  const production = env.NODE_ENV === "production";
  const transport = env.EMAIL_TRANSPORT ?? (production ? "" : "smtp");
  if (transport === "ses") {
    if (!env.EMAIL_FROM) throw new EmailConfigError("EMAIL_FROM is required for the SES transport.");
    if (!env.AWS_REGION) throw new EmailConfigError("AWS_REGION is required for the SES transport.");
    return createSesSender({
      from: env.EMAIL_FROM,
      configurationSet: env.SES_CONFIGURATION_SET,
      client: createSesClient(env.AWS_REGION),
    });
  }
  if (transport === "smtp") {
    if (production) throw new EmailConfigError("The SMTP transport is for local development only.");
    const port = Number(env.SMTP_PORT ?? "1025");
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new EmailConfigError("SMTP_PORT is not a port.");
    return createSmtpSender({
      from: env.EMAIL_FROM ?? LOCAL_FROM,
      transport: createLocalSmtpTransport(env.SMTP_HOST ?? "localhost", port),
    });
  }
  throw new EmailConfigError("EMAIL_TRANSPORT must be set to `ses` (or `smtp` in development).");
}
