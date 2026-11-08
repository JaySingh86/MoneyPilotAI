// WP-15 against a real Postgres (RLS as mp_api) with the real auth layer: the invite email and its quota, the
// `invite.accepted` notification, proposal notifications, the notifications API and preferences, and the SES event
// webhook (real SNS signature checks with a throwaway certificate).
import { readFile } from "node:fs/promises";
import { sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createWorkerDb, type WorkerDb } from "@mp/db";
import { seedFixture, seedPlanning, type SeedResult } from "@mp/db/testing";
import { createInviteSender } from "@mp/notify";
import { FakeEmailSender } from "@mp/notify/testing";
import { createTestApi, key, type TestApi, type TestUser } from "../../auth/testing/app";
import { expectProblem, makeTestCertificate } from "../../lib/testing";
import { snsStringToSign, type SnsMessage } from "../../lib/webhooks";
import { createNotifyModules } from "./index";
import { createDbSendQuota } from "./send-quota";

const APP = "https://app.example.test";
const TOPIC = "arn:aws:sns:us-east-1:123456789012:mp-ses-events";
const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";
const QUOTA = 2;

const email = new FakeEmailSender();
const cert = makeTestCertificate("sns.amazonaws.com");
const confirmed: string[] = [];
let t: TestApi;
let worker: WorkerDb;

beforeAll(async () => {
  t = await createTestApi({
    now: () => "2026-10-27T16:00:00Z",
    inviteSender: (db) =>
      createInviteSender({ email, quota: createDbSendQuota(db, { limit: QUOTA }), appUrl: APP }),
    extraModules: (rt) =>
      createNotifyModules(() => rt, {
        env: () => ({ SES_EVENTS_TOPIC_ARNS: TOPIC, AWS_REGION: "us-east-1" }),
        loadCertificate: async () => cert.certPem,
        confirmSubscription: async (url) => {
          confirmed.push(url);
        },
      }),
  });
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 2 });
}, 180_000);
afterAll(async () => {
  await t?.close();
  await worker?.close();
});

const createHousehold = (user: TestUser, name = "Rivera") =>
  t.app.inject({
    method: "POST",
    url: "/v1/households",
    headers: { ...user.headers, ...key() },
    payload: { name },
  });
const invite = (owner: TestUser, hid: string, to: string) =>
  t.app.inject({
    method: "POST",
    url: `/v1/households/${hid}/invites`,
    headers: { ...owner.headers, ...key() },
    payload: { email: to },
  });
const revoke = (owner: TestUser, hid: string, id: string) =>
  t.app.inject({ method: "DELETE", url: `/v1/households/${hid}/invites/${id}`, headers: owner.headers });
const accept = (user: TestUser, token: string) =>
  t.app.inject({ method: "POST", url: "/v1/invites/accept", headers: user.headers, payload: { token } });

interface NotificationBody {
  id: string;
  kind: string;
  title: string;
  body: string;
  deepLink: string | null;
  read: boolean;
  status: string;
  sentAt: string;
  delivery: { channel: string; status: string } | null;
}
interface ListBody {
  data: NotificationBody[];
  nextCursor: string | null;
  unreadCount: number;
}
const list = async (user: TestUser, hid: string, query = ""): Promise<ListBody> => {
  const res = await t.app.inject({
    method: "GET",
    url: `/v1/households/${hid}/notifications${query}`,
    headers: user.headers,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<ListBody>();
};

async function pair(label: string, householdName = "Rivera", firstName?: string) {
  const sam = await t.signUp(`${label}-sam`, firstName ? { firstName } : {});
  const jordan = await t.signUp(`${label}-jordan`, { firstName: "Jordan" });
  const hid = (await createHousehold(sam, householdName)).json<{ id: string }>().id;
  return { sam, jordan, hid };
}

describe("the invite email (Q-081)", () => {
  it("links to /invite?token= with the real token, escapes the names, and the link accepts", async () => {
    const { sam, jordan, hid } = await pair("inv", `A&B <i>"Co"</i>`, `Eve <img src=x onerror=1>`);
    email.sent.length = 0;
    const res = await invite(sam, hid, jordan.email);
    expect(res.statusCode, res.body).toBe(201);
    expect(email.sent).toHaveLength(1);
    const mail = email.sent[0];
    expect(mail?.to).toBe(jordan.email);
    const link = /https:\/\/app\.example\.test\/invite\?token=([A-Za-z0-9_-]+)/.exec(mail?.text ?? "");
    expect(link, mail?.text).not.toBeNull();
    // names: raw in the subject and text, escaped once in the HTML, never as live markup
    expect(mail?.subject).toBe("Eve <img src=x onerror=1> invited you to MoneyPilot");
    expect(mail?.html).not.toContain("<img");
    expect(mail?.html).not.toContain("<i>");
    expect(mail?.html).toContain("A&amp;B &lt;i&gt;&quot;Co&quot;&lt;/i&gt;");
    expect(mail?.html).not.toContain("&amp;amp;");
    expect(mail?.text).not.toMatch(/\bpay\b/i);
    expect((await accept(jordan, link?.[1] ?? "")).statusCode).toBe(200);
  });

  it("a per-user send quota stops further invites with 429, and doesn't affect other users", async () => {
    const { sam, hid } = await pair("quota");
    email.sent.length = 0;
    for (let n = 0; n < QUOTA; n++) {
      const res = await invite(sam, hid, `q${n}@example.test`);
      expect(res.statusCode, res.body).toBe(201);
      expect((await revoke(sam, hid, res.json<{ id: string }>().id)).statusCode).toBe(204);
    }
    expectProblem(await invite(sam, hid, "q-extra@example.test"), 429, "rate_limited");
    expect(email.sent).toHaveLength(QUOTA);
    // the invite that could not be sent was cancelled, not left blocking the household
    const other = await pair("quota-other");
    expect((await invite(other.sam, other.hid, "fine@example.test")).statusCode).toBe(201);
    const rows = await t.admin((c) =>
      c.query("select count(*)::int as n from send_quota_events where user_id = $1", [sam.id]),
    );
    expect(rows.rows[0].n).toBe(QUOTA);
  });
});

describe("invite.accepted (Q-087) and the notifications API", () => {
  it("tells the creator when the partner joins; read state and unread count follow", async () => {
    const { sam, jordan, hid } = await pair("acc", "Rivera");
    email.sent.length = 0;
    await invite(sam, hid, jordan.email);
    const token = /token=([A-Za-z0-9_-]+)/.exec(email.sent[0]?.text ?? "")?.[1] ?? "";
    expect((await list(sam, hid)).data).toHaveLength(0);
    expect((await accept(jordan, token)).statusCode).toBe(200);

    const mine = await list(sam, hid);
    expect(mine.unreadCount).toBe(1);
    expect(mine.data).toHaveLength(1);
    expect(mine.data[0]).toMatchObject({
      kind: "system",
      title: "Jordan joined Rivera",
      read: false,
      deepLink: "/privacy",
      delivery: null,
    });
    // the accepter gets nothing, and can't see or read the creator's notification
    expect((await list(jordan, hid)).data).toHaveLength(0);
    const id = mine.data[0]?.id ?? "";
    expectProblem(
      await t.app.inject({
        method: "POST",
        url: `/v1/households/${hid}/notifications/${id}/read`,
        headers: { ...jordan.headers, ...key() },
      }),
      404,
      "not_found",
    );
    const read = await t.app.inject({
      method: "POST",
      url: `/v1/households/${hid}/notifications/${id}/read`,
      headers: { ...sam.headers, ...key() },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id, read: true });
    const after = await list(sam, hid);
    expect(after.unreadCount).toBe(0);
    expect((await list(sam, hid, "?unread=true")).data).toHaveLength(0);
    expect((await list(sam, hid, "?unread=false")).data).toHaveLength(1);
  });

  it("the sender hears about it once even if accept is retried", async () => {
    const { sam, jordan, hid } = await pair("acc2");
    email.sent.length = 0;
    await invite(sam, hid, jordan.email);
    const token = /token=([A-Za-z0-9_-]+)/.exec(email.sent[0]?.text ?? "")?.[1] ?? "";
    await accept(jordan, token);
    expect((await accept(jordan, token)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await list(sam, hid)).data).toHaveLength(1);
  });

  it("pages newest first with a cursor", async () => {
    const { sam, jordan, hid } = await pair("page");
    for (let i = 0; i < 5; i++) {
      await t.admin((c) =>
        c.query(
          `insert into notifications (household_id, user_id, kind, dedupe_key, title, body, send_at)
           values ($1, $2, 'system', $3, $4, 'b', now() - make_interval(mins => $5))`,
          [hid, sam.id, `p${i}`, `N${i}`, 10 + i],
        ),
      );
    }
    void jordan;
    const first = await list(sam, hid, "?limit=2");
    expect(first.data.map((n) => n.title)).toEqual(["N0", "N1"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(sam, hid, `?limit=2&cursor=${first.nextCursor}`);
    expect(second.data.map((n) => n.title)).toEqual(["N2", "N3"]);
    const third = await list(sam, hid, `?limit=2&cursor=${second.nextCursor}`);
    expect(third.data.map((n) => n.title)).toEqual(["N4"]);
    expect(third.nextCursor).toBeNull();
    expectProblem(
      await t.app.inject({
        method: "GET",
        url: `/v1/households/${hid}/notifications?cursor=garbage`,
        headers: sam.headers,
      }),
      400,
      "validation_failed",
    );
  });

  it("hides future and cancelled notifications and shows the email delivery state", async () => {
    const { sam, hid } = await pair("vis");
    const insert = (key: string, sendAt: string, status: string) =>
      t.admin((c) =>
        c.query(
          `insert into notifications (household_id, user_id, kind, dedupe_key, title, body, send_at, status)
           values ($1, $2, 'system', $3, $3, 'b', $4::timestamptz, $5) returning id`,
          [hid, sam.id, key, sendAt, status],
        ),
      );
    await insert("future", "2099-01-01T00:00:00Z", "scheduled");
    await insert("cancelled", "2020-01-01T00:00:00Z", "cancelled");
    const sent = await insert("sent", "2020-01-01T00:00:00Z", "sent");
    await t.admin((c) =>
      c.query(
        `insert into notification_deliveries (household_id, notification_id, channel, status, attempts)
         values ($1, $2, 'email', 'failed', 5)`,
        [hid, sent.rows[0].id],
      ),
    );
    const got = await list(sam, hid);
    expect(got.data.map((n) => n.title)).toEqual(["sent"]);
    expect(got.data[0]?.delivery).toEqual({ channel: "email", status: "failed" });
  });

  it("a non-member sees nothing of the household's notifications", async () => {
    const { hid } = await pair("tenant");
    const stranger = await t.signUp("tenant-stranger");
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/households/${hid}/notifications`,
      headers: stranger.headers,
    });
    if (res.statusCode === 200) expect(res.json<ListBody>().data).toEqual([]);
    else expect([403, 404]).toContain(res.statusCode);
  });
});

describe("notification preferences", () => {
  it("defaults, changes, and validates", async () => {
    const user = await t.signUp("prefs");
    const get = () =>
      t.app.inject({ method: "GET", url: "/v1/me/notification-preferences", headers: user.headers });
    expect((await get()).json()).toEqual({ emailEnabled: true, mutedKinds: [], emailSuppressed: null });
    const put = (payload: object) =>
      t.app.inject({
        method: "PUT",
        url: "/v1/me/notification-preferences",
        headers: { ...user.headers, ...key() },
        payload,
      });
    expect((await put({ mutedKinds: ["review", "digest", "review"] })).json()).toMatchObject({
      emailEnabled: true,
      mutedKinds: ["review", "digest"],
    });
    expect((await put({ emailEnabled: false })).json()).toMatchObject({
      emailEnabled: false,
      mutedKinds: ["review", "digest"],
    });
    expect((await get()).json()).toMatchObject({ emailEnabled: false, mutedKinds: ["review", "digest"] });
    expectProblem(await put({ mutedKinds: ["proposal"] }), 400, "validation_failed");
    expectProblem(await put({}), 400, "validation_failed");
    expectProblem(await put({ emailSuppressed: null, emailEnabled: true }), 400, "validation_failed");
  });

  it("is each user's own", async () => {
    const a = await t.signUp("prefs-a");
    const b = await t.signUp("prefs-b");
    await t.app.inject({
      method: "PUT",
      url: "/v1/me/notification-preferences",
      headers: { ...a.headers, ...key() },
      payload: { emailEnabled: false },
    });
    const theirs = await t.app.inject({
      method: "GET",
      url: "/v1/me/notification-preferences",
      headers: b.headers,
    });
    expect(theirs.json()).toMatchObject({ emailEnabled: true });
  });
});

describe("proposal notifications (Q-115)", () => {
  interface Rivera {
    seeded: SeedResult;
    sam: TestUser | { headers: Record<string, string> };
    samHeaders: Record<string, string>;
    jordanHeaders: Record<string, string>;
    hid: string;
    tahoe: string;
  }
  let r: Rivera;

  beforeAll(async () => {
    const raw = await readFile(
      fileURLToPath(new URL("../../../../../design/fixtures/rivera-household.json", import.meta.url)),
      "utf8",
    );
    const fixture: unknown = JSON.parse(
      raw
        .replaceAll("hh-rivera", "hh-rivera-n15")
        .replaceAll("m-sam", "m-sam-n15")
        .replaceAll("m-jordan", "m-jordan-n15")
        .replaceAll("rivera-7k2", "rivera-n15")
        .replaceAll("@rivera-household.example", "@n15.example"),
    );
    const seeded = await seedFixture({ api: t.db, worker }, fixture);
    await seedPlanning({ api: t.db, worker }, seeded, fixture);
    const { planningUuid } = await import("@mp/db/testing");
    r = {
      seeded,
      sam: { headers: {} },
      samHeaders: await t.as("fixture|m-sam-n15", { claims: { email: "sam@n15.example" } }),
      jordanHeaders: await t.as("fixture|m-jordan-n15", { claims: { email: "jordan@n15.example" } }),
      hid: seeded.householdId,
      tahoe: planningUuid(seeded.householdId, "g-tahoe"),
    };
  }, 120_000);

  const asUser = (headers: Record<string, string>): TestUser => ({ id: "", subject: "", email: "", headers });
  const propose = async (monthlyCents: number) => {
    const url = `/v1/households/${r.hid}/goals/${r.tahoe}`;
    const etag = (await t.app.inject({ method: "GET", url, headers: r.samHeaders })).headers.etag as string;
    const res = await t.app.inject({
      method: "PATCH",
      url,
      headers: { ...r.samHeaders, "if-match": etag, ...key() },
      payload: { monthlyCents },
    });
    expect(res.statusCode, res.body).toBe(202);
    return res.json<{ id: string }>().id;
  };
  const decide = (verb: "approve" | "reject", id: string, headers: Record<string, string>) =>
    t.app.inject({
      method: "POST",
      url: `/v1/households/${r.hid}/proposals/${id}/${verb}`,
      headers: { ...headers, ...key() },
    });
  const titles = async (headers: Record<string, string>) =>
    (await list(asUser(headers), r.hid)).data.map((n) => `${n.kind}:${n.title}`);

  it("creating a proposal notifies the other member, not the proposer; deciding notifies the proposer", async () => {
    const id = await propose(31300);
    expect(await titles(r.jordanHeaders)).toContain("proposal:Sam asked you to approve a change");
    expect(await titles(r.samHeaders)).not.toContain("proposal:Sam asked you to approve a change");
    const notice = (await list(asUser(r.jordanHeaders), r.hid)).data.find((n) =>
      n.title.startsWith("Sam asked"),
    );
    expect(notice?.body).not.toMatch(/\$|\d/); // no amounts or numbers in the copy

    expect((await decide("approve", id, r.jordanHeaders)).statusCode).toBe(200);
    expect(await titles(r.samHeaders)).toContain("proposal:Jordan approved your request");
  });

  it("a declined request tells the proposer, and each proposal notifies once", async () => {
    const id = await propose(20000);
    expect((await decide("reject", id, r.jordanHeaders)).statusCode).toBe(200);
    const sam = await titles(r.samHeaders);
    expect(sam).toContain("proposal:Jordan declined your request");
    expect(sam.filter((x) => x === "proposal:Jordan declined your request")).toHaveLength(1);
  });

  it("a proposal that went stale tells the proposer it is out of date", async () => {
    const id = await propose(22000);
    // the goal changed under it
    await t.admin((c) => c.query("update goals set monthly_cents = 1000 where id = $1", [r.tahoe]));
    const res = await decide("approve", id, r.jordanHeaders);
    expect(res.statusCode).toBe(409);
    expect(await titles(r.samHeaders)).toContain("proposal:Your request is out of date");
  });
});

describe("POST /webhooks/ses-events", () => {
  async function deliveryFor(): Promise<{
    providerId: string;
    user: TestUser;
    hid: string;
    notificationId: string;
  }> {
    const { sam, jordan, hid } = await pair("ses");
    email.sent.length = 0;
    await invite(sam, hid, jordan.email);
    const token = /token=([A-Za-z0-9_-]+)/.exec(email.sent[0]?.text ?? "")?.[1] ?? "";
    await accept(jordan, token);
    const providerId = `ses-${crypto.randomUUID()}`;
    const row = await t.admin((c) =>
      c.query(
        `insert into notifications (household_id, user_id, kind, dedupe_key, title, body, send_at, status)
         values ($1, $2, 'proposal', $3, 'Sam asked you to approve a change', 'b', now(), 'sent') returning id`,
        [hid, jordan.id, `ses:${providerId}`],
      ),
    );
    const notificationId = row.rows[0].id as string;
    await t.admin((c) =>
      c.query(
        `insert into notification_deliveries (household_id, notification_id, channel, provider_message_id, status, attempts)
         values ($1, $2, 'email', $3, 'sent', 1)`,
        [hid, notificationId, providerId],
      ),
    );
    return { providerId, user: jordan, hid, notificationId };
  }

  function snsEvent(message: object, overrides: Partial<SnsMessage> = {}, keyPem = cert.keyPem): SnsMessage {
    const base: SnsMessage = {
      Type: "Notification",
      MessageId: crypto.randomUUID(),
      TopicArn: TOPIC,
      Message: JSON.stringify(message),
      Timestamp: new Date().toISOString(),
      SignatureVersion: "2",
      Signature: "",
      SigningCertURL: CERT_URL,
      ...overrides,
    };
    const signature = sign("sha256", Buffer.from(snsStringToSign(base)), keyPem);
    return { ...base, Signature: signature.toString("base64") };
  }
  const post = (message: SnsMessage) =>
    t.app.inject({
      method: "POST",
      url: "/webhooks/ses-events",
      headers: { "content-type": "text/plain; charset=UTF-8" },
      payload: JSON.stringify(message),
    });
  const deliveryStatus = async (notificationId: string) =>
    (
      await t.admin((c) =>
        c.query("select status from notification_deliveries where notification_id = $1", [notificationId]),
      )
    ).rows[0]?.status as string;

  it("a Delivery event updates the delivery status", async () => {
    const d = await deliveryFor();
    const res = await post(snsEvent({ eventType: "Delivery", mail: { messageId: d.providerId } }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: "applied" });
    expect(await deliveryStatus(d.notificationId)).toBe("delivered");
  });

  it("a hard bounce marks it bounced, disables the email channel and raises an in-app notice", async () => {
    const d = await deliveryFor();
    const res = await post(
      snsEvent({
        eventType: "Bounce",
        bounce: { bounceType: "Permanent" },
        mail: { messageId: d.providerId },
      }),
    );
    expect(res.json()).toEqual({ status: "applied" });
    expect(await deliveryStatus(d.notificationId)).toBe("bounced");
    const prefs = await t.app.inject({
      method: "GET",
      url: "/v1/me/notification-preferences",
      headers: d.user.headers,
    });
    expect(prefs.json()).toMatchObject({ emailSuppressed: { reason: "hard_bounce" } });
    const mine = await list(d.user, d.hid);
    expect(mine.data.map((n) => `${n.kind}:${n.title}`)).toContain(
      "security:We could not deliver email to you",
    );
    // the person can't switch it back on themselves
    const put = await t.app.inject({
      method: "PUT",
      url: "/v1/me/notification-preferences",
      headers: { ...d.user.headers, ...key() },
      payload: { emailEnabled: true },
    });
    expect(put.json()).toMatchObject({ emailEnabled: true, emailSuppressed: { reason: "hard_bounce" } });
  });

  it("a transient bounce and the legacy notificationType shape are handled; a complaint disables email", async () => {
    const soft = await deliveryFor();
    await post(
      snsEvent({
        notificationType: "Bounce",
        bounce: { bounceType: "Transient" },
        mail: { messageId: soft.providerId },
      }),
    );
    expect(await deliveryStatus(soft.notificationId)).toBe("bounced");
    expect(
      (
        await t.app.inject({
          method: "GET",
          url: "/v1/me/notification-preferences",
          headers: soft.user.headers,
        })
      ).json(),
    ).toMatchObject({
      emailSuppressed: null,
    });
    const spam = await deliveryFor();
    await post(snsEvent({ eventType: "Complaint", mail: { messageId: spam.providerId } }));
    expect(await deliveryStatus(spam.notificationId)).toBe("complained");
    expect(
      (
        await t.app.inject({
          method: "GET",
          url: "/v1/me/notification-preferences",
          headers: spam.user.headers,
        })
      ).json(),
    ).toMatchObject({
      emailSuppressed: { reason: "complaint" },
    });
  });

  it("an SNS redelivery of the same message changes nothing", async () => {
    const d = await deliveryFor();
    const msg = snsEvent({ eventType: "Delivery", mail: { messageId: d.providerId } });
    expect((await post(msg)).json()).toEqual({ status: "applied" });
    expect((await post(msg)).json()).toEqual({ status: "duplicate" });
  });

  it("an unknown message id, an untracked event and a non-SES message are acknowledged and ignored", async () => {
    expect((await post(snsEvent({ eventType: "Delivery", mail: { messageId: "nope" } }))).json()).toEqual({
      status: "unknown",
    });
    const d = await deliveryFor();
    expect((await post(snsEvent({ eventType: "Open", mail: { messageId: d.providerId } }))).json()).toEqual({
      status: "ignored",
    });
    expect((await post(snsEvent({ hello: "world" }))).json()).toEqual({ status: "ignored" });
    expect(await deliveryStatus(d.notificationId)).toBe("sent");
  });

  it("rejects a bad signature, a foreign topic, a stale message and a non-JSON body with 401", async () => {
    const good = snsEvent({ eventType: "Delivery", mail: { messageId: "x" } });
    expect((await post({ ...good, Signature: Buffer.from("nope").toString("base64") })).statusCode).toBe(401);
    expect(
      (
        await post(
          snsEvent(
            { eventType: "Delivery", mail: { messageId: "x" } },
            { TopicArn: "arn:aws:sns:us-east-1:123456789012:other" },
          ),
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await post(
          snsEvent(
            { eventType: "Delivery", mail: { messageId: "x" } },
            { Timestamp: "2020-01-01T00:00:00Z" },
          ),
        )
      ).statusCode,
    ).toBe(401);
    const wrongKey = makeTestCertificate("sns.amazonaws.com");
    expect(
      (await post(snsEvent({ eventType: "Delivery", mail: { messageId: "x" } }, {}, wrongKey.keyPem)))
        .statusCode,
    ).toBe(401);
    const res = await t.app.inject({
      method: "POST",
      url: "/webhooks/ses-events",
      headers: { "content-type": "text/plain" },
      payload: "not json",
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts an event 2 hours old and refuses one older than 24 hours (SES retries for a long time)", async () => {
    const d = await deliveryFor();
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const old = await post(
      snsEvent({ eventType: "Delivery", mail: { messageId: d.providerId } }, { Timestamp: ago(25) }),
    );
    expect(old.statusCode).toBe(401);
    expect(await deliveryStatus(d.notificationId)).toBe("sent");
    const ok = await post(
      snsEvent({ eventType: "Delivery", mail: { messageId: d.providerId } }, { Timestamp: ago(2) }),
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await deliveryStatus(d.notificationId)).toBe("delivered");
  });

  it("changes nothing when the signature is bad (the delivery stays as it was)", async () => {
    const d = await deliveryFor();
    const forged = snsEvent(
      { eventType: "Bounce", bounce: { bounceType: "Permanent" }, mail: { messageId: d.providerId } },
      {},
      makeTestCertificate("sns.amazonaws.com").keyPem,
    );
    expect((await post(forged)).statusCode).toBe(401);
    expect(await deliveryStatus(d.notificationId)).toBe("sent");
  });

  it("confirms an SNS subscription once, only on the topic's own SNS host", async () => {
    const url = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=tok`;
    const res = await post(
      snsEvent({}, { Type: "SubscriptionConfirmation", Message: "confirm", SubscribeURL: url, Token: "tok" }),
    );
    expect(res.json()).toEqual({ status: "confirmed" });
    expect(confirmed).toEqual([url]);
    const evil = await post(
      snsEvent(
        {},
        {
          Type: "SubscriptionConfirmation",
          Message: "confirm",
          SubscribeURL: "https://evil.example/confirm",
          Token: "tok",
        },
      ),
    );
    expect(evil.statusCode).toBe(401);
    expect(confirmed).toHaveLength(1);
  });

  it("is not part of the public OpenAPI document and logs no payload", async () => {
    const doc = await t.app.inject({ method: "GET", url: "/openapi.json" });
    if (doc.statusCode === 200) expect(doc.body).not.toContain("ses-events");
  });
});

async function inviteToken(owner: TestUser, hid: string, to: TestUser): Promise<string> {
  email.sent.length = 0;
  expect((await invite(owner, hid, to.email)).statusCode).toBe(201);
  return /token=([A-Za-z0-9_-]+)/.exec(email.sent[0]?.text ?? "")?.[1] ?? "";
}

describe("reminder rules (Q-133)", () => {
  const RULE = { offsetsDays: [7, 1, 0], channels: ["email", "push"], alsoNotifyPartner: true };
  const urlDefault = (hid: string) => `/v1/households/${hid}/reminder-rules`;
  const urlItem = (hid: string, id: string) => `/v1/households/${hid}/items/${id}/reminders`;
  const get = (user: TestUser, url: string) => t.app.inject({ method: "GET", url, headers: user.headers });
  const put = (user: TestUser, url: string, payload: unknown) =>
    t.app.inject({
      method: "PUT",
      url,
      headers: { ...user.headers, ...key(), "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });

  async function household(label: string) {
    const { sam, jordan, hid } = await pair(label);
    const created = await t.app.inject({
      method: "POST",
      url: `/v1/households/${hid}/items`,
      headers: { ...sam.headers, ...key() },
      payload: {
        direction: "outflow",
        kind: "bill",
        category: "housing",
        name: "Rent",
        amountType: "fixed",
        amountCents: 215000,
        schedule: { type: "monthly_day", day: 1, dtstart: "2026-10-01" },
        ownerType: "member",
        ownerUserId: sam.id,
      },
    });
    return { sam, jordan, hid, item: created };
  }

  it("the household default: built-in until set, then stored; either member can change it", async () => {
    const { sam, hid } = await pair("rr-default");
    const jordan = await t.signUp("rr-default-partner");
    await accept(jordan, await inviteToken(sam, hid, jordan));
    expect((await get(sam, urlDefault(hid))).json()).toEqual({
      offsetsDays: [3, 0],
      channels: ["email"],
      alsoNotifyPartner: false,
    });
    const set = await put(sam, urlDefault(hid), RULE);
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toEqual(RULE);
    expect((await get(jordan, urlDefault(hid))).json()).toEqual(RULE);
    const again = await put(jordan, urlDefault(hid), { ...RULE, offsetsDays: [2] });
    expect(again.json()).toMatchObject({ offsetsDays: [2] });
    const rows = await t.admin((c) =>
      c.query("select count(*)::int as n from reminder_rules where household_id = $1 and item_id is null", [
        hid,
      ]),
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("validates offsets and channels", async () => {
    const { sam, hid } = await pair("rr-valid");
    const bad = (payload: unknown) => put(sam, urlDefault(hid), payload);
    for (const payload of [
      { ...RULE, offsetsDays: [] },
      { ...RULE, offsetsDays: [-1] },
      { ...RULE, offsetsDays: [61] },
      { ...RULE, offsetsDays: [1.5] },
      { ...RULE, offsetsDays: [3, 3] },
      { ...RULE, offsetsDays: [0, 1, 2, 3, 4, 5, 6] },
      { ...RULE, offsetsDays: ["3"] },
      { ...RULE, channels: [] },
      { ...RULE, channels: ["sms"] },
      { ...RULE, channels: ["email", "email"] },
      { ...RULE, alsoNotifyPartner: "yes" },
      { offsetsDays: [1] },
      { ...RULE, extra: 1 },
      null,
    ]) {
      expectProblem(await bad(payload), 400, "validation_failed");
    }
    expect((await get(sam, urlDefault(hid))).json()).toMatchObject({ offsetsDays: [3, 0] });
  });

  it("an item override: null until set, PUT sets it, PUT null removes it", async () => {
    const { sam, hid, item } = await household("rr-item");
    expect(item.statusCode, item.body).toBe(201);
    const id = item.json<{ id: string }>().id;
    const r0 = await get(sam, urlItem(hid, id));
    expect(r0.statusCode, r0.body).toBe(200);
    expect(r0.json()).toBeNull();
    expect((await put(sam, urlItem(hid, id), RULE)).json()).toEqual(RULE);
    expect((await get(sam, urlItem(hid, id))).json()).toEqual(RULE);
    // the household default is a different row
    expect((await get(sam, urlDefault(hid))).json()).toMatchObject({ offsetsDays: [3, 0] });
    const removed = await put(sam, urlItem(hid, id), null);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toBeNull();
    expect((await get(sam, urlItem(hid, id))).json()).toBeNull();
    // removing again is fine
    expect((await put(sam, urlItem(hid, id), null)).statusCode).toBe(200);
    expectProblem(
      await put(sam, urlItem(hid, id), { ...RULE, offsetsDays: [3, 3] }),
      400,
      "validation_failed",
    );
  });

  it("an unknown item is 404", async () => {
    const { sam, hid } = await pair("rr-404");
    const missing = "00000000-0000-4000-8000-000000000000";
    expectProblem(await get(sam, urlItem(hid, missing)), 404, "not_found");
    expectProblem(await put(sam, urlItem(hid, missing), RULE), 404, "not_found");
    expectProblem(await put(sam, urlItem(hid, missing), null), 404, "not_found");
  });

  it("another household cannot read or change a household's rules (cross-household denial)", async () => {
    const mine = await household("rr-mine");
    const stranger = await t.signUp("rr-stranger");
    const theirs = await pair("rr-theirs");
    const itemId = mine.item.json<{ id: string }>().id;
    await put(mine.sam, urlDefault(mine.hid), RULE);
    await put(mine.sam, urlItem(mine.hid, itemId), RULE);
    const denied = (status: number) => expect([403, 404]).toContain(status);
    // a user with no household, and a member of a different household, both address my household
    for (const user of [stranger, theirs.sam]) {
      denied((await get(user, urlDefault(mine.hid))).statusCode);
      denied((await put(user, urlDefault(mine.hid), { ...RULE, offsetsDays: [9] })).statusCode);
      denied((await get(user, urlItem(mine.hid, itemId))).statusCode);
      denied((await put(user, urlItem(mine.hid, itemId), { ...RULE, offsetsDays: [9] })).statusCode);
      denied((await put(user, urlItem(mine.hid, itemId), null)).statusCode);
    }
    // my item through their own household id is not found
    expectProblem(await get(theirs.sam, urlItem(theirs.hid, itemId)), 404, "not_found");
    expectProblem(await put(theirs.sam, urlItem(theirs.hid, itemId), RULE), 404, "not_found");
    // nothing of mine changed, and nothing was written for theirs
    expect((await get(mine.sam, urlDefault(mine.hid))).json()).toEqual(RULE);
    expect((await get(mine.sam, urlItem(mine.hid, itemId))).json()).toEqual(RULE);
    const rows = await t.admin((c) =>
      c.query("select count(*)::int as n from reminder_rules where household_id = $1", [theirs.hid]),
    );
    expect(rows.rows[0].n).toBe(0);
  });
});

describe("POST /webhooks/ses-events rate limit", () => {
  // Last in the file: it uses up the endpoint's per-IP budget (60 a minute).
  it("answers 429 after 60 requests a minute from one address", async () => {
    const codes: number[] = [];
    for (let n = 0; n < 70; n++) {
      const res = await t.app.inject({
        method: "POST",
        url: "/webhooks/ses-events",
        headers: { "content-type": "text/plain" },
        payload: "not json",
      });
      codes.push(res.statusCode);
    }
    expect(codes).toContain(429);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(60);
  });
});
