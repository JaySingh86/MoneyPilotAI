// Notifications (WP-15; BACKEND_PLAN §5.2, §7.6, §8.2): the in-app list, read state and the user's email
// preferences. Titles never carry amounts; a body can (it is only shown inside the app and in the email body).
import { z } from "zod";
import { Timestamp, Uuid, page, PaginationQuery, HouseholdParams } from "../common";

export const NOTIFICATION_KINDS = [
  "reminder",
  "review",
  "proposal",
  "task",
  "digest",
  "security",
  "system",
] as const;
export const NotificationKind = z.enum(NOTIFICATION_KINDS).meta({ id: "NotificationKind" });
export type NotificationKind = z.infer<typeof NotificationKind>;

/** Kinds a person can switch off by email. The others (proposal, security, system) always get through. */
export const MUTABLE_NOTIFICATION_KINDS = ["reminder", "review", "task", "digest"] as const;
export const MutableNotificationKind = z.enum(MUTABLE_NOTIFICATION_KINDS);

export const NotificationDelivery = z
  .object({
    channel: z.enum(["email", "push"]),
    status: z.enum(["queued", "sent", "delivered", "bounced", "complained", "failed"]),
  })
  .meta({ id: "NotificationDelivery" });

export const Notification = z
  .object({
    id: Uuid,
    kind: NotificationKind,
    title: z.string(),
    body: z.string(),
    /** App-relative, e.g. `/bills?item=…`. */
    deepLink: z.string().nullable(),
    /** When it was (or is) due to go out. */
    sentAt: Timestamp,
    /** `failed` means every delivery attempt failed (shown in the Notifications screen). */
    status: z.enum(["scheduled", "sent", "failed"]),
    read: z.boolean(),
    readAt: Timestamp.nullable(),
    delivery: NotificationDelivery.nullable(),
  })
  .meta({ id: "Notification" });
export type Notification = z.infer<typeof Notification>;

export const NotificationList = page(Notification)
  .extend({ unreadCount: z.number().int().min(0) })
  .meta({ id: "NotificationList" });
export type NotificationList = z.infer<typeof NotificationList>;

export const NotificationListQuery = PaginationQuery.extend({
  /** `true` returns unread notifications only. */
  unread: z.enum(["true", "false"]).optional(),
});
export type NotificationListQuery = z.infer<typeof NotificationListQuery>;

export const NotificationParams = HouseholdParams.extend({ id: Uuid });

export const NotificationPreferences = z
  .object({
    emailEnabled: z.boolean(),
    mutedKinds: z.array(MutableNotificationKind),
    /** Set when SES reported a hard bounce or a complaint; email stays off until the address changes. */
    emailSuppressed: z.object({ reason: z.enum(["hard_bounce", "complaint"]), at: Timestamp }).nullable(),
  })
  .meta({ id: "NotificationPreferences" });
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;

export const UpdateNotificationPreferences = z
  .object({
    emailEnabled: z.boolean().optional(),
    mutedKinds: z.array(MutableNotificationKind).max(MUTABLE_NOTIFICATION_KINDS.length).optional(),
  })
  .strict()
  .refine((v) => v.emailEnabled !== undefined || v.mutedKinds !== undefined, {
    message: "Send at least one preference to change.",
  })
  .meta({ id: "UpdateNotificationPreferences" });
export type UpdateNotificationPreferences = z.infer<typeof UpdateNotificationPreferences>;

// ===== Reminder rules (Q-133; BACKEND_PLAN §5.2) =====
export const REMINDER_CHANNELS = ["email", "push"] as const;
export const ReminderChannel = z.enum(REMINDER_CHANNELS);

/** Whole days before the due date; 0 = the day itself. */
export const MAX_REMINDER_OFFSET_DAYS = 60;
export const MAX_REMINDER_OFFSETS = 6;

export const ReminderRule = z
  .object({
    /** Days before the due date at which to remind: 0 to 60, whole numbers, no repeats, at most 6. */
    offsetsDays: z
      .array(z.number().int().min(0).max(MAX_REMINDER_OFFSET_DAYS))
      .min(1)
      .max(MAX_REMINDER_OFFSETS)
      .refine((a) => new Set(a).size === a.length, { message: "Offsets must not repeat." }),
    channels: z
      .array(ReminderChannel)
      .min(1)
      .max(REMINDER_CHANNELS.length)
      .refine((a) => new Set(a).size === a.length, { message: "Channels must not repeat." }),
    alsoNotifyPartner: z.boolean(),
  })
  .strict()
  .meta({ id: "ReminderRule" });
export type ReminderRule = z.infer<typeof ReminderRule>;

/** The built-in default when a household has no rule of its own. */
export const BUILT_IN_REMINDER_RULE: ReminderRule = {
  offsetsDays: [3, 0],
  channels: ["email"],
  alsoNotifyPartner: false,
};

export const ItemReminderParams = HouseholdParams.extend({ id: Uuid });

/**
 * One item's own rule: the body of `PUT /items/:id/reminders` and the response of both verbs. `null` means the
 * item follows the household default (as a PUT body it removes the override).
 */
export const ItemReminderRule = ReminderRule.nullable().meta({ id: "ItemReminderRule" });
export type ItemReminderRule = z.infer<typeof ItemReminderRule>;
