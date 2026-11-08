// @mp/notify: email and push rendering and delivery (WP-15). No database access (adapters stay isolated,
// ARCHITECTURE §3): the API and the worker own the SQL and hand this package plain values.
export const PACKAGE = "@mp/notify";
export { escapeHtml, singleLine, unescapeHtml } from "./escape";
export {
  REMINDER_GRACE_MS,
  REMINDER_HOUR,
  daysBetween,
  defaultOffsets,
  isMonthlySubscription,
  reminderDedupeKey,
  reminderSendAt,
} from "./schedule";
export {
  EmailSendError,
  errorCode,
  type EmailMessage,
  type EmailSender,
  type SentEmail,
} from "./email/types";
export { classifySesError, createSesClient, createSesSender, type SesClientLike } from "./email/ses";
export {
  classifySmtpError,
  createLocalSmtpTransport,
  createSmtpSender,
  type SmtpTransportLike,
} from "./email/smtp";
export { createEmailSender, EmailConfigError, type EmailEnv } from "./email/factory";
export { unavailablePushChannel, type PushChannel, type PushMessage } from "./push";
export {
  MUTABLE_KINDS,
  appLink,
  renderInviteEmail,
  renderNotificationEmail,
  toMessage,
  type InviteEmailInput,
  type NotificationEmailInput,
  type RenderedEmail,
} from "./templates";
export {
  INVITE_DAILY_QUOTA,
  SendQuotaExceededError,
  createInviteSender,
  createMemorySendQuota,
  inviteLink,
  type InviteEmail,
  type InviteSenderOptions,
  type InviteSenderPort,
  type MemoryQuotaOptions,
  type SendQuota,
} from "./invite";
