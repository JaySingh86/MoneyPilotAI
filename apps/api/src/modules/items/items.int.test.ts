// Items API against a real Postgres (RLS as mp_api) with the real auth layer: the seeded Rivera household,
// If-Match, idempotency, schedule rebuilds, occurrence actions, the interim approval guard (M-1), household
// PATCH of the primary income, leave reassignment and tenant isolation.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createWorkerDb, type WorkerDb } from "@mp/db";
import { planningUuid, seedFixture, seedPlanning, type SeedResult } from "@mp/db/testing";
import { createTestApi, key as idemKey, type TestApi, type TestUser } from "../../auth/testing/app";
import { expectProblem } from "../../lib/testing";

let t: TestApi;
let worker: WorkerDb;
let seeded: SeedResult;
let samHeaders: Record<string, string>;
let jordanHeaders: Record<string, string>;
let strangerUser: TestUser;

const fx = (id: string) => planningUuid(seeded.householdId, id);
const SAM = () => seeded.userIds.creator;
const JORDAN = () => seeded.userIds.partner;
const base = () => `/v1/households/${seeded.householdId}`;
const sam = () => samHeaders;
const jordan = () => jordanHeaders;
const app = {
  inject: (opts: InjectOptions) => t.app.inject(opts),
};

beforeAll(async () => {
  t = await createTestApi();
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 2 });
  const fixture: unknown = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../../../../../design/fixtures/rivera-household.json", import.meta.url)),
      "utf8",
    ),
  );
  seeded = await seedFixture({ api: t.db, worker }, fixture);
  await seedPlanning({ api: t.db, worker }, seeded, fixture);
  samHeaders = await t.as("fixture|m-sam", { claims: { email: "sam@rivera-household.example" } });
  jordanHeaders = await t.as("fixture|m-jordan", { claims: { email: "jordan@rivera-household.example" } });
  strangerUser = await t.signUp("stranger");
}, 180_000);

afterAll(async () => {
  await t?.close();
  await worker?.close();
});

const key = idemKey;

const newBill = (over: Record<string, unknown> = {}) => ({
  direction: "outflow",
  kind: "bill",
  category: "other",
  name: "Gym",
  amountType: "fixed",
  amountCents: 4500,
  schedule: { type: "monthly_day", day: 12, dtstart: "2026-10-01" },
  ownerType: "member",
  ownerUserId: SAM(),
  ...over,
});

async function createBill(over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: `${base()}/items`,
    headers: { ...sam(), ...key() },
    payload: newBill(over),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

// Runs first, before other tests add occurrences of their own.
describe("seeded calendar", () => {
  it("lists November: 16 bills and 3 paychecks (DESIGN_SPEC §5.1)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${base()}/occurrences?from=2026-11-01&to=2026-11-30`,
      headers: sam(),
    });
    const rows = res.json().data as { itemId: string }[];
    expect(rows).toHaveLength(19);
    expect(rows.filter((r) => r.itemId === fx("inc-sam") || r.itemId === fx("inc-jordan"))).toHaveLength(3);
  });
});

describe("items", () => {
  it("lists the Bills & recurring page: 18 items, renewal-only ones excluded (Q-020)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${base()}/items?onBillsPage=true&limit=100`,
      headers: sam(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(18);
    const all = await app.inject({ method: "GET", url: `${base()}/items?limit=100`, headers: sam() });
    expect(all.json().data).toHaveLength(26);
  });

  it("filters by owner (a partner's items plus Both) and paginates by cursor", async () => {
    const jordan = await app.inject({
      method: "GET",
      url: `${base()}/items?owner=${JORDAN()}&direction=outflow&limit=100`,
      headers: sam(),
    });
    expect(jordan.json().data.every((i: { ownerUserId: string }) => i.ownerUserId === JORDAN())).toBe(true);
    const first = (
      await app.inject({ method: "GET", url: `${base()}/items?limit=10`, headers: sam() })
    ).json();
    expect(first.data).toHaveLength(10);
    const second = (
      await app.inject({
        method: "GET",
        url: `${base()}/items?limit=100&cursor=${first.nextCursor}`,
        headers: sam(),
      })
    ).json();
    expect(second.data).toHaveLength(16);
    expect(second.nextCursor).toBeNull();
  });

  it("returns the friendly schedule, never RRULE, with renewal details and an ETag", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${base()}/items/${fx("b-carins")}`,
      headers: sam(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe(`"${res.json().version}"`);
    expect(res.json()).toMatchObject({
      schedule: { type: "every_n_months", n: 6, dtstart: "2026-11-04" },
      renewal: { autoRenews: "yes", coverageEnd: "2026-11-04" },
      amountCents: 68400,
    });
    expect(JSON.stringify(res.json())).not.toContain("FREQ=");
  });

  it("creates with an Idempotency-Key, materializes occurrences, and replays a retry", async () => {
    const headers = { ...sam(), "idempotency-key": "create-gym" };
    const send = () =>
      app.inject({ method: "POST", url: `${base()}/items`, headers, payload: newBill({ name: "Gym A" }) });
    const first = await send();
    expect(first.statusCode).toBe(201);
    expect(first.headers.location).toBe(`${base()}/items/${first.json().id}`);
    expect((await send()).headers["idempotent-replayed"]).toBe("true");
    const occ = await app.inject({
      method: "GET",
      url: `${base()}/occurrences?from=2026-11-01&to=2026-11-30&itemId=${first.json().id}`,
      headers: sam(),
    });
    expect(occ.json().data.map((o: { dueOn: string }) => o.dueOn)).toEqual(["2026-11-12"]);
    const noKey = await app.inject({
      method: "POST",
      url: `${base()}/items`,
      headers: sam(),
      payload: newBill(),
    });
    expectProblem(noKey, 400, "validation_failed");
  });

  it("rejects a bad schedule, a non-member owner and a fixed amount without cents", async () => {
    const post = (payload: object) =>
      app.inject({ method: "POST", url: `${base()}/items`, headers: { ...sam(), ...key() }, payload });
    expectProblem(
      await post(newBill({ schedule: { type: "monthly_day", day: 40, dtstart: "2026-10-01" } })),
      400,
      "validation_failed",
    );
    expectProblem(await post(newBill({ ownerUserId: strangerUser.id })), 400, "validation_failed");
    expectProblem(await post(newBill({ amountCents: null })), 400, "validation_failed");
    expectProblem(await post(newBill({ amountCents: 10.5 })), 400, "validation_failed");
  });

  it("requires an amount for estimated and statement items, at create and patch (Q-107)", async () => {
    const post = (payload: object) =>
      app.inject({ method: "POST", url: `${base()}/items`, headers: { ...sam(), ...key() }, payload });
    expectProblem(
      await post(newBill({ amountType: "estimated", amountCents: null })),
      400,
      "validation_failed",
    );
    expectProblem(
      await post(newBill({ amountType: "statement", amountCents: null })),
      400,
      "validation_failed",
    );
    const fixed = await createBill({ name: "Amount patch" });
    const patch = (payload: object) =>
      app.inject({
        method: "PATCH",
        url: `${base()}/items/${fixed.id}`,
        headers: { ...sam(), "if-match": `"${fixed.version}"` },
        payload,
      });
    expectProblem(await patch({ amountCents: null }), 400, "validation_failed");
    const ok = await patch({ amountType: "estimated" }); // keeps the stored amount as its estimate
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ amountType: "estimated", amountCents: 4500 });
  });

  it("answers a stale If-Match with 409 and the current item; a missing one with 428", async () => {
    const item = await createBill({ name: "Stale test" });
    const patch = (version: string, payload: object) =>
      app.inject({
        method: "PATCH",
        url: `${base()}/items/${item.id}`,
        headers: { ...sam(), "if-match": version },
        payload,
      });
    const ok = await patch('"1"', { name: "Stale test 2" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    const stale = expectProblem(await patch('"1"', { name: "Late edit" }), 409, "conflict");
    expect(stale.current).toMatchObject({ name: "Stale test 2", version: 2 });
    expectProblem(
      await app.inject({
        method: "PATCH",
        url: `${base()}/items/${item.id}`,
        headers: sam(),
        payload: { name: "x" },
      }),
      428,
      "precondition_required",
    );
  });

  it("a schedule change rebuilds only future scheduled occurrences; paid ones stay", async () => {
    const item = await createBill({
      name: "Rebuild",
      schedule: { type: "monthly_day", day: 15, dtstart: "2026-01-15" },
    });
    const list = async () =>
      (
        await app.inject({
          method: "GET",
          url: `${base()}/occurrences?from=2026-10-01&to=2027-01-31&itemId=${item.id}`,
          headers: sam(),
        })
      ).json().data as { id: string; scheduledOn: string; dueOn: string; status: string; version: number }[];
    const before = await list();
    const nov = before.find((o) => o.scheduledOn === "2026-11-15");
    expect(nov).toBeDefined();
    const paid = await app.inject({
      method: "PATCH",
      url: `${base()}/occurrences/${nov!.id}`,
      headers: { ...sam(), "if-match": `"${nov!.version}"` },
      payload: { status: "paid" },
    });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({ status: "paid", paidOn: "2026-10-27", markedBy: SAM() });

    const res = await app.inject({
      method: "PATCH",
      url: `${base()}/items/${item.id}`,
      headers: { ...sam(), "if-match": '"1"' },
      payload: { schedule: { type: "monthly_day", day: 20, dtstart: "2026-01-20" } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await list();
    expect(after.find((o) => o.scheduledOn === "2026-10-15")?.status).toBe("scheduled"); // past: untouched
    expect(after.find((o) => o.scheduledOn === "2026-11-15")?.status).toBe("paid");
    const future = after.filter((o) => o.status === "scheduled" && o.scheduledOn >= "2026-10-27");
    expect(future.map((o) => o.scheduledOn)).toEqual(["2026-11-20", "2026-12-20", "2027-01-20"]);
  });

  it("soft-deletes an item and removes its future occurrences; the primary income cannot be deleted", async () => {
    const item = await createBill({ name: "To delete" });
    const del = await app.inject({ method: "DELETE", url: `${base()}/items/${item.id}`, headers: sam() });
    expect(del.statusCode).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: `${base()}/items/${item.id}`, headers: sam() })).statusCode,
    ).toBe(404);
    const occ = await app.inject({
      method: "GET",
      url: `${base()}/occurrences?from=2026-10-27&to=2027-10-27&itemId=${item.id}`,
      headers: sam(),
    });
    expect(occ.json().data).toEqual([]);
    expectProblem(
      await app.inject({
        method: "DELETE",
        url: `${base()}/items/${fx("inc-sam")}`,
        headers: sam(),
      }),
      409,
      "conflict",
    );
  });

  it("stores renewal details with PUT and lists amount history", async () => {
    const put = await app.inject({
      method: "PUT",
      url: `${base()}/items/${fx("b-rent")}/renewal`,
      headers: sam(),
      payload: { autoRenews: "no", coverageEnd: "2027-06-30", cancelBy: "2027-05-30" },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().renewal).toMatchObject({
      autoRenews: "no",
      coverageEnd: "2027-06-30",
      decisionBy: null,
    });
    const hist = await app.inject({
      method: "GET",
      url: `${base()}/items/${fx("b-power")}/history`,
      headers: sam(),
    });
    expect(hist.json().data.map((h: { amountCents: number }) => h.amountCents)).toEqual([
      11800, 17100, 13700,
    ]);
  });
});

describe("occurrences", () => {
  const nov = async (itemFixtureId: string) => {
    const res = await app.inject({
      method: "GET",
      url: `${base()}/occurrences?from=2026-11-01&to=2026-11-30&itemId=${fx(itemFixtureId)}`,
      headers: sam(),
    });
    return res.json().data[0] as { id: string; version: number; dueOn: string; scheduledOn: string };
  };
  const patch = (o: { id: string; version: number }, payload: object, version = o.version) =>
    app.inject({
      method: "PATCH",
      url: `${base()}/occurrences/${o.id}`,
      headers: { ...sam(), "if-match": `"${version}"` },
      payload,
    });

  it("limits the range", async () => {
    expectProblem(
      await app.inject({
        method: "GET",
        url: `${base()}/occurrences?from=2026-01-01&to=2028-01-01`,
        headers: sam(),
      }),
      400,
      "validation_failed",
    );
  });

  it("moves one occurrence (due date only), and only while it is upcoming", async () => {
    const o = await nov("b-water");
    const moved = await patch(o, { dueOn: "2026-11-20" });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ dueOn: "2026-11-20", scheduledOn: "2026-11-18", movedBy: SAM() });
    const paid = await patch({ id: o.id, version: 2 }, { status: "paid", paidOn: "2026-11-20" });
    expect(paid.statusCode).toBe(200);
    expectProblem(await patch({ id: o.id, version: 3 }, { dueOn: "2026-11-10" }), 400, "validation_failed");
  });

  it("sets an actual amount and records it as history", async () => {
    const o = await nov("b-power");
    const res = await patch(o, { actualAmountCents: 15137 });
    expect(res.json()).toMatchObject({ actualAmountCents: 15137 });
    const hist = await app.inject({
      method: "GET",
      url: `${base()}/items/${fx("b-power")}/history`,
      headers: sam(),
    });
    expect(
      hist
        .json()
        .data.some(
          (h: { amountCents: number; occurredOn: string }) =>
            h.amountCents === 15137 && h.occurredOn === o.dueOn,
        ),
    ).toBe(true);
  });

  it("skips, undoes, and enforces paid for bills vs received for income", async () => {
    const o = await nov("b-fit");
    const skipped = await patch(o, { status: "skipped" });
    expect(skipped.json()).toMatchObject({ status: "skipped", paidOn: null });
    const undone = await patch({ id: o.id, version: 2 }, { status: "scheduled" });
    expect(undone.json()).toMatchObject({ status: "scheduled", markedBy: null });
    expectProblem(await patch({ id: o.id, version: 3 }, { status: "received" }), 400, "validation_failed");
    const pay = await nov("inc-sam");
    expectProblem(await patch(pay, { status: "paid" }), 400, "validation_failed");
    expect((await patch(pay, { status: "received" })).statusCode).toBe(200);
  });

  it("returns 409 with a stale version", async () => {
    const o = await nov("b-cloud");
    expect((await patch(o, { status: "skipped" })).statusCode).toBe(200);
    expectProblem(await patch(o, { status: "paid" }, o.version), 409, "conflict");
  });
});

describe("planned expenses and balances", () => {
  it("creates, updates with If-Match and deletes a planned expense", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${base()}/planned-expenses`,
      headers: { ...sam(), ...key() },
      payload: { name: "Car repair", amountCents: 180000, dueOn: "2026-11-02", ownerType: "both" },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id;
    const up = await app.inject({
      method: "PATCH",
      url: `${base()}/planned-expenses/${id}`,
      headers: { ...sam(), "if-match": '"1"' },
      payload: { amountCents: 90000 },
    });
    expect(up.json()).toMatchObject({ amountCents: 90000, version: 2 });
    expectProblem(
      await app.inject({
        method: "PATCH",
        url: `${base()}/planned-expenses/${id}`,
        headers: { ...sam(), "if-match": '"1"' },
        payload: { name: "x" },
      }),
      409,
      "conflict",
    );
    const list = await app.inject({ method: "GET", url: `${base()}/planned-expenses`, headers: sam() });
    expect(list.json().data.map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining(["Thanksgiving", "Car repair"]),
    );
    expect(
      (await app.inject({ method: "DELETE", url: `${base()}/planned-expenses/${id}`, headers: sam() }))
        .statusCode,
    ).toBe(204);
  });

  it("rejects paying a planned expense from a goal that does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${base()}/planned-expenses`,
      headers: { ...sam(), ...key() },
      payload: {
        name: "Trip",
        amountCents: 100,
        dueOn: "2026-11-02",
        ownerType: "both",
        goalId: "00000000-0000-4000-8000-0000000000aa",
      },
    });
    expectProblem(res, 400, "validation_failed");
  });

  it("records a balance and returns the latest by date", async () => {
    expect(
      (await app.inject({ method: "GET", url: `${base()}/balances/latest`, headers: sam() })).json(),
    ).toMatchObject({
      amountCents: 340000,
      asOf: "2026-10-27",
    });
    const res = await app.inject({
      method: "POST",
      url: `${base()}/balances`,
      headers: { ...jordan(), ...key() },
      payload: { amountCents: 351234, asOf: "2026-10-28" },
    });
    expect(res.statusCode).toBe(201);
    expect(
      (await app.inject({ method: "GET", url: `${base()}/balances/latest`, headers: sam() })).json()
        .amountCents,
    ).toBe(351234);
  });
});

describe("tenant isolation", () => {
  it("a stranger sees no items, cannot read one, and cannot write", async () => {
    const h = strangerUser.headers;
    const list = await app.inject({ method: "GET", url: `${base()}/items`, headers: h });
    expect(list.json().data).toEqual([]);
    expectProblem(
      await app.inject({ method: "GET", url: `${base()}/items/${fx("b-rent")}`, headers: h }),
      404,
      "not_found",
    );
    expectProblem(
      await app.inject({
        method: "POST",
        url: `${base()}/items`,
        headers: { ...h, ...key() },
        payload: newBill({ ownerUserId: undefined, ownerType: "both" }),
      }),
      403,
      "forbidden",
    );
    expectProblem(
      await app.inject({
        method: "PATCH",
        url: `${base()}/items/${fx("b-rent")}`,
        headers: { ...h, "if-match": '"1"' },
        payload: { name: "x" },
      }),
      404,
      "not_found",
    );
    expectProblem(
      await app.inject({ method: "GET", url: `${base()}/balances/latest`, headers: h }),
      404,
      "not_found",
    );
  });

  it("requires sign-in", async () => {
    expectProblem(await app.inject({ method: "GET", url: `${base()}/items` }), 401, "unauthorized");
  });
});

// ===== G1 round: M-1 interim approval guard, L-3, source, household primary income, leave =====
describe("M-1: the other member's item needs approval until proposals exist (WP-13)", () => {
  const etag = async (headers: Record<string, string>, id: string) =>
    (await app.inject({ method: "GET", url: `${base()}/items/${id}`, headers })).headers.etag as string;
  const patchItem = async (headers: Record<string, string>, id: string, payload: object) =>
    app.inject({
      method: "PATCH",
      url: `${base()}/items/${id}`,
      headers: { ...headers, "if-match": await etag(headers, id) },
      payload,
    });
  const firstOccurrence = async (headers: Record<string, string>, id: string) =>
    (
      await app.inject({
        method: "GET",
        url: `${base()}/occurrences?from=2026-11-01&to=2026-11-30&itemId=${id}`,
        headers,
      })
    ).json().data[0] as { id: string; version: number; dueOn: string };
  const move = (headers: Record<string, string>, o: { id: string; version: number }, dueOn: string) =>
    app.inject({
      method: "PATCH",
      url: `${base()}/occurrences/${o.id}`,
      headers: { ...headers, "if-match": `"${o.version}"` },
      payload: { dueOn },
    });

  const directions = [
    ["Sam acting on Jordan's item", () => sam(), () => fx("b-rent"), () => SAM()],
    ["Jordan acting on Sam's item", () => jordan(), () => fx("b-car"), () => JORDAN()],
  ] as const;

  describe.each(directions)("%s", (_name, actor, itemId, actorId) => {
    it("cannot delete it, change its owner or status", async () => {
      expectProblem(
        await app.inject({ method: "DELETE", url: `${base()}/items/${itemId()}`, headers: actor() }),
        403,
        "approval_required",
      );
      expectProblem(
        await patchItem(actor(), itemId(), { ownerType: "both", ownerUserId: null }),
        403,
        "approval_required",
      );
      expectProblem(await patchItem(actor(), itemId(), { status: "paused" }), 403, "approval_required");
      expectProblem(
        await patchItem(actor(), itemId(), { ownerType: "member", ownerUserId: actorId() }),
        403,
        "approval_required",
      );
    });

    it("cannot move one of its occurrences, but can mark it paid and edit its notes", async () => {
      const o = await firstOccurrence(actor(), itemId());
      expectProblem(await move(actor(), o, "2026-11-25"), 403, "approval_required");
      const paid = await app.inject({
        method: "PATCH",
        url: `${base()}/occurrences/${o.id}`,
        headers: { ...actor(), "if-match": `"${o.version}"` },
        payload: { status: "paid" },
      });
      expect(paid.statusCode, paid.body).toBe(200);
      expect((await patchItem(actor(), itemId(), { notes: "Paid early" })).statusCode).toBe(200);
    });
  });

  it("a member's own items and Both items stay directly editable by either member", async () => {
    const both = await createBill({ name: "Shared", ownerType: "both", ownerUserId: null });
    const asJordan = (payload: object) => patchItem(jordan(), both.id, payload);
    expect((await asJordan({ status: "paused" })).statusCode).toBe(200);
    expect((await asJordan({ status: "active", ownerType: "split", ownerUserId: null })).statusCode).toBe(
      200,
    );
    const o = await firstOccurrence(jordan(), both.id);
    expect((await move(jordan(), o, "2026-11-20")).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "DELETE", url: `${base()}/items/${both.id}`, headers: jordan() }))
        .statusCode,
    ).toBe(204);

    const own = await createBill({ name: "Mine" });
    expect((await patchItem(sam(), own.id, { status: "paused" })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "DELETE", url: `${base()}/items/${own.id}`, headers: sam() })).statusCode,
    ).toBe(204);
  });
});

describe("G1 fixes at the API", () => {
  it("M-2: a client cannot name the source of a new item", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${base()}/items`,
      headers: { ...sam(), ...key() },
      payload: { ...newBill(), source: "email" },
    });
    expectProblem(res, 400, "validation_failed");
    expect((await createBill()).source).toBe("manual");
  });

  it("L-1: an owner outside the household is a 400, not a database error", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${base()}/items`,
      headers: { ...sam(), ...key() },
      payload: newBill({ ownerUserId: strangerUser.id }),
    });
    expectProblem(res, 400, "validation_failed");
  });

  it("L-2: money over the cap, a non-hostname providerDomain and a non-uuid cursor are 400s", async () => {
    const post = (payload: object) =>
      app.inject({ method: "POST", url: `${base()}/items`, headers: { ...sam(), ...key() }, payload });
    expectProblem(await post(newBill({ amountCents: 100_000_000_001 })), 400, "validation_failed");
    expectProblem(
      await post(newBill({ providerDomain: "http://169.254.169.254/" })),
      400,
      "validation_failed",
    );
    expectProblem(
      await app.inject({ method: "GET", url: `${base()}/items?cursor=abc'`, headers: sam() }),
      400,
      "validation_failed",
    );
  });

  it("L-3: an occurrence of a soft-deleted item cannot be changed", async () => {
    const item = await createBill({ name: "Deleted soon" });
    const occ = (
      await app.inject({
        method: "GET",
        url: `${base()}/occurrences?from=2026-10-27&to=2027-10-27&itemId=${item.id}`,
        headers: sam(),
      })
    ).json().data[0] as { id: string; version: number };
    expect(
      (await app.inject({ method: "DELETE", url: `${base()}/items/${item.id}`, headers: sam() })).statusCode,
    ).toBe(204);
    expectProblem(
      await app.inject({
        method: "PATCH",
        url: `${base()}/occurrences/${occ.id}`,
        headers: { ...sam(), "if-match": `"${occ.version}"` },
        payload: { status: "skipped" },
      }),
      404,
      "not_found",
    );
  });
});

describe("household PATCH: primaryIncomeItemId (Q-086)", () => {
  const patch = async (payload: object, headers = sam()) => {
    const current = await app.inject({ method: "GET", url: `/v1/households/${seeded.householdId}`, headers });
    return app.inject({
      method: "PATCH",
      url: `/v1/households/${seeded.householdId}`,
      headers: { ...headers, "if-match": current.headers.etag as string },
      payload,
    });
  };

  it("accepts a live income item of the household", async () => {
    const res = await patch({ primaryIncomeItemId: fx("inc-jordan") });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().primaryIncomeItemId).toBe(fx("inc-jordan"));
    expect((await patch({ primaryIncomeItemId: fx("inc-sam") })).json().primaryIncomeItemId).toBe(
      fx("inc-sam"),
    );
  });

  it("rejects a bill, a deleted item, an unknown id and another household's item", async () => {
    expectProblem(await patch({ primaryIncomeItemId: fx("b-rent") }), 400, "validation_failed");
    expectProblem(
      await patch({ primaryIncomeItemId: "00000000-0000-4000-8000-0000000000bb" }),
      400,
      "validation_failed",
    );
    const other = await t.signUp("other-owner");
    const h = await app.inject({
      method: "POST",
      url: "/v1/households",
      headers: { ...other.headers, ...key() },
      payload: { name: "Other" },
    });
    const otherHid = h.json().id as string;
    const inc = await app.inject({
      method: "POST",
      url: `/v1/households/${otherHid}/items`,
      headers: { ...other.headers, ...key() },
      payload: newBill({
        direction: "inflow",
        kind: "income",
        category: "income",
        ownerUserId: other.id,
        name: "Pay",
      }),
    });
    expect(inc.statusCode, inc.body).toBe(201);
    expectProblem(await patch({ primaryIncomeItemId: inc.json().id }), 400, "validation_failed");
    const own = await app.inject({
      method: "POST",
      url: `${base()}/items`,
      headers: { ...sam(), ...key() },
      payload: newBill({ direction: "inflow", kind: "income", category: "income", name: "Side income" }),
    });
    await app.inject({ method: "DELETE", url: `${base()}/items/${own.json().id}`, headers: sam() });
    expectProblem(await patch({ primaryIncomeItemId: own.json().id }), 400, "validation_failed");
  });
});

describe("leave: the leaver's items go to the remaining member (LeaveHooks.reassignOwnedItems)", () => {
  it("reassigns items and planned expenses and leaves no stale owner", async () => {
    const a = await t.signUp("leave-a");
    const b = await t.signUp("leave-b");
    const created = await app.inject({
      method: "POST",
      url: "/v1/households",
      headers: { ...a.headers, ...key() },
      payload: { name: "Leavers" },
    });
    const hid = created.json().id as string;
    await app.inject({
      method: "POST",
      url: `/v1/households/${hid}/invites`,
      headers: { ...a.headers, ...key() },
      payload: { email: b.email },
    });
    const token = t.sent.at(-1)?.token ?? "";
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/invites/accept",
          headers: b.headers,
          payload: { token },
        })
      ).statusCode,
    ).toBe(200);

    const mk = async (owner: string, name: string) =>
      app.inject({
        method: "POST",
        url: `/v1/households/${hid}/items`,
        headers: { ...a.headers, ...key() },
        payload: newBill({ name, ownerUserId: owner }),
      });
    const bItem = (await mk(b.id, "B's bill")).json();
    const aItem = (await mk(a.id, "A's bill")).json();
    const planned = await app.inject({
      method: "POST",
      url: `/v1/households/${hid}/planned-expenses`,
      headers: { ...a.headers, ...key() },
      payload: {
        name: "B's trip",
        amountCents: 5000,
        dueOn: "2026-12-01",
        ownerType: "member",
        ownerUserId: b.id,
      },
    });
    expect(planned.statusCode, planned.body).toBe(201);

    const left = await app.inject({ method: "POST", url: `/v1/households/${hid}/leave`, headers: b.headers });
    expect(left.statusCode, left.body).toBe(204);

    const items = (
      await app.inject({ method: "GET", url: `/v1/households/${hid}/items?limit=100`, headers: a.headers })
    ).json().data as { id: string; ownerUserId: string }[];
    expect(items.find((i) => i.id === bItem.id)?.ownerUserId).toBe(a.id);
    expect(items.find((i) => i.id === aItem.id)?.ownerUserId).toBe(a.id);
    const pe = (
      await app.inject({ method: "GET", url: `/v1/households/${hid}/planned-expenses`, headers: a.headers })
    ).json().data as { ownerUserId: string }[];
    expect(pe.every((p) => p.ownerUserId === a.id)).toBe(true);
    expect(
      (await app.inject({ method: "GET", url: `/v1/households/${hid}/items`, headers: b.headers })).json()
        .data,
    ).toEqual([]);
  });
});

describe("M-1 round 2: schedule, skip and planned expenses of the partner's items", () => {
  const getEtag = async (headers: Record<string, string>, url: string) =>
    (await app.inject({ method: "GET", url, headers })).headers.etag as string;
  const patchItem = async (headers: Record<string, string>, id: string, payload: object) =>
    app.inject({
      method: "PATCH",
      url: `${base()}/items/${id}`,
      headers: { ...headers, "if-match": await getEtag(headers, `${base()}/items/${id}`) },
      payload,
    });
  const getItem = async (headers: Record<string, string>, id: string) =>
    (await app.inject({ method: "GET", url: `${base()}/items/${id}`, headers })).json();

  const directions = [
    ["Sam acting on Jordan's", () => sam(), () => fx("b-internet"), () => JORDAN()],
    ["Jordan acting on Sam's", () => jordan(), () => fx("b-music2"), () => SAM()],
  ] as const;

  describe.each(directions)("%s item", (_name, actor, itemId, ownerId) => {
    it("cannot change its schedule or weekend rule, but a no-op PATCH of the same values works", async () => {
      const before = await getItem(actor(), itemId());
      expect(before.ownerUserId).toBe(ownerId());
      expectProblem(
        await patchItem(actor(), itemId(), {
          schedule: { ...before.schedule, type: "monthly_day", day: 28 },
        }),
        403,
        "approval_required",
      );
      expectProblem(
        await patchItem(actor(), itemId(), { weekendRule: "next_business_day" }),
        403,
        "approval_required",
      );
      const same = await patchItem(actor(), itemId(), {
        schedule: before.schedule,
        weekendRule: before.weekendRule,
        notes: "unchanged schedule",
      });
      expect(same.statusCode, same.body).toBe(200);
      expect(same.json().schedule).toEqual(before.schedule);
    });

    it("cannot skip one of its occurrences; marking it paid still works", async () => {
      const occ = (
        await app.inject({
          method: "GET",
          url: `${base()}/occurrences?from=2026-11-01&to=2026-12-31&itemId=${itemId()}`,
          headers: actor(),
        })
      ).json().data as { id: string; version: number }[];
      const [first, second] = occ;
      const patch = (o: { id: string; version: number } | undefined, payload: object) =>
        app.inject({
          method: "PATCH",
          url: `${base()}/occurrences/${o?.id}`,
          headers: { ...actor(), "if-match": `"${o?.version}"` },
          payload,
        });
      expectProblem(await patch(first, { status: "skipped" }), 403, "approval_required");
      expect((await patch(second, { status: "paid" })).statusCode).toBe(200);
    });
  });

  it("Both and Split items can have their schedule changed and occurrences skipped by either member", async () => {
    const both = await createBill({ name: "Shared sched", ownerType: "both", ownerUserId: null });
    const res = await patchItem(jordan(), both.id, { weekendRule: "next_business_day" });
    expect(res.statusCode, res.body).toBe(200);
    const occ = (
      await app.inject({
        method: "GET",
        url: `${base()}/occurrences?from=2026-11-01&to=2026-11-30&itemId=${both.id}`,
        headers: jordan(),
      })
    ).json().data[0] as { id: string; version: number };
    const skipped = await app.inject({
      method: "PATCH",
      url: `${base()}/occurrences/${occ.id}`,
      headers: { ...jordan(), "if-match": `"${occ.version}"` },
      payload: { status: "skipped" },
    });
    expect(skipped.statusCode, skipped.body).toBe(200);
  });

  describe.each([
    ["Sam acting on Jordan's planned expense", () => sam(), () => JORDAN()],
    ["Jordan acting on Sam's planned expense", () => jordan(), () => SAM()],
  ] as const)("%s", (_name, actor, ownerId) => {
    const create = async () => {
      // Created by the owner, not the actor.
      const ownerHeaders = ownerId() === SAM() ? sam() : jordan();
      const res = await app.inject({
        method: "POST",
        url: `${base()}/planned-expenses`,
        headers: { ...ownerHeaders, ...key() },
        payload: {
          name: "Dentist",
          amountCents: 20000,
          dueOn: "2026-11-20",
          ownerType: "member",
          ownerUserId: ownerId(),
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as { id: string; version: number };
    };
    const patch = (id: string, version: number, payload: object) =>
      app.inject({
        method: "PATCH",
        url: `${base()}/planned-expenses/${id}`,
        headers: { ...actor(), "if-match": `"${version}"` },
        payload,
      });

    it("cannot delete it, change its owner, or move its date; other edits work", async () => {
      const p = await create();
      expectProblem(
        await app.inject({ method: "DELETE", url: `${base()}/planned-expenses/${p.id}`, headers: actor() }),
        403,
        "approval_required",
      );
      expectProblem(
        await patch(p.id, p.version, { ownerType: "both", ownerUserId: null }),
        403,
        "approval_required",
      );
      expectProblem(await patch(p.id, p.version, { dueOn: "2026-12-05" }), 403, "approval_required");
      const ok = await patch(p.id, p.version, { name: "Dentist (copay)", dueOn: "2026-11-20" });
      expect(ok.statusCode, ok.body).toBe(200);
    });
  });

  it("Both and Split planned expenses stay editable and deletable by either member", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${base()}/planned-expenses`,
      headers: { ...sam(), ...key() },
      payload: { name: "Shared trip", amountCents: 9000, dueOn: "2026-11-20", ownerType: "both" },
    });
    const p = res.json() as { id: string; version: number };
    const moved = await app.inject({
      method: "PATCH",
      url: `${base()}/planned-expenses/${p.id}`,
      headers: { ...jordan(), "if-match": `"${p.version}"` },
      payload: { dueOn: "2026-12-01", ownerType: "split", ownerUserId: null },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(
      (await app.inject({ method: "DELETE", url: `${base()}/planned-expenses/${p.id}`, headers: jordan() }))
        .statusCode,
    ).toBe(204);
  });
});
