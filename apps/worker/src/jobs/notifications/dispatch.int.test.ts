// notifications.dispatch against a real Postgres (RLS as mp_worker) with the fake email sender: sends once,
// retries at 1 min / 5 min / 30 min / 2 h then fails, respects preferences, re-checks reminders against the live
// occurrence, claims with SKIP LOCKED, and never lets a name or amount reach a subject or a log.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createWorkerDb, type WorkerDb } from "@mp/db";
import { EmailSendError } from "@mp/notify";
import { FakeEmailSender } from "@mp/notify/testing";
import { createFixtures, type Fixtures, type TestHousehold } from "../../testing/notify-fixtures";
import { handleRemindersPlan } from "../reminders/plan";
import {
  LEASE_SECONDS,
  RETRY_DELAYS_SECONDS,
  dispatchHousehold,
  handleNotificationsDispatch,
  handleNotificationsSweep,
} from "./dispatch";

let fx: Fixtures;
let worker: WorkerDb;
const APP = "https://app.example.test";

beforeAll(async () => {
  fx = await createFixtures();
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 6 });
}, 120_000);
afterAll(async () => {
  await worker?.close();
  await fx?.close();
});

const NOW = "2026-11-03T15:00:00Z";
const at = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();

function deps(email: FakeEmailSender, now: string) {
  return { db: worker, now: () => now, email, appUrl: APP };
}

async function notice(
  hh: TestHousehold,
  userId: string,
  extra: { kind?: string; title?: string; body?: string; sendAt?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await fx.query(
    `insert into notifications (id, household_id, user_id, kind, dedupe_key, title, body, deep_link, send_at)
     values ($1, $2, $3, $4, $5, $6, $7, '/tasks', $8)`,
    [
      id,
      hh.id,
      userId,
      extra.kind ?? "proposal",
      `t:${id}`,
      extra.title ?? "Sam asked you to approve a change",
      extra.body ?? "Open MoneyPilot to see what changes.",
      extra.sendAt ?? "2026-11-03T14:00:00Z",
    ],
  );
  return id;
}

const state = async (id: string) =>
  (
    await fx.query<{
      status: string;
      attempt_at: string | null;
      d_status: string | null;
      attempts: number | null;
      last_error: string | null;
      provider: string | null;
    }>(
      `select n.status, to_char(n.attempt_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as attempt_at,
              d.status as d_status, d.attempts, d.last_error, d.provider_message_id as provider
         from notifications n left join notification_deliveries d on d.notification_id = n.id
        where n.id = $1`,
      [id],
    )
  )[0];

describe("notifications.dispatch: sending", () => {
  it("emails a due notification once and records the delivery", async () => {
    const hh = await fx.household();
    const id = await notice(hh, hh.jordan.id);
    const email = new FakeEmailSender();
    const first = await dispatchHousehold(deps(email, NOW), hh.id);
    expect(first).toMatchObject({ claimed: 1, sent: 1 });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({
      to: hh.jordan.email,
      subject: "Sam asked you to approve a change",
    });
    expect(email.sent[0]?.text).toContain(`${APP}/tasks`);
    expect(await state(id)).toMatchObject({
      status: "sent",
      d_status: "sent",
      attempts: 1,
      provider: email.sent[0]?.providerMessageId,
    });
    // nothing left to do
    expect(await dispatchHousehold(deps(email, NOW), hh.id)).toMatchObject({ claimed: 0 });
    expect(email.sent).toHaveLength(1);
  });

  it("leaves future notifications alone", async () => {
    const hh = await fx.household();
    const id = await notice(hh, hh.jordan.id, { sendAt: "2026-11-03T16:00:00Z" });
    const email = new FakeEmailSender();
    expect(await dispatchHousehold(deps(email, NOW), hh.id)).toMatchObject({ claimed: 0 });
    expect((await state(id))?.status).toBe("scheduled");
    expect(await dispatchHousehold(deps(email, "2026-11-03T16:00:01Z"), hh.id)).toMatchObject({ sent: 1 });
  });

  it("escapes user text in the HTML and keeps line breaks out of the subject", async () => {
    const hh = await fx.household();
    await notice(hh, hh.jordan.id, {
      title: "<script>alert(1)</script>\r\nBcc: evil@example.test",
      body: `<img src=x onerror=alert(1)> & "quotes"`,
    });
    const email = new FakeEmailSender();
    await dispatchHousehold(deps(email, NOW), hh.id);
    const mail = email.sent[0];
    expect(mail?.html).not.toContain("<script>");
    expect(mail?.html).not.toContain("<img");
    expect(mail?.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(mail?.subject).not.toMatch(/[\r\n]/);
  });

  it("a reminder's subject has no amount, its body does", async () => {
    const hh = await fx.household();
    await fx.bill(hh, { scheduledOn: "2026-11-06", name: "Rent" });
    await handleRemindersPlan({ db: worker, now: () => NOW }, { householdId: hh.id });
    const email = new FakeEmailSender();
    // the 3-day reminder is due at 14:00Z; the 0-day one on Nov 6
    const result = await dispatchHousehold(deps(email, NOW), hh.id);
    expect(result.sent).toBe(1);
    expect(email.sent[0]?.subject).toBe("Rent is due in 3 days");
    expect(email.sent[0]?.subject).not.toMatch(/\$/);
    expect(email.sent[0]?.text).toContain("$2,150.00");
    expect(email.sent[0]?.text).toContain("Mark it as paid");
    expect(`${email.sent[0]?.subject}${email.sent[0]?.text}`).not.toMatch(/\bPay now\b/i);
  });
});

describe("notifications.dispatch: retries", () => {
  it("retries at 1 min, 5 min, 30 min and 2 h, then marks the notification failed", async () => {
    const hh = await fx.household();
    const id = await notice(hh, hh.jordan.id);
    const email = new FakeEmailSender();
    email.failNext(...Array.from({ length: 5 }, () => new EmailSendError("ses:ThrottlingException", true)));
    let now = NOW;
    for (let attempt = 1; attempt <= RETRY_DELAYS_SECONDS.length; attempt++) {
      const result = await dispatchHousehold(deps(email, now), hh.id);
      expect(result.retried, `attempt ${attempt}`).toBe(1);
      const s = await state(id);
      const delay = RETRY_DELAYS_SECONDS[attempt - 1] as number;
      expect(s).toMatchObject({
        status: "scheduled",
        d_status: "queued",
        attempts: attempt,
        last_error: "ses:ThrottlingException",
      });
      expect(s?.attempt_at).toBe(at(now, delay).replace(".000Z", "Z"));
      // not before it is due
      expect((await dispatchHousehold(deps(email, at(now, delay - 1)), hh.id)).claimed).toBe(0);
      now = at(now, delay);
    }
    expect([60, 300, 1800, 7200]).toEqual([...RETRY_DELAYS_SECONDS]);
    const last = await dispatchHousehold(deps(email, now), hh.id);
    expect(last).toMatchObject({ failed: 1, retried: 0 });
    expect(await state(id)).toMatchObject({ status: "failed", d_status: "failed", attempts: 5 });
    expect(email.sent).toHaveLength(0);
  });

  it("succeeds on a later try without sending twice", async () => {
    const hh = await fx.household();
    const id = await notice(hh, hh.jordan.id);
    const email = new FakeEmailSender();
    email.failNext(new EmailSendError("smtp:ECONNREFUSED", true));
    await dispatchHousehold(deps(email, NOW), hh.id);
    await dispatchHousehold(deps(email, at(NOW, 61)), hh.id);
    expect(email.sent).toHaveLength(1);
    expect(await state(id)).toMatchObject({
      status: "sent",
      d_status: "sent",
      attempts: 2,
      last_error: null,
    });
  });

  it("a rejected message fails at once; an unclassified error is retried and its text is not stored", async () => {
    const hh = await fx.household();
    const rejected = await notice(hh, hh.jordan.id);
    const email = new FakeEmailSender();
    email.failNext(new EmailSendError("ses:MessageRejected", false));
    await dispatchHousehold(deps(email, NOW), hh.id);
    expect(await state(rejected)).toMatchObject({
      status: "failed",
      d_status: "failed",
      last_error: "ses:MessageRejected",
    });

    const odd = await notice(hh, hh.jordan.id);
    const flaky = {
      async send(): Promise<never> {
        throw new Error("550 jordan@example.test mailbox unavailable");
      },
    };
    await dispatchHousehold({ ...deps(email, NOW), email: flaky }, hh.id);
    const s = await state(odd);
    expect(s).toMatchObject({ status: "scheduled", d_status: "queued", last_error: "send:unknown" });
    expect(JSON.stringify(s)).not.toContain("jordan@");
  });
});

describe("notifications.dispatch: crash safety (security review)", () => {
  it("records a queued delivery before the provider is called, then the provider id after", async () => {
    const hh = await fx.household();
    const id = await notice(hh, hh.jordan.id);
    let seenDuringSend: Awaited<ReturnType<typeof state>>;
    const email = new FakeEmailSender();
    const send = email.send.bind(email);
    email.send = async (m) => {
      seenDuringSend = await state(id);
      return send(m);
    };
    await dispatchHousehold(deps(email, NOW), hh.id);
    expect(seenDuringSend).toMatchObject({ d_status: "queued", attempts: 1, provider: null });
    expect(await state(id)).toMatchObject({
      status: "sent",
      d_status: "sent",
      provider: email.sent[0]?.providerMessageId,
    });
  });

  it("a crash after the send and before recording does not send a duplicate on the next run", async () => {
    const hh = await fx.household();
    const id = await notice(hh, hh.jordan.id);
    const email = new FakeEmailSender();
    // the provider accepts the mail, then the process "dies": every later database step of this run fails
    let crashed = false;
    const send = email.send.bind(email);
    email.send = async (m) => {
      const r = await send(m);
      crashed = true;
      return r;
    };
    const crashing = {
      ...worker,
      withJobTx: ((hid: string, fn: never) => {
        if (crashed) return Promise.reject(new Error("process died"));
        return worker.withJobTx(hid, fn);
      }) as WorkerDb["withJobTx"],
    } as WorkerDb;
    const first = await dispatchHousehold({ db: crashing, now: () => NOW, email, appUrl: APP }, hh.id);
    expect(first.errored).toBe(1);
    expect(email.sent).toHaveLength(1);
    // after the lease the row is claimed again: it must not be sent again
    const next = await dispatchHousehold(deps(email, at(NOW, LEASE_SECONDS + 1)), hh.id);
    expect(next.sent).toBe(0);
    expect(email.sent).toHaveLength(1);
    expect(await state(id)).toMatchObject({
      status: "failed",
      d_status: "failed",
      last_error: "send:unresolved",
    });
  });

  it("a row whose delivery already has a provider id is marked sent without another send", async () => {
    const hh = await fx.household();
    const id = await notice(hh, hh.jordan.id);
    await fx.query(
      `insert into notification_deliveries (household_id, notification_id, channel, provider_message_id, status, attempts)
       values ($1, $2, 'email', $3, 'sent', 1)`,
      [hh.id, id, `ses-${randomUUID()}`],
    );
    const email = new FakeEmailSender();
    await dispatchHousehold(deps(email, NOW), hh.id);
    expect(email.sent).toHaveLength(0);
    expect((await state(id))?.status).toBe("sent");
  });

  it("a poison row is marked failed after 5 claims instead of looping forever", async () => {
    const hh = await fx.household();
    const id = await notice(hh, hh.jordan.id);
    const email = new FakeEmailSender();
    // every run claims it and then dies before recording (a lease expiry each time)
    for (let n = 0; n < 5; n++) {
      await worker.withJobTx(hh.id, async (tx) => {
        const { claimDue } = await import("./dispatch");
        expect(await claimDue(tx, hh.id, at(NOW, n * (LEASE_SECONDS + 1)))).toHaveLength(1);
      });
    }
    const last = await dispatchHousehold(deps(email, at(NOW, 5 * (LEASE_SECONDS + 1))), hh.id);
    expect(last.sent).toBe(0);
    expect(last.failed).toBe(1);
    expect(email.sent).toHaveLength(0);
    expect((await state(id))?.status).toBe("failed");
  });
});

describe("notifications.dispatch: who gets an email", () => {
  it("not when the person turned email off, muted the kind, or was suppressed after a bounce; the notice stays in the app", async () => {
    const hh = await fx.household();
    const email = new FakeEmailSender();
    await fx.query(`insert into notification_preferences (user_id, email_enabled) values ($1, false)`, [
      hh.jordan.id,
    ]);
    const off = await notice(hh, hh.jordan.id);
    await fx.query(`insert into notification_preferences (user_id, muted_kinds) values ($1, '{task}')`, [
      hh.sam.id,
    ]);
    const muted = await notice(hh, hh.sam.id, { kind: "task" });
    const result = await dispatchHousehold(deps(email, NOW), hh.id);
    expect(result).toMatchObject({ claimed: 2, inAppOnly: 2, sent: 0 });
    expect(email.sent).toHaveLength(0);
    expect((await state(off))?.status).toBe("sent");
    expect((await state(muted))?.status).toBe("sent");
    expect((await state(muted))?.d_status).toBeNull();

    const hh2 = await fx.household();
    await fx.query(
      `insert into notification_preferences (user_id, email_suppressed_at, email_suppressed_reason) values ($1, now(), 'hard_bounce')`,
      [hh2.jordan.id],
    );
    await notice(hh2, hh2.jordan.id);
    expect((await dispatchHousehold(deps(email, NOW), hh2.id)).inAppOnly).toBe(1);
    expect(email.sent).toHaveLength(0);
  });

  it("essential kinds can't be muted: a proposal still goes out", async () => {
    const hh = await fx.household();
    await fx.query(
      `insert into notification_preferences (user_id, muted_kinds) values ($1, '{reminder,review,task,digest}')`,
      [hh.jordan.id],
    );
    await notice(hh, hh.jordan.id, { kind: "proposal" });
    const email = new FakeEmailSender();
    expect((await dispatchHousehold(deps(email, NOW), hh.id)).sent).toBe(1);
  });

  it("a reminder rule without the email channel keeps the reminder in the app", async () => {
    const hh = await fx.household();
    await fx.bill(hh, { scheduledOn: "2026-11-06" });
    await fx.query(`insert into reminder_rules (household_id, channels) values ($1, '{push}')`, [hh.id]);
    await handleRemindersPlan({ db: worker, now: () => NOW }, { householdId: hh.id });
    const email = new FakeEmailSender();
    expect(await dispatchHousehold(deps(email, NOW), hh.id)).toMatchObject({ inAppOnly: 1, sent: 0 });
  });
});

describe("notifications.dispatch: reminders are re-checked at send time", () => {
  it("a bill paid after planning is not reminded about, even before the planner re-runs", async () => {
    const hh = await fx.household();
    const bill = await fx.bill(hh, { scheduledOn: "2026-11-06" });
    await handleRemindersPlan({ db: worker, now: () => NOW }, { householdId: hh.id });
    await fx.query(`update occurrences set status = 'paid', paid_on = '2026-11-03' where id = $1`, [
      bill.occurrenceId,
    ]);
    const email = new FakeEmailSender();
    expect(await dispatchHousehold(deps(email, NOW), hh.id)).toMatchObject({
      claimed: 1,
      cancelled: 1,
      sent: 0,
    });
    expect(email.sent).toHaveLength(0);
  });

  it("a bill moved after planning is cancelled for now; the planner then re-plans it for the new date", async () => {
    const hh = await fx.household();
    const bill = await fx.bill(hh, { scheduledOn: "2026-11-06" });
    await handleRemindersPlan({ db: worker, now: () => NOW }, { householdId: hh.id });
    await fx.query(`update occurrences set due_on = '2026-11-10' where id = $1`, [bill.occurrenceId]);
    const email = new FakeEmailSender();
    expect((await dispatchHousehold(deps(email, NOW), hh.id)).cancelled).toBe(1);
    await handleRemindersPlan({ db: worker, now: () => at(NOW, 900) }, { householdId: hh.id });
    const rows = await fx.query<{ status: string; offset_days: number; due_on: string }>(
      `select status, offset_days, due_on::text from notifications where item_id = $1 order by offset_days desc`,
      [bill.itemId],
    );
    expect(rows).toEqual([
      { status: "scheduled", offset_days: 3, due_on: "2026-11-10" },
      { status: "scheduled", offset_days: 0, due_on: "2026-11-10" },
    ]);
    expect(email.sent).toHaveLength(0);
  });
});

describe("notifications.dispatch: claiming", () => {
  it("two dispatchers at once send each notification exactly once", async () => {
    const hh = await fx.household();
    for (let i = 0; i < 12; i++) await notice(hh, i % 2 ? hh.jordan.id : hh.sam.id);
    const email = new FakeEmailSender();
    const results = await Promise.all([
      dispatchHousehold(deps(email, NOW), hh.id),
      dispatchHousehold(deps(email, NOW), hh.id),
      dispatchHousehold(deps(email, NOW), hh.id),
    ]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(12);
    expect(email.sent).toHaveLength(12);
    expect(new Set(email.sent.map((m) => `${m.to}|${m.providerMessageId}`)).size).toBe(12);
  });

  it("takes at most 100 per run, oldest first", async () => {
    const hh = await fx.household();
    for (let i = 0; i < 105; i++) await notice(hh, hh.jordan.id);
    const email = new FakeEmailSender();
    expect((await dispatchHousehold(deps(email, NOW), hh.id)).claimed).toBe(100);
    expect((await dispatchHousehold(deps(email, NOW), hh.id)).claimed).toBe(5);
  });

  it("a claimed row is leased: a crashed run's notification is picked up again only after the lease", async () => {
    const hh = await fx.household();
    const id = await notice(hh, hh.jordan.id);
    // simulate a run that claimed it and died before recording anything
    await worker.withJobTx(hh.id, async (tx) => {
      const { claimDue } = await import("./dispatch");
      expect(await claimDue(tx, hh.id, NOW)).toHaveLength(1);
    });
    const email = new FakeEmailSender();
    expect((await dispatchHousehold(deps(email, at(NOW, LEASE_SECONDS - 1)), hh.id)).claimed).toBe(0);
    expect((await dispatchHousehold(deps(email, at(NOW, LEASE_SECONDS + 1)), hh.id)).sent).toBe(1);
    expect((await state(id))?.status).toBe("sent");
  });

  it("tenant scope: a run for one household never sends another's mail", async () => {
    const a = await fx.household();
    const b = await fx.household();
    await notice(a, a.jordan.id);
    const idB = await notice(b, b.jordan.id);
    const email = new FakeEmailSender();
    await dispatchHousehold(deps(email, NOW), a.id);
    expect(email.sent.map((m) => m.to)).toEqual([a.jordan.email]);
    expect((await state(idB))?.status).toBe("scheduled");
  });
});

describe("notifications.sweep and the job payload", () => {
  it("enqueues a dispatch job only for households with something due, carrying only the household id", async () => {
    const due = await fx.household();
    await notice(due, due.jordan.id);
    const idle = await fx.household();
    await notice(idle, idle.jordan.id, { sendAt: "2099-01-01T00:00:00Z" });
    const sent: Array<{ name: string; data: object }> = [];
    await handleNotificationsSweep({
      db: worker,
      sender: {
        async send(name, data) {
          sent.push({ name, data });
          return "job";
        },
      },
    });
    const ids = sent.map((s) => (s.data as { householdId: string }).householdId);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(idle.id);
    for (const s of sent) {
      expect(s.name).toBe("notifications.dispatch");
      expect(Object.keys(s.data)).toEqual(["householdId"]);
    }
  });

  it("rejects a malformed payload before touching the database", async () => {
    await expect(
      handleNotificationsDispatch(deps(new FakeEmailSender(), NOW), { householdId: "nope" }),
    ).rejects.toThrow();
  });
});
