// WP-25 against a real Postgres (RLS as mp_api) with the fake billing provider: the signed webhook (signature,
// replay, idempotency), the worker-side apply, entitlements on Plus routes, the read-only downgrade, and the
// billing-owner rule. The worker's step is the real `applyBillingEvents` run as mp_worker.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  FEATURES,
  SubscriptionSnapshot,
  createFakeProvider,
  planFor,
  signFakeWebhook,
  type FakeWebhookBody,
} from "@mp/billing";
import { ENTITLEMENT_FEATURES } from "@mp/contracts";
import { planningUuid, seedFixture, seedPlanning } from "@mp/db/testing";
import { applyBillingEvents, createWorkerDb, type WorkerDb } from "@mp/db";
import { createTestApi, key, type TestApi, type TestUser } from "../../auth/testing/app";
import { expectProblem } from "../../lib/testing";

const FIXTURE = fileURLToPath(
  new URL("../../../../../design/fixtures/rivera-household.json", import.meta.url),
);
const SECRET = "test-only-webhook-secret";
const NOW = "2026-11-04T12:00:00Z";
const nowSeconds = () => Math.floor(Date.parse(NOW) / 1000);

let t: TestApi;
let worker: WorkerDb;

beforeAll(async () => {
  t = await createTestApi({
    now: () => NOW,
    billingProvider: createFakeProvider({ webhookSecret: SECRET }),
  });
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 2 });
}, 180_000);
afterAll(async () => {
  await t?.close();
  await worker?.close();
});

async function household(name = "Billing"): Promise<{ owner: TestUser; hid: string }> {
  const owner = await t.signUp("bill-owner");
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/households",
    headers: { ...owner.headers, ...key() },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return { owner, hid: (res.json() as { id: string }).id };
}

async function partnerOf(owner: TestUser, hid: string): Promise<TestUser> {
  const partner = await t.signUp("bill-partner");
  const inv = await t.app.inject({
    method: "POST",
    url: `/v1/households/${hid}/invites`,
    headers: { ...owner.headers, ...key() },
    payload: { email: partner.email },
  });
  expect(inv.statusCode).toBe(201);
  const token = t.sent.at(-1)?.token ?? "";
  const acc = await t.app.inject({
    method: "POST",
    url: "/v1/invites/accept",
    headers: partner.headers,
    payload: { token },
  });
  expect(acc.statusCode).toBe(200);
  return partner;
}

/** One subscription id per household, as a provider would have (the column is unique per provider). */
const subIds = new Map<string, string>();
function body(
  hid: string,
  over: Partial<FakeWebhookBody["data"]> = {},
  extra: Partial<FakeWebhookBody> = {},
) {
  return {
    id: `evt_${randomUUID()}`,
    type: "subscription.updated",
    occurred_at: "2026-11-03T11:00:00.000Z",
    data: {
      household_id: hid,
      customer_id: "cus_test",
      subscription_id: subIds.get(hid) ?? (subIds.set(hid, `sub_${randomUUID()}`), subIds.get(hid) as string),
      status: "active",
      interval: "month",
      current_period_end: "2026-12-04T00:00:00.000Z",
      cancel_at_period_end: false,
      ...over,
    },
    ...extra,
  } as FakeWebhookBody;
}

function post(
  b: FakeWebhookBody,
  opts: { secret?: string; ts?: number } = {},
): Promise<LightMyRequestResponse> {
  const signed = signFakeWebhook(opts.secret ?? SECRET, b, opts.ts ?? nowSeconds());
  return t.app.inject({
    method: "POST",
    url: "/webhooks/billing",
    headers: signed.headers,
    payload: signed.rawBody,
  });
}

/** What billing.sync does for the household. */
const sync = (hid: string) =>
  worker.withJobTx(hid, (tx) =>
    applyBillingEvents(tx, hid, {
      nowMs: Date.parse(NOW),
      parseSnapshot: (raw) => SubscriptionSnapshot.parse(raw),
      planFor,
    }),
  );

const planOf = async (user: TestUser, hid: string) =>
  (
    (
      await t.app.inject({ method: "GET", url: `/v1/households/${hid}/summary`, headers: user.headers })
    ).json() as { household: { plan: string } }
  ).household.plan;

/** The golden household under its own identity: seeded on Family Plus, with goals and a primary income. */
async function rivera() {
  const suffix = randomUUID().slice(0, 8);
  const fixture: unknown = JSON.parse(
    (await readFile(FIXTURE, "utf8"))
      .replaceAll("hh-rivera", `hh-rivera-${suffix}`)
      .replaceAll("m-sam", `m-sam-${suffix}`)
      .replaceAll("m-jordan", `m-jordan-${suffix}`)
      .replaceAll("rivera-7k2", `rivera-${suffix}`)
      .replaceAll("@rivera-household.example", `@${suffix}.example`),
  );
  const seeded = await seedFixture({ api: t.db, worker }, fixture);
  await seedPlanning({ api: t.db, worker }, seeded, fixture);
  return {
    hid: seeded.householdId,
    fx: (id: string) => planningUuid(seeded.householdId, id),
    sam: await t.as(`fixture|m-sam-${suffix}`, { claims: { email: `sam@${suffix}.example` } }),
    jordan: await t.as(`fixture|m-jordan-${suffix}`, { claims: { email: `jordan@${suffix}.example` } }),
  };
}

/** Ends the subscription the way a webhook plus billing.sync would. */
async function downgrade(hid: string, at = "2026-11-03T10:00:00.000Z") {
  await post(body(hid, { status: "expired" }, { occurred_at: at }));
  expect(await sync(hid)).toMatchObject({ plan: "free" });
}

const proposalsUrl = (hid: string) => `/v1/households/${hid}/proposals`;

const goal = { name: "Trip", type: "savings", targetCents: 100000 };
const addGoal = (user: TestUser, hid: string) =>
  t.app.inject({
    method: "POST",
    url: `/v1/households/${hid}/goals`,
    headers: { ...user.headers, ...key() },
    payload: goal,
  });

describe("webhook intake", () => {
  it("rejects a wrong signature, a stale timestamp and an unsigned request, queueing nothing", async () => {
    const { hid } = await household();
    expectProblem(await post(body(hid), { secret: "wrong" }), 401, "unauthorized");
    expectProblem(await post(body(hid), { ts: nowSeconds() - 3600 }), 401, "unauthorized");
    const unsigned = await t.app.inject({
      method: "POST",
      url: "/webhooks/billing",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(body(hid)),
    });
    expectProblem(unsigned, 401, "unauthorized");
    expect((await sync(hid)).applied).toBe(0);
  });

  it("rejects a signed but malformed body with 400", async () => {
    const { hid } = await household();
    const bad = body(hid, { status: "gold" as never });
    expectProblem(await post(bad), 400, "validation_failed");
  });

  it("is idempotent: the same event id queues once and applies once", async () => {
    const { owner, hid } = await household();
    const b = body(hid);
    expect((await post(b)).json()).toEqual({ status: "queued" });
    expect((await post(b)).json()).toEqual({ status: "duplicate" });
    expect(await planOf(owner, hid)).toBe("free"); // the API never sets the plan itself
    const first = await sync(hid);
    expect(first).toMatchObject({ applied: 1, plan: "family_plus", planChanged: true });
    expect(await planOf(owner, hid)).toBe("family_plus");
    const again = await sync(hid);
    expect(again).toMatchObject({ applied: 0, planChanged: false });
    expect((await post(b)).json()).toEqual({ status: "duplicate" });
    expect((await sync(hid)).applied).toBe(0);
  });

  it("ignores an event for a household that does not exist", async () => {
    const res = await post(body(randomUUID()));
    expect(res.statusCode).toBe(200);
  });

  it("applies events by time: an older event after a newer one is stale", async () => {
    const { owner, hid } = await household();
    await post(body(hid, { status: "active" }, { occurred_at: "2026-11-03T10:00:00.000Z" }));
    await sync(hid);
    await post(body(hid, { status: "expired" }, { occurred_at: "2026-11-03T11:30:00.000Z" }));
    await sync(hid);
    expect(await planOf(owner, hid)).toBe("free");
    await post(body(hid, { status: "active" }, { occurred_at: "2026-11-03T11:00:00.000Z" }));
    expect(await sync(hid)).toMatchObject({ stale: 1, applied: 0, plan: "free" });
    expect(await planOf(owner, hid)).toBe("free");
  });

  it("the plan cannot be set through the API", async () => {
    const { owner, hid } = await household();
    const res = await t.app.inject({
      method: "PATCH",
      url: `/v1/households/${hid}`,
      headers: { ...owner.headers, "if-match": '"1"' },
      payload: { plan: "family_plus" },
    });
    expect(res.statusCode).toBe(400);
    expect(await planOf(owner, hid)).toBe("free");
  });
});

describe("entitlements on Plus routes", () => {
  it("Free: goal writes answer 403 entitlement_required; reads work", async () => {
    const { owner, hid } = await household();
    expectProblem(await addGoal(owner, hid), 403, "entitlement_required");
    const read = await t.app.inject({
      method: "GET",
      url: `/v1/households/${hid}/goals`,
      headers: owner.headers,
    });
    expect(read.statusCode).not.toBe(403);
  });

  it("a downgrade makes goals read-only and deletes nothing", async () => {
    // The golden household is seeded on Family Plus with its goals and a primary income.
    const { hid, sam } = await rivera();
    const url = `/v1/households/${hid}/goals`;
    const list = async () =>
      (await t.app.inject({ method: "GET", url, headers: sam })).json() as {
        data: { id: string; name: string }[];
      };

    const before = await list();
    expect(before.data.length).toBeGreaterThan(0);
    const first = before.data[0] as { id: string; name: string };
    const add = () =>
      t.app.inject({
        method: "POST",
        url,
        headers: { ...sam, ...key() },
        payload: { name: "Trip", type: "savings", targetCents: 100000 },
      });
    expect([201, 202]).toContain((await add()).statusCode);

    await post(body(hid, { status: "expired" }, { occurred_at: "2026-11-03T10:00:00.000Z" }));
    expect(await sync(hid)).toMatchObject({ plan: "free", planChanged: true });

    expectProblem(await add(), 403, "entitlement_required");
    expectProblem(
      await t.app.inject({
        method: "PATCH",
        url: `${url}/${first.id}`,
        headers: { ...sam, "if-match": '"1"' },
        payload: { name: "Renamed" },
      }),
      403,
      "entitlement_required",
    );
    expectProblem(
      await t.app.inject({ method: "DELETE", url: `${url}/${first.id}`, headers: sam }),
      403,
      "entitlement_required",
    );
    // Nothing was deleted: every goal (including the one added on Plus) is still listed and readable.
    const after = await list();
    expect(after.data.length).toBe(before.data.length + 1);
    const one = await t.app.inject({ method: "GET", url: `${url}/${first.id}`, headers: sam });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { name: string }).name).toBe(first.name);

    // Resubscribing restores writes.
    await post(body(hid, { status: "active" }, { occurred_at: "2026-11-03T11:00:00.000Z" }));
    await sync(hid);
    expect([201, 202]).toContain((await add()).statusCode);
  });

  it("a canceled subscription keeps Plus until the paid period ends, then drops to Free", async () => {
    const { owner, hid } = await household();
    await post(
      body(hid, {
        status: "canceled",
        current_period_end: "2026-11-30T00:00:00.000Z",
        cancel_at_period_end: true,
      }),
    );
    expect(await sync(hid)).toMatchObject({ plan: "family_plus" });
    await post(
      body(
        hid,
        { status: "canceled", current_period_end: "2026-11-01T00:00:00.000Z" },
        { occurred_at: "2026-11-03T11:30:00.000Z" },
      ),
    );
    expect(await sync(hid)).toMatchObject({ plan: "free" });
    expect(await planOf(owner, hid)).toBe("free");
  });

  it("a stranger gets the module's own answer, not an entitlement answer", async () => {
    const { hid } = await household();
    const stranger = await t.signUp("bill-stranger");
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/households/${hid}/goals`,
      headers: { ...stranger.headers, ...key() },
      payload: goal,
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("forbidden"); // the module's own answer, not entitlement
  });

  it("the summary carries the feature map", async () => {
    const { owner, hid } = await household();
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/households/${hid}/summary`,
      headers: owner.headers,
    });
    const e = (res.json() as { entitlements: { features: Record<string, unknown> } }).entitlements;
    expect(Object.keys(e.features).sort()).toEqual([...FEATURES].sort());
    expect(e.features.goals).toEqual({ read: true, write: false });
  });

  it("contracts and @mp/billing name the same features", () => {
    expect([...ENTITLEMENT_FEATURES].sort()).toEqual([...FEATURES].sort());
  });
});

describe("billing routes", () => {
  it("only the billing owner (the creator) starts checkout and opens the portal", async () => {
    const { owner, hid } = await household();
    const partner = await partnerOf(owner, hid);

    const state = await t.app.inject({
      method: "GET",
      url: `/v1/households/${hid}/billing`,
      headers: partner.headers,
    });
    expect(state.json()).toMatchObject({
      plan: "free",
      status: null,
      isBillingOwner: false,
      available: true,
    });
    expect(JSON.stringify(state.json())).not.toContain("cus_");

    const asPartner = await t.app.inject({
      method: "POST",
      url: `/v1/households/${hid}/billing/checkout`,
      headers: partner.headers,
      payload: { interval: "year" },
    });
    expectProblem(asPartner, 403, "forbidden");
    expectProblem(
      await t.app.inject({
        method: "POST",
        url: `/v1/households/${hid}/billing/portal`,
        headers: partner.headers,
      }),
      403,
      "forbidden",
    );

    const asOwner = await t.app.inject({
      method: "POST",
      url: `/v1/households/${hid}/billing/checkout`,
      headers: owner.headers,
      payload: { interval: "year" },
    });
    expect(asOwner.statusCode).toBe(200);
    expect((asOwner.json() as { url: string }).url).toContain(hid);

    // No subscription yet, so there is no portal.
    expectProblem(
      await t.app.inject({
        method: "POST",
        url: `/v1/households/${hid}/billing/portal`,
        headers: owner.headers,
      }),
      409,
      "conflict",
    );
  });

  it("an active household gets 409 on checkout and a portal URL; its state shows the subscription", async () => {
    const { owner, hid } = await household();
    await post(body(hid));
    await sync(hid);
    const checkout = await t.app.inject({
      method: "POST",
      url: `/v1/households/${hid}/billing/checkout`,
      headers: owner.headers,
      payload: { interval: "month" },
    });
    expectProblem(checkout, 409, "conflict");
    const portal = await t.app.inject({
      method: "POST",
      url: `/v1/households/${hid}/billing/portal`,
      headers: owner.headers,
    });
    expect(portal.statusCode).toBe(200);
    const state = await t.app.inject({
      method: "GET",
      url: `/v1/households/${hid}/billing`,
      headers: owner.headers,
    });
    expect(state.json()).toMatchObject({
      plan: "family_plus",
      status: "active",
      interval: "month",
      isBillingOwner: true,
      entitlements: { features: { goals: { write: true } } },
    });
  });

  it("billing is isolated per household: a stranger sees 404", async () => {
    const { hid } = await household();
    const stranger = await t.signUp("bill-stranger2");
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/households/${hid}/billing`,
      headers: stranger.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("checkout and portal are not stored for replay (the response holds a one-time URL)", async () => {
    const { owner, hid } = await household();
    const k = key();
    const first = await t.app.inject({
      method: "POST",
      url: `/v1/households/${hid}/billing/checkout`,
      headers: { ...owner.headers, ...k },
      payload: { interval: "month" },
    });
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    const second = await t.app.inject({
      method: "POST",
      url: `/v1/households/${hid}/billing/checkout`,
      headers: { ...owner.headers, ...k },
      payload: { interval: "year" },
    });
    expect(second.statusCode).toBe(200);
  });
});

describe("no provider configured", () => {
  it("checkout answers 503 and the state says billing is unavailable", async () => {
    const bare = await createTestApi({ now: () => NOW });
    try {
      const owner = await bare.signUp("bill-bare");
      const res = await bare.app.inject({
        method: "POST",
        url: "/v1/households",
        headers: { ...owner.headers, ...key() },
        payload: { name: "Bare" },
      });
      const hid = (res.json() as { id: string }).id;
      const state = await bare.app.inject({
        method: "GET",
        url: `/v1/households/${hid}/billing`,
        headers: owner.headers,
      });
      expect(state.json()).toMatchObject({ available: false });
      const checkout = await bare.app.inject({
        method: "POST",
        url: `/v1/households/${hid}/billing/checkout`,
        headers: owner.headers,
        payload: { interval: "month" },
      });
      expect(checkout.statusCode).toBe(503);
      const hook = await bare.app.inject({ method: "POST", url: "/webhooks/billing", payload: {} });
      expect(hook.statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });
});

describe("M1 proposals cannot bypass the goals entitlement", () => {
  const makeProposal = (hid: string, headers: Record<string, string>, goalId: string) =>
    t.app.inject({
      method: "POST",
      url: proposalsUrl(hid),
      headers: { ...headers, ...key() },
      payload: { type: "goal_monthly", goalId, monthlyCents: 26000 },
    });

  it("a Free household cannot create a goal proposal (403 entitlement_required)", async () => {
    const r = await rivera();
    await downgrade(r.hid);
    expectProblem(await makeProposal(r.hid, r.sam, r.fx("g-tahoe")), 403, "entitlement_required");
  });

  it("a plan that lapses between create and approve blocks the approval and changes nothing", async () => {
    const r = await rivera();
    const created = await makeProposal(r.hid, r.sam, r.fx("g-tahoe"));
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;
    const goalUrl = `/v1/households/${r.hid}/goals/${r.fx("g-tahoe")}`;
    const monthly = async () =>
      (
        (await t.app.inject({ method: "GET", url: goalUrl, headers: r.sam })).json() as {
          monthlyCents: number;
        }
      ).monthlyCents;
    const before = await monthly();

    await downgrade(r.hid);
    const approve = await t.app.inject({
      method: "POST",
      url: `${proposalsUrl(r.hid)}/${id}/approve`,
      headers: r.jordan,
    });
    expectProblem(approve, 409, "conflict");
    const after = await t.app.inject({ method: "GET", url: `${proposalsUrl(r.hid)}/${id}`, headers: r.sam });
    expect((after.json() as { status: string }).status).toBe("superseded");
    expect(await monthly()).toBe(before);
  });

  it("on Plus the same approval applies", async () => {
    const r = await rivera();
    const created = await makeProposal(r.hid, r.sam, r.fx("g-tahoe"));
    const id = (created.json() as { id: string }).id;
    const approve = await t.app.inject({
      method: "POST",
      url: `${proposalsUrl(r.hid)}/${id}/approve`,
      headers: r.jordan,
    });
    expect(approve.statusCode, approve.body).toBe(200);
  });

  it("a Free household can still list, read and reject proposals", async () => {
    const r = await rivera();
    const created = await makeProposal(r.hid, r.sam, r.fx("g-tahoe"));
    const id = (created.json() as { id: string }).id;
    await downgrade(r.hid);
    const list = await t.app.inject({ method: "GET", url: proposalsUrl(r.hid), headers: r.sam });
    expect(list.statusCode).toBe(200);
    const reject = await t.app.inject({
      method: "POST",
      url: `${proposalsUrl(r.hid)}/${id}/reject`,
      headers: r.jordan,
    });
    expect(reject.statusCode).toBe(200);
  });
});

describe("M2 a forged occurred_at cannot pin the plan", () => {
  it("rejects an event dated more than 5 minutes ahead, and queues nothing", async () => {
    const { owner, hid } = await household();
    const forged = await post(body(hid, { status: "active" }, { occurred_at: "2030-01-01T00:00:00.000Z" }));
    expectProblem(forged, 400, "validation_failed");
    expect((await sync(hid)).applied).toBe(0);
    // Real events still apply afterwards: a later real downgrade is not stale.
    await post(body(hid, { status: "active" }, { occurred_at: "2026-11-03T11:00:00.000Z" }));
    await sync(hid);
    await post(body(hid, { status: "expired" }, { occurred_at: "2026-11-03T11:30:00.000Z" }));
    expect(await sync(hid)).toMatchObject({ plan: "free", applied: 1 });
    expect(await planOf(owner, hid)).toBe("free");
  });

  it("an event dated inside the allowance is stored no later than it was received", async () => {
    const { hid } = await household();
    // The ingest function checks against the database clock (real time), so date it from real time.
    const soon = new Date(Date.now() + 4 * 60_000).toISOString();
    const res = await post(body(hid, { status: "active" }, { occurred_at: soon }));
    expect(res.statusCode, res.body).toBe(200);
    await sync(hid);
    const stored = await t.admin((c) =>
      c.query<{ ok: boolean }>(
        "select last_event_at <= now() as ok from subscriptions where household_id = $1",
        [hid],
      ),
    );
    expect(stored.rows[0]?.ok).toBe(true);
  });

  it("rejects an unknown event type and a payload without a valid subscription", async () => {
    const { hid } = await household();
    expectProblem(await post(body(hid, {}, { type: "Not A Type!" })), 400, "validation_failed");
    const ingest = (payload: string) =>
      t.admin((c) =>
        c
          .query(
            "select app_billing_ingest('fake', $1, $2::uuid, 'subscription.updated', now(), $3::jsonb)",
            [`evt_${randomUUID()}`, hid, payload],
          )
          .then(
            () => "accepted",
            (e: { message: string }) => e.message,
          ),
      );
    expect(await ingest('{"subscription":{"status":"gold"}}')).toContain("billing_event_invalid");
    expect(await ingest("[]")).toContain("billing_event_invalid");
    expect(await ingest("{}")).toContain("billing_event_invalid");
  });
});

describe("Q-152 the portal needs step-up MFA; checkout does not", () => {
  it("answers mfa_required without a fresh second factor, and 200 with one", async () => {
    const { owner, hid } = await household();
    await post(body(hid));
    await sync(hid);
    const url = `/v1/households/${hid}/billing/portal`;
    const weak = await t.as(owner.subject, { claims: { email: owner.email, mfa_verified_at: undefined } });
    expectProblem(await t.app.inject({ method: "POST", url, headers: weak }), 403, "mfa_required");
    const stale = await t.as(owner.subject, {
      claims: { email: owner.email, mfa_verified_at: Math.floor(Date.now() / 1000) - 601 },
    });
    expectProblem(await t.app.inject({ method: "POST", url, headers: stale }), 403, "mfa_required");
    const ok = await t.app.inject({ method: "POST", url, headers: owner.headers });
    expect(ok.statusCode).toBe(200);
  });

  it("checkout works without step-up", async () => {
    const { owner, hid } = await household();
    const weak = await t.as(owner.subject, { claims: { email: owner.email, mfa_verified_at: undefined } });
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/households/${hid}/billing/checkout`,
      headers: weak,
      payload: { interval: "month" },
    });
    expect(res.statusCode).toBe(200);
  });
});
