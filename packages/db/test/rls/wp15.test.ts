// WP-15 table rules beyond plain isolation (the generic cross-household cases are in cases.ts): a member reads only
// their own notifications, what the API may write (and may not), tenant-safe keys, user-scoped preferences and
// send quota, the worker's narrow rights, and the SES event function.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { count, expectDenied, expectNoRowsAffected, expectRejected, openDbs } from "./helpers";
import { buildWorld, createUser, type World } from "./world";

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

let api: ApiDb;
let worker: WorkerDb;
let world: World;

const asCreator = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.a.creator.id, householdId: world.a.id }, fn);
const asPartner = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.a.partner.id, householdId: world.a.id }, fn);
const asWorkerA = <T>(fn: (tx: Tx) => Promise<T>) => worker.withJobTx(world.a.id, fn);

beforeAll(async () => {
  ({ api, worker } = openDbs());
  world = await buildWorld(api);
});
afterAll(async () => {
  await api.close();
  await worker.close();
});

function notifyPartner(tx: Tx, extra: { kind?: string; link?: string | null; key?: string } = {}) {
  return tx.execute(sql`insert into notifications (household_id, user_id, kind, dedupe_key, title, body, deep_link, send_at)
    values (${world.a.id}, ${world.a.partner.id}, ${extra.kind ?? "proposal"}, ${extra.key ?? `k:${randomUUID()}`},
            'Title', 'Body', ${extra.link ?? null}, now())`);
}

describe("notifications: a member reads only their own", () => {
  it("each member sees exactly the notification addressed to them", async () => {
    const mine = await asCreator((tx) =>
      tx.execute<{ id: string }>(sql`select id from notifications where household_id = ${world.a.id}`),
    );
    expect(mine.rows.map((r) => r.id)).toContain(world.a.notify.creatorNotificationId);
    expect(mine.rows.map((r) => r.id)).not.toContain(world.a.notify.partnerNotificationId);
    const theirs = await asPartner((tx) =>
      tx.execute<{ id: string }>(sql`select id from notifications where household_id = ${world.a.id}`),
    );
    expect(theirs.rows.map((r) => r.id)).toContain(world.a.notify.partnerNotificationId);
    expect(theirs.rows.map((r) => r.id)).not.toContain(world.a.notify.creatorNotificationId);
  });

  it("deliveries follow the same rule", async () => {
    const mine = await asCreator((tx) =>
      count(tx, sql`select 1 from notification_deliveries where household_id = ${world.a.id}`),
    );
    expect(mine).toBe(1);
  });

  it("a member can't mark the other member's notification read", async () => {
    await expectNoRowsAffected(() =>
      asCreator((tx) =>
        tx.execute(
          sql`update notifications set read_at = now() where id = ${world.a.notify.partnerNotificationId}`,
        ),
      ),
    );
    await asCreator((tx) =>
      tx.execute(
        sql`update notifications set read_at = now() where id = ${world.a.notify.creatorNotificationId}`,
      ),
    );
  });
});

describe("notifications: what the API may write", () => {
  it("adds a proposal, task, review or system notice for the other member", async () => {
    for (const kind of ["proposal", "task", "review", "system"]) {
      await asCreator((tx) => notifyPartner(tx, { kind }));
    }
  });

  it("never a reminder, digest or security notice, a sent status, or a reminder's item columns", async () => {
    for (const kind of ["reminder", "digest", "security"]) {
      await expectDenied(() => asCreator((tx) => notifyPartner(tx, { kind })));
    }
    await expectDenied(() =>
      asCreator((tx) =>
        tx.execute(sql`insert into notifications (household_id, user_id, kind, dedupe_key, title, body, send_at, status)
          values (${world.a.id}, ${world.a.partner.id}, 'system', ${`k:${randomUUID()}`}, 't', 'b', now(), 'sent')`),
      ),
    );
    await expectDenied(() =>
      asCreator((tx) =>
        tx.execute(sql`insert into notifications (household_id, user_id, kind, dedupe_key, title, body, send_at, item_id)
          values (${world.a.id}, ${world.a.partner.id}, 'system', ${`k:${randomUUID()}`}, 't', 'b', now(), ${world.a.items.itemId})`),
      ),
    );
  });

  it("only the recipient's read_at changes; the text and status are fixed", async () => {
    for (const column of [
      "title",
      "body",
      "status",
      "send_at",
      "user_id",
      "kind",
      "dedupe_key",
      "household_id",
    ]) {
      await expectDenied(() =>
        asPartner((tx) =>
          tx.execute(
            sql.raw(
              `update notifications set ${column} = ${column} where id = '${world.a.notify.partnerNotificationId}'`,
            ),
          ),
        ),
      );
    }
    await expectDenied(() =>
      asPartner((tx) => tx.execute(sql`delete from notifications where household_id = ${world.a.id}`)),
    );
  });

  it("the recipient must belong to the household (tenant-safe foreign key)", async () => {
    const outsider = await createUser(api, "outsider");
    await expectRejected(
      () =>
        asCreator((tx) =>
          tx.execute(sql`insert into notifications (household_id, user_id, kind, dedupe_key, title, body, send_at)
            values (${world.a.id}, ${outsider.id}, 'system', ${`k:${randomUUID()}`}, 't', 'b', now())`),
        ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("a dedupe key is unique per household, not across households", async () => {
    const key = `dup:${randomUUID()}`;
    await asCreator((tx) => notifyPartner(tx, { key }));
    await expectRejected(() => asCreator((tx) => notifyPartner(tx, { key })), UNIQUE_VIOLATION);
    await api.withHouseholdTx({ userId: world.b.creator.id, householdId: world.b.id }, (tx) =>
      tx.execute(sql`insert into notifications (household_id, user_id, kind, dedupe_key, title, body, send_at)
        values (${world.b.id}, ${world.b.partner.id}, 'system', ${key}, 't', 'b', now())`),
    );
  });

  it("a deep link must be app-relative", async () => {
    for (const link of ["https://evil.example/x", "//evil.example", "javascript:alert(1)"]) {
      await expectRejected(() => asCreator((tx) => notifyPartner(tx, { link })), CHECK_VIOLATION);
    }
    await asCreator((tx) => notifyPartner(tx, { link: "/bills?item=abc" }));
  });
});

describe("notifications: the worker", () => {
  it("a reminder row needs its item, rule date, offset and due date", async () => {
    await expectRejected(
      () =>
        asWorkerA((tx) =>
          tx.execute(sql`insert into notifications (household_id, user_id, kind, dedupe_key, title, body, send_at)
            values (${world.a.id}, ${world.a.creator.id}, 'reminder', ${`r:${randomUUID()}`}, 't', 'b', now())`),
        ),
      CHECK_VIOLATION,
    );
    await asWorkerA((tx) =>
      tx.execute(sql`insert into notifications
          (household_id, user_id, kind, dedupe_key, title, body, send_at, item_id, scheduled_on, offset_days, due_on)
        values (${world.a.id}, ${world.a.creator.id}, 'reminder', ${`r:${randomUUID()}`}, 't', 'b', now(),
                ${world.a.items.itemId}, '2026-11-06', 3, '2026-11-06')`),
    );
  });

  it("can't name another household's item or user", async () => {
    await expectRejected(
      () =>
        asWorkerA((tx) =>
          tx.execute(sql`insert into notifications
              (household_id, user_id, kind, dedupe_key, title, body, send_at, item_id, scheduled_on, offset_days, due_on)
            values (${world.a.id}, ${world.a.creator.id}, 'reminder', ${`r:${randomUUID()}`}, 't', 'b', now(),
                    ${world.b.items.itemId}, '2026-11-06', 3, '2026-11-06')`),
        ),
      FOREIGN_KEY_VIOLATION,
    );
    await expectRejected(
      () =>
        asWorkerA((tx) =>
          tx.execute(sql`insert into notifications (household_id, user_id, kind, dedupe_key, title, body, send_at)
            values (${world.a.id}, ${world.b.creator.id}, 'system', ${`r:${randomUUID()}`}, 't', 'b', now())`),
        ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("changes only status, text, times and the due date; never the owner or the key", async () => {
    for (const column of ["user_id", "kind", "dedupe_key", "household_id", "read_at", "item_id"]) {
      await expectDenied(() =>
        asWorkerA((tx) =>
          tx.execute(
            sql.raw(
              `update notifications set ${column} = ${column} where id = '${world.a.notify.partnerNotificationId}'`,
            ),
          ),
        ),
      );
    }
    await asWorkerA((tx) =>
      tx.execute(sql`update notifications set status = 'cancelled', attempt_at = null
        where id = ${world.a.notify.partnerNotificationId}`),
    );
    await expectDenied(() =>
      asWorkerA((tx) => tx.execute(sql`delete from notifications where household_id = ${world.a.id}`)),
    );
  });

  it("delivery rows: the API can read but not write them", async () => {
    await expectDenied(() =>
      asCreator((tx) =>
        tx.execute(
          sql`update notification_deliveries set status = 'delivered' where household_id = ${world.a.id}`,
        ),
      ),
    );
    await expectDenied(() =>
      asCreator((tx) =>
        tx.execute(sql`insert into notification_deliveries (household_id, notification_id, channel, status)
          values (${world.a.id}, ${world.a.notify.creatorNotificationId}, 'push', 'sent')`),
      ),
    );
  });

  it("a delivery belongs to a notification of the same household", async () => {
    await expectRejected(
      () =>
        asWorkerA((tx) =>
          tx.execute(sql`insert into notification_deliveries (household_id, notification_id, channel, status)
            values (${world.a.id}, ${world.b.notify.creatorNotificationId}, 'push', 'sent')`),
        ),
      FOREIGN_KEY_VIOLATION,
    );
  });
});

describe("notification_preferences", () => {
  it("a user reads and writes only their own row, and can't touch the suppression columns", async () => {
    await asCreator((tx) =>
      tx.execute(sql`insert into notification_preferences (user_id, email_enabled, muted_kinds)
        values (${world.a.creator.id}, false, '{review}')`),
    );
    expect(
      await asPartner((tx) =>
        count(tx, sql`select 1 from notification_preferences where user_id = ${world.a.creator.id}`),
      ),
    ).toBe(0);
    await expectDenied(() =>
      asPartner((tx) =>
        tx.execute(sql`insert into notification_preferences (user_id) values (${world.a.creator.id})`),
      ),
    );
    await expectNoRowsAffected(() =>
      asPartner((tx) =>
        tx.execute(
          sql`update notification_preferences set email_enabled = true where user_id = ${world.a.creator.id}`,
        ),
      ),
    );
    await expectDenied(() =>
      asCreator((tx) =>
        tx.execute(
          sql`update notification_preferences set email_suppressed_at = null where user_id = ${world.a.creator.id}`,
        ),
      ),
    );
    await expectDenied(() =>
      asPartner((tx) =>
        tx.execute(sql`insert into notification_preferences (user_id, email_suppressed_at, email_suppressed_reason)
          values (${world.a.partner.id}, now(), 'hard_bounce')`),
      ),
    );
  });

  it("only non-essential kinds can be muted", async () => {
    await expectRejected(
      () =>
        asCreator((tx) =>
          tx.execute(
            sql`update notification_preferences set muted_kinds = '{proposal}' where user_id = ${world.a.creator.id}`,
          ),
        ),
      CHECK_VIOLATION,
    );
  });

  it("a job reads the preferences of its own household's members only", async () => {
    expect(
      await asWorkerA((tx) =>
        count(tx, sql`select 1 from notification_preferences where user_id = ${world.a.creator.id}`),
      ),
    ).toBe(1);
    expect(
      await worker.withJobTx(world.b.id, (tx) =>
        count(tx, sql`select 1 from notification_preferences where user_id = ${world.a.creator.id}`),
      ),
    ).toBe(0);
    await expectDenied(() =>
      asWorkerA((tx) => tx.execute(sql`update notification_preferences set email_enabled = true`)),
    );
  });
});

describe("send_quota_events", () => {
  it("are the signed-in user's own; nobody else reads or writes them", async () => {
    await asCreator((tx) =>
      tx.execute(sql`insert into send_quota_events (user_id, kind) values (${world.a.creator.id}, 'invite')`),
    );
    expect(await asCreator((tx) => count(tx, sql`select 1 from send_quota_events`))).toBe(1);
    expect(await asPartner((tx) => count(tx, sql`select 1 from send_quota_events`))).toBe(0);
    await expectDenied(() =>
      asPartner((tx) =>
        tx.execute(
          sql`insert into send_quota_events (user_id, kind) values (${world.a.creator.id}, 'invite')`,
        ),
      ),
    );
    await expectDenied(() =>
      asCreator((tx) => tx.execute(sql`update send_quota_events set created_at = now() - interval '9 days'`)),
    );
    // a fresh row can't be deleted to reset the count; an old one can be pruned
    await expectNoRowsAffected(() => asCreator((tx) => tx.execute(sql`delete from send_quota_events`)));
  });
});

describe("reminder_rules", () => {
  it("a member edits their household's rules; the offsets and channels are validated", async () => {
    await asCreator((tx) =>
      tx.execute(
        sql`update reminder_rules set offsets_days = '{7,3,0}', also_notify_partner = true where id = ${world.a.notify.ruleId}`,
      ),
    );
    for (const offsets of ["{}", "{-1}", "{61}"]) {
      await expectRejected(
        () =>
          asCreator((tx) =>
            tx.execute(
              sql`update reminder_rules set offsets_days = ${offsets}::int[] where id = ${world.a.notify.ruleId}`,
            ),
          ),
        CHECK_VIOLATION,
      );
    }
    await expectRejected(
      () =>
        asCreator((tx) =>
          tx.execute(sql`update reminder_rules set channels = '{sms}' where id = ${world.a.notify.ruleId}`),
        ),
      CHECK_VIOLATION,
    );
  });

  it("one rule per item, one default per household", async () => {
    await expectRejected(
      () =>
        asCreator((tx) => tx.execute(sql`insert into reminder_rules (household_id) values (${world.a.id})`)),
      UNIQUE_VIOLATION,
    );
  });

  it("a rule can't name another household's item", async () => {
    await expectRejected(
      () =>
        asCreator((tx) =>
          tx.execute(
            sql`insert into reminder_rules (household_id, item_id) values (${world.a.id}, ${world.b.items.itemId})`,
          ),
        ),
      FOREIGN_KEY_VIOLATION,
    );
  });
});

describe("app_record_delivery_event (SES events)", () => {
  async function newDelivery(): Promise<{ id: string; providerId: string; userId: string; hid: string }> {
    const id = randomUUID();
    const providerId = `ses-${randomUUID()}`;
    const user = await createUser(api, "bounced");
    // a household of its own so suppression is isolated from the other tests
    const hid = randomUUID();
    const { createHousehold } = await import("../../src/seed/flows");
    await createHousehold(api, user, {
      id: hid,
      name: "Bounce household",
      timezone: "America/New_York",
      forwardingToken: `bounce-${hid.slice(0, 8)}`,
    });
    await api.withHouseholdTx({ userId: user.id, householdId: hid }, (tx) =>
      tx.execute(sql`insert into notifications (id, household_id, user_id, kind, dedupe_key, title, body, send_at)
        values (${id}, ${hid}, ${user.id}, 'system', ${`e:${id}`}, 't', 'b', now())`),
    );
    await worker.withJobTx(hid, (tx) =>
      tx.execute(sql`insert into notification_deliveries (household_id, notification_id, channel, provider_message_id, status, attempts)
        values (${hid}, ${id}, 'email', ${providerId}, 'sent', 1)`),
    );
    return { id, providerId, userId: user.id, hid };
  }

  const record = async (providerId: string, event: string, bounceType: string | null = null) => {
    const res = await api.withHouseholdTx({ userId: null }, (tx) =>
      tx.execute<{ o: string }>(
        sql`select app_record_delivery_event(${providerId}, ${event}, ${bounceType}) as o`,
      ),
    );
    return res.rows[0]?.o;
  };

  async function read(d: { id: string; userId: string; hid: string }) {
    return worker.withJobTx(d.hid, async (tx) => {
      const delivery = await tx.execute<{ status: string; last_error: string | null }>(
        sql`select status, last_error from notification_deliveries where notification_id = ${d.id}`,
      );
      const prefs = await tx.execute<{ email_suppressed_reason: string | null }>(
        sql`select email_suppressed_reason from notification_preferences where user_id = ${d.userId}`,
      );
      const notices = await tx.execute<{ kind: string; title: string; status: string }>(
        sql`select kind, title, status from notifications where user_id = ${d.userId} and dedupe_key like 'email_suppressed:%'`,
      );
      return {
        status: delivery.rows[0]?.status,
        lastError: delivery.rows[0]?.last_error,
        suppressed: prefs.rows[0]?.email_suppressed_reason ?? null,
        notices: notices.rows,
      };
    });
  }

  it("a delivery event marks the delivery delivered", async () => {
    const d = await newDelivery();
    expect(await record(d.providerId, "delivery")).toBe("applied");
    expect((await read(d)).status).toBe("delivered");
  });

  it("a permanent bounce marks it bounced, turns email off and leaves an in-app security notice", async () => {
    const d = await newDelivery();
    expect(await record(d.providerId, "bounce", "Permanent")).toBe("applied");
    const after = await read(d);
    expect(after.status).toBe("bounced");
    expect(after.suppressed).toBe("hard_bounce");
    expect(after.notices).toEqual([
      { kind: "security", title: "We could not deliver email to you", status: "sent" },
    ]);
    // the same event again changes nothing, and adds no second notice
    await record(d.providerId, "bounce", "Permanent");
    expect((await read(d)).notices).toHaveLength(1);
    // a late "delivery" doesn't undo a bounce
    expect(await record(d.providerId, "delivery")).toBe("ignored");
    expect((await read(d)).status).toBe("bounced");
  });

  it("a transient bounce is recorded but keeps email on", async () => {
    const d = await newDelivery();
    await record(d.providerId, "bounce", "Transient");
    const after = await read(d);
    expect(after.status).toBe("bounced");
    expect(after.suppressed).toBeNull();
    expect(after.notices).toEqual([]);
  });

  it("a complaint marks it complained and turns email off", async () => {
    const d = await newDelivery();
    await record(d.providerId, "complaint");
    const after = await read(d);
    expect(after.status).toBe("complained");
    expect(after.suppressed).toBe("complaint");
  });

  it("an unknown message id, or an event we don't track, changes nothing", async () => {
    expect(await record(`nope-${randomUUID()}`, "delivery")).toBe("unknown");
    const d = await newDelivery();
    expect(await record(d.providerId, "open")).toBe("ignored");
    expect((await read(d)).status).toBe("sent");
  });

  it("only the API role may call it, and the household list is for jobs only", async () => {
    await expectDenied(() =>
      asWorkerA((tx) => tx.execute(sql`select app_record_delivery_event('x', 'delivery', null)`)),
    );
    await expectDenied(() =>
      asCreator((tx) => tx.execute(sql`select app_list_households_with_due_notifications()`)),
    );
  });

  it("lists exactly the households with a notification due, for the worker", async () => {
    const ids = await worker.listHouseholdIdsWithDueNotifications();
    expect(ids).toContain(world.b.id); // its seed notices were due a minute ago
    // a household with only a future notice isn't listed
    const user = await createUser(api, "future");
    const hid = randomUUID();
    const { createHousehold } = await import("../../src/seed/flows");
    await createHousehold(api, user, {
      id: hid,
      name: "Future",
      timezone: "America/New_York",
      forwardingToken: `future-${hid.slice(0, 8)}`,
    });
    await worker.withJobTx(hid, (tx) =>
      tx.execute(sql`insert into notifications (household_id, user_id, kind, dedupe_key, title, body, send_at)
        values (${hid}, ${user.id}, 'system', 'f', 't', 'b', now() + interval '1 day')`),
    );
    expect(await worker.listHouseholdIdsWithDueNotifications()).not.toContain(hid);
  });
});

describe("app_sync_auth_user and email suppression (Q-133)", () => {
  async function suppressedUser() {
    const user = await createUser(api, "resync");
    const { createHousehold } = await import("../../src/seed/flows");
    const hid = randomUUID();
    await createHousehold(api, user, {
      id: hid,
      name: "Resync household",
      timezone: "America/New_York",
      forwardingToken: `resync-${hid.slice(0, 8)}`,
    });
    const nid = randomUUID();
    const provider = `ses-${randomUUID()}`;
    await api.withHouseholdTx({ userId: user.id, householdId: hid }, (tx) =>
      tx.execute(sql`insert into notifications (id, household_id, user_id, kind, dedupe_key, title, body, send_at)
        values (${nid}, ${hid}, ${user.id}, 'system', ${`e:${nid}`}, 't', 'b', now())`),
    );
    await worker.withJobTx(hid, (tx) =>
      tx.execute(sql`insert into notification_deliveries (household_id, notification_id, channel, provider_message_id, status, attempts)
        values (${hid}, ${nid}, 'email', ${provider}, 'sent', 1)`),
    );
    await api.withHouseholdTx({ userId: null }, (tx) =>
      tx.execute(sql`select app_record_delivery_event(${provider}, 'bounce', 'Permanent')`),
    );
    return { user, hid };
  }
  const sync = (subject: string, email: string) =>
    api.withHouseholdTx({ userId: null, authSubject: subject }, (tx) =>
      tx.execute(sql`select app_sync_auth_user(${subject}, ${email}, true, false)`),
    );
  const reason = ({ user, hid }: { user: { id: string }; hid: string }) =>
    worker.withJobTx(hid, async (tx) => {
      const r = await tx.execute<{ r: string | null }>(
        sql`select email_suppressed_reason as r from notification_preferences where user_id = ${user.id}`,
      );
      return r.rows[0]?.r ?? null;
    });

  it("keeps the suppression when the same address is synced again (even in another letter case)", async () => {
    const s = await suppressedUser();
    expect(await reason(s)).toBe("hard_bounce");
    await sync(s.user.authSubject, s.user.email);
    await sync(s.user.authSubject, s.user.email.toUpperCase());
    expect(await reason(s)).toBe("hard_bounce");
  });

  it("clears the suppression when the address changes", async () => {
    const s = await suppressedUser();
    expect(await reason(s)).toBe("hard_bounce");
    await sync(s.user.authSubject, `new-${randomUUID()}@example.test`);
    expect(await reason(s)).toBeNull();
  });
});
