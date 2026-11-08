// Job `notifications.dispatch` (BACKEND_PLAN §7.6, §9; ARCHITECTURE §4.4): every minute. A sweep asks which
// households have something due (`app_list_households_with_due_notifications()`, ids only) and enqueues one job
// each; the job claims up to 100 due rows with FOR UPDATE SKIP LOCKED, sends the email, and records the result.
//
// Claim, mark, send, record are separate steps so a slow mail server never holds a database transaction:
//   1. claim:  lease the rows (`attempt_at` = now + 5 min) and return them; two workers never get the same row,
//              and a crash after the claim only delays the retry until the lease ends. Each claim counts in
//              `claim_attempts`; a row claimed 5 times without finishing is marked `failed` (poison row);
//   2. mark:   a `queued` delivery row is committed BEFORE the provider is called;
//   3. send:   per row, outside any transaction (the lease protects it);
//   4. record: the provider message id and `sent`, or a retry at 1 min, 5 min, 30 min, 2 h, then `failed`.
// If a run dies between 3 and 4, the next claim finds a `queued` delivery with no provider id and no error: the
// outcome is unknown, so it is NOT sent again (no duplicate email). It is marked `failed` (`send:unresolved`),
// which the Notifications screen shows as a failed delivery. A delivery that already has a provider id is
// simply marked `sent`.
// A reminder is checked against the live occurrence just before it goes out (still scheduled, same due date,
// bill still active): paying or moving it cancels the reminder even if the 15-minute planner has not run yet.
//
// What the email says comes from the notification row (title and body built when it was created); the job
// payload is a household id. Nothing here logs an address, a title or an amount: only counts and error codes.
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { Tx, WorkerDb } from "@mp/db";
import {
  EmailSendError,
  MUTABLE_KINDS,
  renderNotificationEmail,
  toMessage,
  type EmailSender,
} from "@mp/notify";
import type { JobSender } from "../plan/recompute";

export const NOTIFICATIONS_DISPATCH_QUEUE = "notifications.dispatch";
export const NOTIFICATIONS_SWEEP_QUEUE = "notifications.sweep";
/** Every minute. */
export const NOTIFICATIONS_SWEEP_CRON = "* * * * *";
export const DISPATCH_BATCH = 100;
/** A row claimed this many times without finishing is a poison row and is marked `failed`. */
export const MAX_CLAIMS = 5;
/** How long a claimed row is ours before another run may take it. */
export const LEASE_SECONDS = 5 * 60;
/** Delay before retry 1, 2, 3 and 4 (BACKEND_PLAN §7.6). The fifth failure ends in `failed`. */
export const RETRY_DELAYS_SECONDS = [60, 5 * 60, 30 * 60, 2 * 60 * 60] as const;

export const NOTIFICATIONS_DISPATCH_QUEUE_OPTIONS = {
  policy: "short",
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
} as const;

export const NotificationsDispatchJob = z.object({ householdId: z.uuid() });
export type NotificationsDispatchJob = z.infer<typeof NotificationsDispatchJob>;

export function notificationsDispatchSingletonKey(job: NotificationsDispatchJob): string {
  return `${NOTIFICATIONS_DISPATCH_QUEUE}:${job.householdId}`;
}

export interface NotificationsSweepDeps {
  db: WorkerDb;
  sender: JobSender;
}

export async function handleNotificationsSweep(
  deps: NotificationsSweepDeps,
): Promise<{ households: number; enqueued: number }> {
  const ids = await deps.db.listHouseholdIdsWithDueNotifications();
  let enqueued = 0;
  for (const householdId of ids) {
    const job = NotificationsDispatchJob.parse({ householdId });
    const id = await deps.sender.send(NOTIFICATIONS_DISPATCH_QUEUE, job, {
      singletonKey: notificationsDispatchSingletonKey(job),
    });
    if (id !== null) enqueued++;
  }
  return { households: ids.length, enqueued };
}

export interface DispatchDeps {
  db: WorkerDb;
  /** UTC instant as ISO 8601. */
  now: () => string;
  email: EmailSender;
  /** The web app origin that email links point to. */
  appUrl: string;
}

export interface DispatchResult {
  claimed: number;
  sent: number;
  inAppOnly: number;
  cancelled: number;
  retried: number;
  failed: number;
  /** Rows that threw outside the send (database error); they come back when the lease ends. */
  errored: number;
}

interface Claimed extends Record<string, unknown> {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  deep_link: string | null;
  item_id: string | null;
  scheduled_on: string | null;
  due_on: string | null;
}

/** Leases the due rows. `FOR UPDATE SKIP LOCKED` keeps concurrent runs apart. */
export async function claimDue(tx: Tx, householdId: string, nowIso: string): Promise<Claimed[]> {
  const res = await tx.execute<Claimed>(sql`with due as (
      select id from notifications
       where household_id = ${householdId} and status = 'scheduled'
         and coalesce(attempt_at, send_at) <= ${nowIso}::timestamptz
       order by coalesce(attempt_at, send_at), id
       limit ${DISPATCH_BATCH}
       for update skip locked)
    update notifications n set attempt_at = ${nowIso}::timestamptz + make_interval(secs => ${LEASE_SECONDS}),
      claim_attempts = n.claim_attempts + 1
      from due where n.id = due.id
    returning n.id, n.user_id, n.kind, n.title, n.body, n.deep_link, n.item_id,
              n.scheduled_on::text as scheduled_on, n.due_on::text as due_on`);
  return res.rows;
}

/** Marks due rows that were claimed too often without finishing as failed. Returns how many. */
export async function failPoisoned(tx: Tx, householdId: string, nowIso: string): Promise<number> {
  const res = await tx.execute(sql`update notifications set status = 'failed', attempt_at = null
    where household_id = ${householdId} and status = 'scheduled' and claim_attempts >= ${MAX_CLAIMS}
      and coalesce(attempt_at, send_at) <= ${nowIso}::timestamptz`);
  return res.rowCount ?? 0;
}

type Decision =
  | { action: "cancel" }
  | { action: "in_app" }
  | { action: "already_sent" }
  | { action: "unresolved"; attempts: number }
  | { action: "email"; to: string; attempts: number };

/** Re-checks a claimed row against the world and decides what to do with it. */
async function decide(tx: Tx, householdId: string, n: Claimed): Promise<Decision> {
  const priorRes = await tx.execute<{
    attempts: number;
    provider_message_id: string | null;
    status: string;
    last_error: string | null;
  }>(sql`select attempts, provider_message_id, status, last_error from notification_deliveries
    where notification_id = ${n.id} and channel = 'email'`);
  const prior = priorRes.rows[0];
  if (prior?.provider_message_id) return { action: "already_sent" };
  if (prior && prior.status === "queued" && prior.last_error === null) {
    return { action: "unresolved", attempts: prior.attempts };
  }
  if (n.kind === "reminder" && n.item_id && n.scheduled_on) {
    const live = await tx.execute<{
      ok: boolean;
    }>(sql`select (o.status = 'scheduled' and o.due_on = ${n.due_on}::date
          and i.status = 'active' and i.deleted_at is null) as ok
        from occurrences o join recurring_items i on i.id = o.item_id and i.household_id = o.household_id
       where o.household_id = ${householdId} and o.item_id = ${n.item_id} and o.scheduled_on = ${n.scheduled_on}::date`);
    if (live.rows[0]?.ok !== true) return { action: "cancel" };
  }
  const who = await tx.execute<{
    email: string;
    active: boolean;
    email_enabled: boolean | null;
    suppressed: boolean | null;
    muted_kinds: string[] | null;
  }>(sql`select u.email::text as email, (u.deleted_at is null and m.left_at is null) as active,
        p.email_enabled, (p.email_suppressed_at is not null) as suppressed, p.muted_kinds
      from users u
      join household_members m on m.user_id = u.id and m.household_id = ${householdId}
      left join notification_preferences p on p.user_id = u.id
     where u.id = ${n.user_id}`);
  const w = who.rows[0];
  if (!w || !w.active) return { action: "in_app" };
  const muted =
    (MUTABLE_KINDS as readonly string[]).includes(n.kind) && (w.muted_kinds ?? []).includes(n.kind);
  if (w.email_enabled === false || w.suppressed === true || muted) return { action: "in_app" };
  if (n.kind === "reminder") {
    const rule = await tx.execute<{ channels: string[] }>(sql`select channels from reminder_rules
      where household_id = ${householdId} and (item_id = ${n.item_id} or item_id is null)
      order by (item_id is null) limit 1`);
    const channels = rule.rows[0]?.channels ?? ["email"];
    if (!channels.includes("email")) return { action: "in_app" };
  }
  return { action: "email", to: w.email, attempts: prior?.attempts ?? 0 };
}

async function setStatus(tx: Tx, id: string, status: "sent" | "cancelled" | "failed"): Promise<void> {
  await tx.execute(sql`update notifications set status = ${status}, attempt_at = null where id = ${id}`);
}

async function recordDelivery(
  tx: Tx,
  householdId: string,
  id: string,
  d: {
    status: "sent" | "queued" | "failed";
    providerMessageId?: string | undefined;
    attempts: number;
    error?: string | undefined;
  },
): Promise<void> {
  await tx.execute(sql`insert into notification_deliveries
      (id, household_id, notification_id, channel, provider_message_id, status, attempts, last_error)
    values (${crypto.randomUUID()}, ${householdId}, ${id}, 'email', ${d.providerMessageId ?? null}, ${d.status},
      ${d.attempts}, ${d.error ?? null})
    on conflict (notification_id, channel) do update set
      status = excluded.status, attempts = excluded.attempts, last_error = excluded.last_error,
      provider_message_id = coalesce(excluded.provider_message_id, notification_deliveries.provider_message_id)`);
}

export async function dispatchHousehold(deps: DispatchDeps, householdId: string): Promise<DispatchResult> {
  const result: DispatchResult = {
    claimed: 0,
    sent: 0,
    inAppOnly: 0,
    cancelled: 0,
    retried: 0,
    failed: 0,
    errored: 0,
  };
  const nowIso = deps.now();
  const claimed = await deps.db.withJobTx(householdId, async (tx) => {
    result.failed += await failPoisoned(tx, householdId, nowIso);
    return claimDue(tx, householdId, nowIso);
  });
  result.claimed = claimed.length;

  for (const n of claimed) {
    try {
      const decision = await deps.db.withJobTx(householdId, (tx) => decide(tx, householdId, n));
      if (decision.action === "cancel") {
        await deps.db.withJobTx(householdId, (tx) => setStatus(tx, n.id, "cancelled"));
        result.cancelled++;
        continue;
      }
      if (decision.action === "already_sent") {
        await deps.db.withJobTx(householdId, (tx) => setStatus(tx, n.id, "sent"));
        result.sent++;
        continue;
      }
      if (decision.action === "unresolved") {
        await deps.db.withJobTx(householdId, async (tx) => {
          await recordDelivery(tx, householdId, n.id, {
            status: "failed",
            attempts: decision.attempts,
            error: "send:unresolved",
          });
          await setStatus(tx, n.id, "failed");
        });
        result.failed++;
        continue;
      }
      if (decision.action === "in_app") {
        await deps.db.withJobTx(householdId, (tx) => setStatus(tx, n.id, "sent"));
        result.inAppOnly++;
        continue;
      }

      const attempts = decision.attempts + 1;
      // Committed before the provider is called, so a crash after the send is recognised on the next claim.
      await deps.db.withJobTx(householdId, (tx) =>
        recordDelivery(tx, householdId, n.id, { status: "queued", attempts }),
      );
      let sent: { providerMessageId: string } | null = null;
      let failure: EmailSendError | null = null;
      try {
        sent = await deps.email.send(
          toMessage(
            decision.to,
            renderNotificationEmail({
              kind: n.kind,
              title: n.title,
              body: n.body,
              deepLink: n.deep_link,
              appUrl: deps.appUrl,
            }),
          ),
        );
      } catch (err) {
        // An unclassified error is treated as retryable; its message is dropped (it can quote the address).
        failure = err instanceof EmailSendError ? err : new EmailSendError("send:unknown", true);
      }

      await deps.db.withJobTx(householdId, async (tx) => {
        if (sent) {
          await recordDelivery(tx, householdId, n.id, {
            status: "sent",
            providerMessageId: sent.providerMessageId,
            attempts,
          });
          await setStatus(tx, n.id, "sent");
          result.sent++;
        } else if (failure && failure.retryable && attempts <= RETRY_DELAYS_SECONDS.length) {
          const delay =
            RETRY_DELAYS_SECONDS[attempts - 1] ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1] ?? 60;
          await recordDelivery(tx, householdId, n.id, { status: "queued", attempts, error: failure.code });
          await tx.execute(sql`update notifications
            set attempt_at = ${nowIso}::timestamptz + make_interval(secs => ${delay}) where id = ${n.id}`);
          result.retried++;
        } else {
          await recordDelivery(tx, householdId, n.id, {
            status: "failed",
            attempts,
            error: failure?.code ?? "send:unknown",
          });
          await setStatus(tx, n.id, "failed");
          result.failed++;
        }
      });
    } catch {
      // The lease expires and the row is tried again; the cause was logged by the job guard's caller as a count.
      result.errored++;
    }
  }
  return result;
}

export async function handleNotificationsDispatch(
  deps: DispatchDeps,
  data: unknown,
): Promise<DispatchResult> {
  const job = NotificationsDispatchJob.parse(data);
  return dispatchHousehold(deps, job.householdId);
}
