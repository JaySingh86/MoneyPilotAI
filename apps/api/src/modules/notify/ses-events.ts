// POST /webhooks/ses-events: SES Delivery, Bounce and Complaint events arriving through SNS (BACKEND_PLAN §7.6,
// §8.4). Order of work: verify the SNS signature and topic → follow a subscription confirmation → record the SNS
// MessageId in `webhook_events` (so a redelivery does nothing) → apply the event with
// `app_record_delivery_event()` in the same transaction. Nothing from the payload is trusted before the
// signature check, and nothing is logged: bodies carry recipient addresses.
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@mp/contracts";
import type { ApiDb } from "@mp/db";
import { rawBody } from "../../plugins/raw-body";
import { parseJsonSafely } from "../../lib/json";
import { trustedSubscribeUrl, verifySnsMessage, type CertificateLoader } from "../../lib/webhooks";

export interface SesEventsDeps {
  db: ApiDb;
  /** SNS topic ARNs we accept (one per SES configuration set). Empty = nothing is accepted. */
  allowedTopicArns: readonly string[];
  /** Our AWS region; the topic must be in it. */
  region?: string | undefined;
  loadCertificate: CertificateLoader;
  /** GET the subscription URL once (SNS confirmation). Injected so tests never reach AWS. */
  confirmSubscription: (url: string) => Promise<void>;
  nowMs?: () => number;
}

/** The part of an SES event we read. Config-set events use `eventType`, the older notifications `notificationType`. */
const SesEvent = z.object({
  eventType: z.string().max(40).optional(),
  notificationType: z.string().max(40).optional(),
  mail: z.object({ messageId: z.string().min(1).max(200) }),
  bounce: z.object({ bounceType: z.string().max(40).optional() }).optional(),
});

/** Coarse per-IP budget; SNS delivers from AWS addresses and a redelivery is deduplicated by MessageId. */
export const SES_EVENTS_PER_MINUTE = 60;
/** SES events may arrive late after an SNS retry; replay is blocked by the `webhook_events` dedupe. */
export const SES_EVENTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const EVENT_NAMES: Record<string, "delivery" | "bounce" | "complaint"> = {
  delivery: "delivery",
  bounce: "bounce",
  complaint: "complaint",
};

const Response = z.object({
  status: z.enum(["applied", "unknown", "ignored", "duplicate", "confirmed"]),
});

export function sesEventsRoutes(deps: () => SesEventsDeps): FastifyPluginAsyncZod {
  return async (scope) => {
    await scope.register(rawBody);
    scope.post(
      "/ses-events",
      {
        schema: { response: { 200: Response } },
        config: { rateLimit: { max: SES_EVENTS_PER_MINUTE, timeWindow: "1 minute" }, idempotency: "off" },
      },
      async (request) => {
        const d = deps();
        const message = await verifySnsMessage(request.body, {
          allowedTopicArns: d.allowedTopicArns,
          ...(d.region ? { region: d.region } : {}),
          loadCertificate: d.loadCertificate,
          maxAgeMs: SES_EVENTS_MAX_AGE_MS,
          ...(d.nowMs ? { nowMs: d.nowMs() } : {}),
        });

        if (message.Type === "SubscriptionConfirmation") {
          await d.confirmSubscription(
            trustedSubscribeUrl(message, {
              allowedTopicArns: d.allowedTopicArns,
              ...(d.region ? { region: d.region } : {}),
            }),
          );
          return { status: "confirmed" as const };
        }
        if (message.Type !== "Notification") return { status: "ignored" as const };

        let event: z.infer<typeof SesEvent>;
        try {
          event = SesEvent.parse(parseJsonSafely(message.Message));
        } catch {
          // Signed by SNS but not an SES event (for example a test publish): nothing to apply.
          return { status: "ignored" as const };
        }
        const name = EVENT_NAMES[(event.eventType ?? event.notificationType ?? "").toLowerCase()];
        if (!name) return { status: "ignored" as const };

        try {
          return await d.db.withHouseholdTx({ userId: null }, async (tx) => {
            const seen = await tx.execute(sql`insert into webhook_events (provider, event_id)
              values ('ses', ${message.MessageId}) on conflict do nothing`);
            if ((seen.rowCount ?? 0) === 0) return { status: "duplicate" as const };
            const res = await tx.execute<{ outcome: "applied" | "unknown" | "ignored" }>(
              sql`select app_record_delivery_event(${event.mail.messageId}, ${name}, ${event.bounce?.bounceType ?? null}) as outcome`,
            );
            await tx.execute(
              sql`update webhook_events set processed_at = now() where provider = 'ses' and event_id = ${message.MessageId}`,
            );
            return { status: res.rows[0]?.outcome ?? ("ignored" as const) };
          });
        } catch (err) {
          if (err instanceof AppError) throw err;
          // A 500 makes SNS redeliver; the transaction rolled back, so the retry starts clean.
          throw new AppError("internal_error", 500, "The event could not be recorded.", { cause: err });
        }
      },
    );
  };
}
