// reminders.plan against a real Postgres (RLS as mp_worker): no duplicates on a re-run, 09:00 household-local send
// times across the Nov 1, 2026 DST change, recipients, and the cancel / move / re-plan behaviour.
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createWorkerDb, type WorkerDb } from "@mp/db";
import { createFixtures, type Fixtures, type TestHousehold } from "../../testing/notify-fixtures";
import { handleRemindersPlan, handleRemindersSweep, type PlanResult } from "./plan";

let fx: Fixtures;
let worker: WorkerDb;

beforeAll(async () => {
  fx = await createFixtures();
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 4 });
}, 120_000);
afterAll(async () => {
  await worker?.close();
  await fx?.close();
});

const plan = (hh: TestHousehold, now: string): Promise<PlanResult> =>
  handleRemindersPlan({ db: worker, now: () => now }, { householdId: hh.id });

interface Row extends Record<string, unknown> {
  user_id: string;
  item_id: string;
  offset_days: number;
  send_at: string;
  due_on: string;
  status: string;
  title: string;
  body: string;
  dedupe_key: string;
}

const rows = (hh: TestHousehold, itemId?: string) =>
  fx.query<Row>(
    `select user_id, item_id, offset_days, to_char(send_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as send_at,
            due_on::text as due_on, status, title, body, dedupe_key
       from notifications where household_id = $1 and kind = 'reminder' ${itemId ? "and item_id = $2" : ""}
      order by send_at, user_id`,
    itemId ? [hh.id, itemId] : [hh.id],
  );

describe("reminders.plan", () => {
  it("running it twice creates no duplicates", async () => {
    const hh = await fx.household();
    await fx.bill(hh, { scheduledOn: "2026-11-06" });
    const now = "2026-11-03T15:00:00Z";
    const first = await plan(hh, now);
    expect(first).toEqual({ created: 2, updated: 0, cancelled: 0 });
    const second = await plan(hh, now);
    expect(second).toEqual({ created: 0, updated: 0, cancelled: 0 });
    expect(await rows(hh)).toHaveLength(2);
  });

  it("two runs at once still leave one row per (item, date, offset, person)", async () => {
    const hh = await fx.household();
    await fx.bill(hh, { scheduledOn: "2026-11-06", owner: "both" });
    await Promise.all([plan(hh, "2026-11-03T15:00:00Z"), plan(hh, "2026-11-03T15:00:00Z")]);
    const all = await rows(hh);
    expect(all).toHaveLength(4); // offsets 3 and 0 × two people
    expect(new Set(all.map((r) => r.dedupe_key)).size).toBe(4);
  });

  it("sends at 09:00 household-local time across the Nov 1, 2026 DST change", async () => {
    const hh = await fx.household("America/New_York");
    const bill = await fx.bill(hh, { scheduledOn: "2026-11-02" });
    await fx.query(
      `insert into reminder_rules (household_id, item_id, offsets_days) values ($1, $2, '{3,1,0}')`,
      [hh.id, bill.itemId],
    );
    await plan(hh, "2026-10-28T12:00:00Z");
    const got = await rows(hh, bill.itemId);
    expect(got.map((r) => [r.offset_days, r.send_at])).toEqual([
      [3, "2026-10-30T13:00:00Z"], // Oct 30 09:00 EDT (UTC-4)
      [1, "2026-11-01T14:00:00Z"], // Nov 1 09:00 EST (UTC-5), after the clocks went back that morning
      [0, "2026-11-02T14:00:00Z"], // Nov 2 09:00 EST
    ]);
  });

  it("a bill due on Nov 1 itself: the day-of reminder is 09:00 EST, three days before is 09:00 EDT", async () => {
    const hh = await fx.household("America/New_York");
    const bill = await fx.bill(hh, { scheduledOn: "2026-11-01" });
    await plan(hh, "2026-10-28T12:00:00Z");
    expect((await rows(hh, bill.itemId)).map((r) => [r.offset_days, r.send_at])).toEqual([
      [3, "2026-10-29T13:00:00Z"],
      [0, "2026-11-01T14:00:00Z"],
    ]);
  });

  it("uses the household's zone, not the server's", async () => {
    const hh = await fx.household("America/Los_Angeles");
    const bill = await fx.bill(hh, { scheduledOn: "2026-11-01" });
    await plan(hh, "2026-10-28T12:00:00Z");
    expect((await rows(hh, bill.itemId)).map((r) => r.send_at)).toEqual([
      "2026-10-29T16:00:00Z", // 09:00 PDT
      "2026-11-01T17:00:00Z", // 09:00 PST
    ]);
  });

  it("goes to the owner, to both people for Both or Split, and to the partner when the rule asks", async () => {
    const hh = await fx.household();
    const sam = await fx.bill(hh, { scheduledOn: "2026-11-06", owner: "sam", name: "Sam's" });
    const split = await fx.bill(hh, { scheduledOn: "2026-11-06", owner: "split", name: "Split" });
    const both = await fx.bill(hh, { scheduledOn: "2026-11-06", owner: "both", name: "Both" });
    const alsoPartner = await fx.bill(hh, { scheduledOn: "2026-11-06", owner: "jordan", name: "Also" });
    await fx.query(
      `insert into reminder_rules (household_id, item_id, also_notify_partner) values ($1, $2, true)`,
      [hh.id, alsoPartner.itemId],
    );
    await plan(hh, "2026-11-03T15:00:00Z");
    const who = async (itemId: string) => [...new Set((await rows(hh, itemId)).map((r) => r.user_id))].sort();
    expect(await who(sam.itemId)).toEqual([hh.sam.id]);
    expect(await who(split.itemId)).toEqual([hh.sam.id, hh.jordan.id].sort());
    expect(await who(both.itemId)).toEqual([hh.sam.id, hh.jordan.id].sort());
    expect(await who(alsoPartner.itemId)).toEqual([hh.sam.id, hh.jordan.id].sort());
  });

  it("the household default rule applies to bills without their own", async () => {
    const hh = await fx.household();
    const bill = await fx.bill(hh, { scheduledOn: "2026-11-20" });
    await fx.query(`insert into reminder_rules (household_id, offsets_days) values ($1, '{7,0}')`, [hh.id]);
    await plan(hh, "2026-11-03T15:00:00Z");
    expect((await rows(hh, bill.itemId)).map((r) => r.offset_days)).toEqual([7, 0]);
  });

  it("yearly bills get 30, 7 and 0 days (DESIGN_SPEC rule 11)", async () => {
    const hh = await fx.household();
    const bill = await fx.bill(hh, {
      scheduledOn: "2026-12-05",
      rrule: "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=5",
    });
    await plan(hh, "2026-11-03T15:00:00Z");
    expect((await rows(hh, bill.itemId)).map((r) => r.offset_days)).toEqual([30, 7, 0]);
  });

  it("a monthly subscription gets no default reminders, not even from the household default (Q-134)", async () => {
    const hh = await fx.household();
    const sub = await fx.bill(hh, { scheduledOn: "2026-11-06", category: "subscription", name: "Music" });
    const rent = await fx.bill(hh, { scheduledOn: "2026-11-06" });
    await fx.query(`insert into reminder_rules (household_id, offsets_days) values ($1, '{7,0}')`, [hh.id]);
    await plan(hh, "2026-11-03T15:00:00Z");
    expect(await rows(hh, sub.itemId)).toHaveLength(0);
    expect((await rows(hh, rent.itemId)).length).toBeGreaterThan(0);
  });

  it("an item-level rule still applies to a monthly subscription; a yearly one keeps {30,7,0}", async () => {
    const hh = await fx.household();
    const sub = await fx.bill(hh, { scheduledOn: "2026-11-06", category: "subscription", name: "Music" });
    await fx.query(
      `insert into reminder_rules (household_id, item_id, offsets_days) values ($1, $2, '{1,0}')`,
      [hh.id, sub.itemId],
    );
    const yearly = await fx.bill(hh, {
      scheduledOn: "2026-12-05",
      category: "subscription",
      rrule: "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=5",
    });
    await plan(hh, "2026-11-03T15:00:00Z");
    expect((await rows(hh, sub.itemId)).map((r) => r.offset_days)).toEqual([1, 0]);
    expect((await rows(hh, yearly.itemId)).map((r) => r.offset_days)).toEqual([30, 7, 0]);
  });

  it("titles carry no amounts; bodies do, with 'Mark as paid' wording and no 'pay now'", async () => {
    const hh = await fx.household();
    const bill = await fx.bill(hh, { scheduledOn: "2026-11-06", name: "Rent" });
    await plan(hh, "2026-11-03T15:00:00Z");
    const [first] = await rows(hh, bill.itemId);
    expect(first?.title).toBe("Rent is due in 3 days");
    expect(first?.title).not.toMatch(/\$|\d{3}/);
    expect(first?.body).toBe(
      "Due Fri, Nov 6 · $2,150.00. Mark it as paid in MoneyPilot once you have paid it.",
    );
  });

  it("an estimated bill reads as an estimate until the actual arrives", async () => {
    const hh = await fx.household();
    const bill = await fx.bill(hh, {
      scheduledOn: "2026-11-06",
      amountType: "estimated",
      amountCents: 14200,
      name: "Power",
    });
    await plan(hh, "2026-11-03T15:00:00Z");
    expect((await rows(hh, bill.itemId))[0]?.body).toContain("~$142.00");
    await fx.query(`update occurrences set actual_amount_cents = 15710 where item_id = $1`, [bill.itemId]);
    const result = await plan(hh, "2026-11-03T15:20:00Z");
    expect(result.updated).toBe(2);
    expect((await rows(hh, bill.itemId))[0]?.body).toContain("$157.10");
    expect((await rows(hh, bill.itemId))[0]?.body).not.toContain("~");
  });

  it("skips income, paused bills, and reminders whose time is long past", async () => {
    const hh = await fx.household();
    await fx.bill(hh, { scheduledOn: "2026-11-06", direction: "inflow", name: "Paycheck" });
    const paused = await fx.bill(hh, { scheduledOn: "2026-11-06", name: "Paused" });
    await fx.query(`update recurring_items set status = 'paused' where id = $1`, [paused.itemId]);
    const late = await fx.bill(hh, { scheduledOn: "2026-11-06", name: "Late" });
    // 3 days before = Nov 3 14:00Z. At 17:30Z that is 3.5 h ago: skipped. The day-of reminder still comes.
    await plan(hh, "2026-11-03T17:30:00Z");
    expect(await rows(hh)).toHaveLength(1);
    expect((await rows(hh, late.itemId)).map((r) => r.offset_days)).toEqual([0]);
  });

  it("paying an occurrence cancels its future reminders; undoing the payment brings them back", async () => {
    const hh = await fx.household();
    const bill = await fx.bill(hh, { scheduledOn: "2026-11-06" });
    const now = "2026-11-03T15:00:00Z";
    await plan(hh, now);
    await fx.query(
      `update occurrences set status = 'paid', paid_on = '2026-11-03', marked_by = $2 where id = $1`,
      [bill.occurrenceId, hh.sam.id],
    );
    expect(await plan(hh, "2026-11-03T15:15:00Z")).toEqual({ created: 0, updated: 0, cancelled: 2 });
    expect((await rows(hh, bill.itemId)).map((r) => r.status)).toEqual(["cancelled", "cancelled"]);

    await fx.query(
      `update occurrences set status = 'scheduled', paid_on = null, marked_by = null where id = $1`,
      [bill.occurrenceId],
    );
    expect(await plan(hh, "2026-11-03T15:30:00Z")).toEqual({ created: 0, updated: 2, cancelled: 0 });
    expect((await rows(hh, bill.itemId)).map((r) => r.status)).toEqual(["scheduled", "scheduled"]);
  });

  it("moving an occurrence re-plans the same rows to the new date (no duplicates)", async () => {
    const hh = await fx.household();
    const bill = await fx.bill(hh, { scheduledOn: "2026-11-06" });
    await plan(hh, "2026-11-03T15:00:00Z");
    const before = await rows(hh, bill.itemId);
    await fx.query(`update occurrences set due_on = '2026-11-10' where id = $1`, [bill.occurrenceId]);
    expect(await plan(hh, "2026-11-03T15:15:00Z")).toEqual({ created: 0, updated: 2, cancelled: 0 });
    const after = await rows(hh, bill.itemId);
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.dedupe_key).sort()).toEqual(before.map((r) => r.dedupe_key).sort());
    expect(after.map((r) => [r.offset_days, r.send_at, r.due_on])).toEqual([
      [3, "2026-11-07T14:00:00Z", "2026-11-10"],
      [0, "2026-11-10T14:00:00Z", "2026-11-10"],
    ]);
    expect(after.every((r) => r.body.startsWith("Due Tue, Nov 10"))).toBe(true);
  });

  it("deleting the bill, or a rule that drops an offset, cancels what no longer applies", async () => {
    const hh = await fx.household();
    const gone = await fx.bill(hh, { scheduledOn: "2026-11-06", name: "Gone" });
    const trimmed = await fx.bill(hh, { scheduledOn: "2026-11-07", name: "Trimmed" });
    await plan(hh, "2026-11-03T15:00:00Z");
    await fx.query(`update recurring_items set deleted_at = now() where id = $1`, [gone.itemId]);
    await fx.query(
      `insert into reminder_rules (household_id, item_id, offsets_days) values ($1, $2, '{0}')`,
      [hh.id, trimmed.itemId],
    );
    const result = await plan(hh, "2026-11-03T15:15:00Z");
    expect(result.cancelled).toBe(3); // Gone ×2, Trimmed's 3-day reminder
    expect((await rows(hh, trimmed.itemId)).map((r) => [r.offset_days, r.status])).toEqual([
      [3, "cancelled"],
      [0, "scheduled"],
    ]);
  });

  it("history stays: a reminder already sent is not touched when the bill moves", async () => {
    const hh = await fx.household();
    const bill = await fx.bill(hh, { scheduledOn: "2026-11-06" });
    await plan(hh, "2026-11-03T15:00:00Z");
    await fx.query(`update notifications set status = 'sent' where item_id = $1 and offset_days = 3`, [
      bill.itemId,
    ]);
    await fx.query(`update occurrences set due_on = '2026-11-10' where id = $1`, [bill.occurrenceId]);
    await plan(hh, "2026-11-03T15:15:00Z");
    const after = await rows(hh, bill.itemId);
    expect(after.find((r) => r.offset_days === 3)).toMatchObject({ status: "sent", due_on: "2026-11-06" });
    expect(after.find((r) => r.offset_days === 0)).toMatchObject({
      status: "scheduled",
      due_on: "2026-11-10",
    });
  });

  it("only looks 35 days ahead", async () => {
    const hh = await fx.household();
    await fx.bill(hh, { scheduledOn: "2026-12-20" });
    expect(await plan(hh, "2026-11-03T15:00:00Z")).toEqual({ created: 0, updated: 0, cancelled: 0 });
  });

  it("plans a household that was deleted since the job was queued as a no-op", async () => {
    await expect(
      handleRemindersPlan(
        { db: worker, now: () => "2026-11-03T15:00:00Z" },
        { householdId: crypto.randomUUID() },
      ),
    ).resolves.toEqual({ created: 0, updated: 0, cancelled: 0 });
  });

  it("rejects a payload that is not just a household id before touching anything", async () => {
    await expect(
      handleRemindersPlan({ db: worker, now: () => "2026-11-03T15:00:00Z" }, { householdId: "nope" }),
    ).rejects.toThrow();
  });
});

describe("reminders.sweep", () => {
  it("enqueues one plan job per household, carrying only the household id", async () => {
    const sent: Array<{ name: string; data: object; options: object | undefined }> = [];
    const result = await handleRemindersSweep({
      db: worker,
      sender: {
        async send(name, data, options) {
          sent.push({ name, data, options });
          return "job";
        },
      },
    });
    expect(result.households).toBeGreaterThan(0);
    for (const s of sent) {
      expect(s.name).toBe("reminders.plan");
      expect(Object.keys(s.data)).toEqual(["householdId"]);
      expect(s.options).toMatchObject({
        singletonKey: `reminders.plan:${(s.data as { householdId: string }).householdId}`,
      });
    }
  });
});
