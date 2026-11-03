// WP-13 against a real Postgres (RLS as mp_api) with the real auth layer: goals with the fixture's
// `goalsPage` values, deposits, the proposal gate and approval flow (replacing WP-06's interim guard), tasks
// with the `tasks` counts and the nav badge, auto-completion, and tenant isolation.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createWorkerDb, type WorkerDb } from "@mp/db";
import { planningUuid, seedFixture, seedPlanning, type SeedResult } from "@mp/db/testing";
import { createTestApi, key, type TestApi, type TestUser } from "../../auth/testing/app";
import { expectProblem } from "../../lib/testing";

const T0 = "2026-10-27T16:00:00Z";
const DAY_MS = 24 * 60 * 60 * 1000;
let clock = T0;
let t: TestApi;
let worker: WorkerDb;
let stranger: TestUser;
let rawFixture: string;

interface Rivera {
  seeded: SeedResult;
  sam: Record<string, string>;
  jordan: Record<string, string>;
  fx: (id: string) => string;
  base: string;
}

/** The golden household under its own identity, so each suite has its own data. */
async function seedRivera(suffix: string): Promise<Rivera> {
  const fixture: unknown = JSON.parse(
    rawFixture
      .replaceAll("hh-rivera", `hh-rivera-${suffix}`)
      .replaceAll("m-sam", `m-sam-${suffix}`)
      .replaceAll("m-jordan", `m-jordan-${suffix}`)
      .replaceAll("rivera-7k2", `rivera-${suffix}`)
      .replaceAll("@rivera-household.example", `@${suffix}.example`),
  );
  const seeded = await seedFixture({ api: t.db, worker }, fixture);
  await seedPlanning({ api: t.db, worker }, seeded, fixture);
  return {
    seeded,
    sam: await t.as(`fixture|m-sam-${suffix}`, { claims: { email: `sam@${suffix}.example` } }),
    jordan: await t.as(`fixture|m-jordan-${suffix}`, { claims: { email: `jordan@${suffix}.example` } }),
    fx: (id) => planningUuid(seeded.householdId, id),
    base: `/v1/households/${seeded.householdId}`,
  };
}

beforeAll(async () => {
  t = await createTestApi({ now: () => clock });
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 2 });
  rawFixture = await readFile(
    fileURLToPath(new URL("../../../../../design/fixtures/rivera-household.json", import.meta.url)),
    "utf8",
  );
  stranger = await t.signUp("stranger-wp13");
}, 180_000);
afterAll(async () => {
  await t?.close();
  await worker?.close();
});

const call = (opts: InjectOptions) => t.app.inject(opts);

interface ProposalBody {
  id: string;
  status: string;
  kind: string;
  proposedBy: string;
  decidedBy: string | null;
  decisionNote: string | null;
  expiresAt: string;
  payload: Record<string, unknown> & { type: string };
}

function proposalOf(res: LightMyRequestResponse, type: string): ProposalBody {
  expect(res.statusCode, res.body).toBe(202);
  const body = res.json() as ProposalBody;
  expect(body.status).toBe("pending");
  expect(body.payload.type).toBe(type);
  return body;
}

class Api {
  constructor(private readonly r: Rivera) {}
  private etag = async (headers: Record<string, string>, url: string) =>
    (await call({ method: "GET", url, headers })).headers.etag as string;
  get = (headers: Record<string, string>, path: string) =>
    call({ method: "GET", url: `${this.r.base}${path}`, headers });
  post = (headers: Record<string, string>, path: string, payload?: object) =>
    call({ method: "POST", url: `${this.r.base}${path}`, headers: { ...headers, ...key() }, payload });
  /** PATCH with If-Match from a GET of the resource, or an explicit `version` where no GET exists. */
  patch = async (headers: Record<string, string>, path: string, payload: object, version?: number) =>
    call({
      method: "PATCH",
      url: `${this.r.base}${path}`,
      headers: {
        ...headers,
        "if-match":
          version === undefined ? await this.etag(headers, `${this.r.base}${path}`) : `"${version}"`,
      },
      payload,
    });
  del = (headers: Record<string, string>, path: string) =>
    call({ method: "DELETE", url: `${this.r.base}${path}`, headers });
  approve = (headers: Record<string, string>, id: string) => this.post(headers, `/proposals/${id}/approve`);
  reject = (headers: Record<string, string>, id: string, note?: string) =>
    this.post(headers, `/proposals/${id}/reject`, note ? { note } : undefined);
  /** Rejects every open proposal (by the member who did not make it): one pending per target (M4). */
  settle = async () => {
    const open = (await this.get(this.r.sam, "/proposals?status=pending")).json().data as {
      id: string;
      proposedBy: string;
    }[];
    for (const p of open) {
      await this.reject(p.proposedBy === this.r.seeded.userIds.creator ? this.r.jordan : this.r.sam, p.id);
    }
  };
}

// ===== Goals: the fixture's goalsPage =====
describe("goals (golden values)", () => {
  let r: Rivera;
  let a: Api;
  beforeAll(async () => {
    r = await seedRivera("wp13g");
    a = new Api(r);
  });

  it("returns the Goals screen KPIs and goal cards from the engine: $550 · $7,970 · $0", async () => {
    const res = await a.get(r.sam, "/goals");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      savingEachMonthCents: 55000,
      savedSoFarCents: 797000,
      effectOnSafeToSpendCents: 0,
      nextTransferOn: "2026-11-06",
    });
    const [emergency, tahoe, gifts] = body.data;
    expect(body.data).toHaveLength(3);
    expect(emergency).toMatchObject({
      id: r.fx("g-emergency"),
      isEmergencyFund: true,
      progress: { percent: 64, status: "reach_month", reachMonth: "2027-10" },
    });
    expect(tahoe).toMatchObject({
      id: r.fx("g-tahoe"),
      progress: { percent: 48, status: "behind", gapCents: 25000, suggestedMonthlyCents: 31300 },
    });
    expect(gifts).toMatchObject({
      id: r.fx("g-gifts"),
      type: "planned_expense",
      progress: { percent: 53, status: "to_set_aside", gapCents: 38000, suggestedMonthlyCents: 19000 },
    });
    expect(JSON.stringify(body)).not.toMatch(/\d\.\d/); // integer cents only
  });

  it("gives the three ways to close a gap (rule 10) for a goal that is behind, and none otherwise", async () => {
    const tahoe = (await a.get(r.sam, `/goals/${r.fx("g-tahoe")}/options`)).json();
    expect(tahoe.status).toBe("behind");
    expect(tahoe.options.map((o: { kind: string }) => o.kind)).toEqual([
      "raise_monthly",
      "move_date",
      "lower_target",
    ]);
    expect(tahoe.options[0]).toEqual({ kind: "raise_monthly", monthlyCents: 31300 });
    const emergency = (await a.get(r.sam, `/goals/${r.fx("g-emergency")}/options`)).json();
    expect(emergency.options).toEqual([]);
  });

  it("serves one goal with an ETag, and 404s for another household's goal or a stranger", async () => {
    const one = await a.get(r.sam, `/goals/${r.fx("g-tahoe")}`);
    expect(one.statusCode).toBe(200);
    expect(one.headers.etag).toBe(`"${one.json().version}"`);
    expectProblem(await a.get(r.sam, `/goals/${r.fx("g-emergency").replace(/.$/, "0")}`), 404, "not_found");
    expectProblem(
      await call({ method: "GET", url: `${r.base}/goals`, headers: stranger.headers }),
      404,
      "not_found",
    );
    expectProblem(await call({ method: "GET", url: `${r.base}/goals` }), 401, "unauthorized");
  });

  it("records deposits as events: saved and percent follow, and a withdrawal can't go below $0", async () => {
    const res = await a.post(r.sam, `/goals/${r.fx("g-gifts")}/events`, {
      kind: "deposit",
      amountCents: 38000,
      note: "Christmas fund",
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.event).toMatchObject({ kind: "deposit", amountCents: 38000, occurredOn: "2026-10-27" });
    expect(body.goal).toMatchObject({
      savedCents: 80000,
      status: "reached",
      progress: { percent: 100, status: "reached" },
    });
    const bad = await a.post(r.sam, `/goals/${r.fx("g-gifts")}/events`, {
      kind: "withdrawal",
      amountCents: 90000,
    });
    expectProblem(bad, 400, "validation_failed");
    expectProblem(
      await a.post(r.sam, `/goals/${r.fx("g-gifts")}/events`, { kind: "deposit", amountCents: -5 }),
      400,
      "validation_failed",
    );
    const list = (await a.get(r.sam, "/goals")).json();
    expect(list.savedSoFarCents).toBe(797000 + 38000);
  });

  it("creates, edits and removes a goal; renames and target changes apply at once", async () => {
    const created = await a.post(r.sam, "/goals", {
      name: "New bike",
      type: "savings",
      targetCents: 120000,
      savedCents: 20000,
      targetDate: "2027-06-01",
    });
    expect(created.statusCode, created.body).toBe(201);
    const goal = created.json();
    expect(goal).toMatchObject({ monthlyCents: 0, colorSlot: 1, status: "active", isEmergencyFund: false });
    const renamed = await a.patch(r.jordan, `/goals/${goal.id}`, { name: "E-bike", targetCents: 130000 });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "E-bike", targetCents: 130000, version: goal.version + 1 });
    const second = await a.post(r.sam, "/goals", {
      name: "Second fund",
      type: "savings",
      targetCents: 100,
      isEmergencyFund: true,
    });
    expectProblem(second, 409, "conflict"); // one emergency fund per household
    // monthly 0, so no approval is needed to delete it
    expect((await a.del(r.jordan, `/goals/${goal.id}`)).statusCode).toBe(204);
    expectProblem(await a.get(r.sam, `/goals/${goal.id}`), 404, "not_found");
  });

  it("answers a stale If-Match with 409 and requires the header", async () => {
    const url = `${r.base}/goals/${r.fx("g-tahoe")}`;
    const stale = await call({
      method: "PATCH",
      url,
      headers: { ...r.sam, "if-match": '"99"' },
      payload: { name: "Tahoe" },
    });
    expectProblem(stale, 409, "conflict");
    expectProblem(
      await call({ method: "PATCH", url, headers: r.sam, payload: { name: "Tahoe" } }),
      428,
      "precondition_required",
    );
  });
});

// ===== Proposals =====
describe("proposals (goals)", () => {
  let r: Rivera;
  let a: Api;
  beforeEach(() => a.settle());
  beforeAll(async () => {
    clock = T0;
    r = await seedRivera("wp13p");
    a = new Api(r);
  });
  const tahoe = () => r.fx("g-tahoe");
  const monthly = async () => (await a.get(r.sam, `/goals/${tahoe()}`)).json().monthlyCents as number;

  it("a new monthly amount is a proposal (202), not a change; the engine supplies the effect", async () => {
    const res = await a.patch(r.sam, `/goals/${tahoe()}`, { monthlyCents: 31300 });
    const p = proposalOf(res, "goal_monthly");
    expect(p).toMatchObject({ kind: "goal_change", proposedBy: r.seeded.userIds.creator, decidedBy: null });
    expect(p.payload).toMatchObject({
      goalId: tahoe(),
      fromMonthlyCents: 25000,
      toMonthlyCents: 31300,
      effect: { safeToSpendBeforeCents: 100701, safeToSpendAfterCents: 100701 },
    });
    expect(Date.parse(p.expiresAt) - Date.parse(T0)).toBe(7 * DAY_MS);
    expect(await monthly()).toBe(25000);
    // The same proposal is also reachable through the proposals API.
    const list = (await a.get(r.jordan, "/proposals?status=pending")).json();
    expect(list.data.map((x: ProposalBody) => x.id)).toContain(p.id);
  });

  it("the proposer can't approve or reject their own proposal; the partner can approve", async () => {
    const p = proposalOf(await a.patch(r.sam, `/goals/${tahoe()}`, { monthlyCents: 31300 }), "goal_monthly");
    expectProblem(await a.approve(r.sam, p.id), 403, "forbidden");
    expectProblem(await a.reject(r.sam, p.id), 403, "forbidden");
    expect(await monthly()).toBe(25000);
    const approved = await a.approve(r.jordan, p.id);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({
      status: "applied",
      decidedBy: r.seeded.userIds.partner,
      proposedBy: r.seeded.userIds.creator,
    });
    expect(await monthly()).toBe(31300);
    const list = (await a.get(r.sam, "/goals")).json();
    expect(list.savingEachMonthCents).toBe(55000 - 25000 + 31300);
    // Tahoe is now on track: 115000 + 4 × 31300 ≥ 240000.
    expect(list.data[1].progress.status).toBe("on_track");
    // A decided proposal is final.
    expectProblem(await a.approve(r.jordan, p.id), 409, "conflict");
    expectProblem(await a.reject(r.jordan, p.id), 409, "conflict");
  });

  it("a rejected proposal changes nothing", async () => {
    const p = proposalOf(
      await a.patch(r.jordan, `/goals/${tahoe()}`, { monthlyCents: 10000 }),
      "goal_monthly",
    );
    const rejected = await a.reject(r.sam, p.id, "Too low");
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({
      status: "rejected",
      decidedBy: r.seeded.userIds.creator,
      decisionNote: "Too low",
    });
    expect(await monthly()).toBe(31300);
  });

  it("a stale proposal becomes superseded when the data it was based on changed", async () => {
    const first = proposalOf(
      await a.patch(r.sam, `/goals/${tahoe()}`, { monthlyCents: 40000 }),
      "goal_monthly",
    );
    // A second request for the same goal while one is open is refused (M4).
    expectProblem(await a.patch(r.sam, `/goals/${tahoe()}`, { monthlyCents: 35000 }), 409, "conflict");
    // The amount changes behind the proposal's back (as an earlier approval would do).
    await t.admin((c) => c.query("update goals set monthly_cents = 35000 where id = $1", [tahoe()]));
    const stale = await a.approve(r.jordan, first.id);
    expectProblem(stale, 409, "conflict");
    const after = (await a.get(r.jordan, `/proposals/${first.id}`)).json() as ProposalBody;
    expect(after.status).toBe("superseded");
    expect(after.decidedBy).toBeNull();
    expect(after.decisionNote).toBeTruthy();
    expect(await monthly()).toBe(35000);
  });

  it("a proposal expires after 7 days: approving it fails and it reads as expired", async () => {
    const p = proposalOf(await a.patch(r.sam, `/goals/${tahoe()}`, { monthlyCents: 20000 }), "goal_monthly");
    clock = new Date(Date.parse(T0) + 6 * DAY_MS).toISOString();
    expect(((await a.get(r.jordan, `/proposals/${p.id}`)).json() as ProposalBody).status).toBe("pending");
    clock = new Date(Date.parse(T0) + 8 * DAY_MS).toISOString();
    expect(((await a.get(r.jordan, `/proposals/${p.id}`)).json() as ProposalBody).status).toBe("expired");
    expect(
      ((await a.get(r.jordan, "/proposals?status=pending")).json().data as ProposalBody[]).map((x) => x.id),
    ).not.toContain(p.id);
    expectProblem(await a.approve(r.jordan, p.id), 409, "conflict");
    expect(await monthly()).toBe(35000);
    expect(((await a.get(r.jordan, `/proposals/${p.id}`)).json() as ProposalBody).status).toBe("expired");
    clock = T0;
  });

  it("an explicit proposal needs a real change, a goal of this household and a partner", async () => {
    const make = (payload: object) => a.post(r.sam, "/proposals", payload);
    const ok = await make({ type: "goal_monthly", goalId: tahoe(), monthlyCents: 36000 });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.headers.location).toContain("/proposals/");
    expectProblem(
      await make({ type: "goal_monthly", goalId: tahoe(), monthlyCents: 35000 }),
      400,
      "validation_failed",
    );
    expectProblem(
      await make({ type: "goal_monthly", goalId: r.fx("g-emergency").replace(/.$/, "0"), monthlyCents: 1 }),
      404,
      "not_found",
    );
    expectProblem(
      await make({ type: "goal_monthly", goalId: tahoe(), monthlyCents: -5 }),
      400,
      "validation_failed",
    );
    // The on-track plan has no shortfall, so there are no options to propose.
    expectProblem(await make({ type: "shortfall_option", option: "split_expense" }), 409, "conflict");
  });

  it("a monthly amount sent with other fields is refused, and deleting a goal with a deposit is a proposal", async () => {
    expectProblem(
      await a.patch(r.sam, `/goals/${tahoe()}`, { monthlyCents: 1000, name: "Trip" }),
      400,
      "validation_failed",
    );
    const del = proposalOf(await a.del(r.sam, `/goals/${r.fx("g-emergency")}`), "goal_delete");
    expect((await a.get(r.sam, `/goals/${r.fx("g-emergency")}`)).statusCode).toBe(200);
    expect((await a.approve(r.jordan, del.id)).statusCode).toBe(200);
    expectProblem(await a.get(r.sam, `/goals/${r.fx("g-emergency")}`), 404, "not_found");
    // A goal without a monthly amount (Holiday gifts) is deleted at once.
    expect((await a.del(r.sam, `/goals/${r.fx("g-gifts")}`)).statusCode).toBe(204);
  });

  it("only household members see proposals, and a stranger can't decide", async () => {
    const p = proposalOf(await a.patch(r.sam, `/goals/${tahoe()}`, { monthlyCents: 22000 }), "goal_monthly");
    expectProblem(
      await call({ method: "GET", url: `${r.base}/proposals/${p.id}`, headers: stranger.headers }),
      404,
      "not_found",
    );
    expectProblem(
      await call({ method: "POST", url: `${r.base}/proposals/${p.id}/approve`, headers: stranger.headers }),
      404,
      "not_found",
    );
  });
});

// ===== Items: the interim approval_required guard becomes proposals =====
describe("proposals (items replace WP-06's approval_required guard)", () => {
  let r: Rivera;
  let a: Api;
  beforeEach(() => a.settle());
  beforeAll(async () => {
    clock = T0;
    r = await seedRivera("wp13i");
    a = new Api(r);
  });
  const jordansBill = () => r.fx("b-internet");
  const occurrence = async (itemId: string, month = "2026-11") =>
    (await a.get(r.sam, `/occurrences?from=${month}-01&to=${month}-30&itemId=${itemId}`)).json().data[0] as {
      id: string;
      version: number;
      dueOn: string;
      status: string;
      movedBy: string | null;
    };
  const occurrenceFor = (id: string, from: string, to: string, itemId: string) =>
    a
      .get(r.sam, `/occurrences?from=${from}&to=${to}&itemId=${itemId}`)
      .then((x) => x.json().data.find((o: { id: string }) => o.id === id));

  it("deleting the partner's item: 202, nothing deleted until they approve, then it is gone with its future occurrences", async () => {
    const p = proposalOf(await a.del(r.sam, `/items/${jordansBill()}`), "item_delete");
    expect(p.payload).toMatchObject({ itemId: jordansBill(), ownerUserId: r.seeded.userIds.partner });
    expect((await a.get(r.sam, `/items/${jordansBill()}`)).statusCode).toBe(200);
    expectProblem(await a.approve(r.sam, p.id), 403, "forbidden");
    expect((await a.approve(r.jordan, p.id)).statusCode).toBe(200);
    expectProblem(await a.get(r.sam, `/items/${jordansBill()}`), 404, "not_found");
    expect(
      (await a.get(r.sam, `/occurrences?from=2026-11-01&to=2027-06-30&itemId=${jordansBill()}`)).json().data,
    ).toEqual([]);
  });

  it("changing the owner or status or schedule applies on approval, credited to the proposer", async () => {
    const item = r.fx("b-music2"); // Sam's
    const status = proposalOf(await a.patch(r.jordan, `/items/${item}`, { status: "paused" }), "item_patch");
    expect((await a.get(r.sam, `/items/${item}`)).json().status).toBe("active");
    expect((await a.approve(r.sam, status.id)).statusCode).toBe(200);
    expect((await a.get(r.sam, `/items/${item}`)).json().status).toBe("paused");

    const owner = proposalOf(
      await a.patch(r.jordan, `/items/${item}`, { ownerType: "both", ownerUserId: null, status: "active" }),
      "item_patch",
    );
    expect((await a.approve(r.sam, owner.id)).statusCode).toBe(200);
    expect((await a.get(r.sam, `/items/${item}`)).json()).toMatchObject({
      ownerType: "both",
      ownerUserId: null,
      status: "active",
    });
    // Now a Both item: either member edits it directly (no proposal).
    expect((await a.patch(r.jordan, `/items/${item}`, { status: "paused" })).statusCode).toBe(200);
  });

  it("a proposal for an item that changed meanwhile is superseded", async () => {
    const item = r.fx("b-phone"); // Jordan's or Sam's? use whoever owns it
    const owner = (await a.get(r.sam, `/items/${item}`)).json().ownerUserId as string;
    const other = owner === r.seeded.userIds.creator ? r.jordan : r.sam;
    const mine = owner === r.seeded.userIds.creator ? r.sam : r.jordan;
    const p = proposalOf(await a.patch(other, `/items/${item}`, { status: "paused" }), "item_patch");
    // The owner pauses it themselves first (their own item, no approval needed): the premise changed.
    expect((await a.patch(mine, `/items/${item}`, { status: "paused" })).statusCode).toBe(200);
    expectProblem(await a.approve(mine, p.id), 409, "conflict");
    expect(((await a.get(mine, `/proposals/${p.id}`)).json() as ProposalBody).status).toBe("superseded");
  });

  it("moving the partner's due date applies on approval and records the proposer as the mover", async () => {
    const item = r.fx("b-rent"); // Jordan's
    const o = await occurrence(item);
    const res = await call({
      method: "PATCH",
      url: `${r.base}/occurrences/${o.id}`,
      headers: { ...r.sam, "if-match": `"${o.version}"` },
      payload: { dueOn: "2026-11-05" },
    });
    const p = proposalOf(res, "occurrence_move");
    expect(p.payload).toMatchObject({ fromDueOn: o.dueOn, toDueOn: "2026-11-05" });
    expect((await occurrenceFor(o.id, "2026-11-01", "2026-11-30", item)).dueOn).toBe(o.dueOn);
    expect((await a.approve(r.jordan, p.id)).statusCode).toBe(200);
    expect(await occurrenceFor(o.id, "2026-11-01", "2026-11-30", item)).toMatchObject({
      dueOn: "2026-11-05",
      movedBy: r.seeded.userIds.creator,
    });
  });

  it("a move sent with other fields is refused; paying the partner's bill still works", async () => {
    const o = await occurrence(r.fx("b-rent"));
    const mixed = await call({
      method: "PATCH",
      url: `${r.base}/occurrences/${o.id}`,
      headers: { ...r.sam, "if-match": `"${o.version}"` },
      payload: { dueOn: "2026-11-06", actualAmountCents: 100 },
    });
    expectProblem(mixed, 400, "validation_failed");
    const paid = await call({
      method: "PATCH",
      url: `${r.base}/occurrences/${o.id}`,
      headers: { ...r.sam, "if-match": `"${o.version}"` },
      payload: { status: "paid" },
    });
    expect(paid.statusCode, paid.body).toBe(200);
  });

  it("skipping the partner's occurrence is a proposal; approving skips it", async () => {
    const o = await occurrence(r.fx("b-car")); // Sam's, Jordan skips
    const res = await call({
      method: "PATCH",
      url: `${r.base}/occurrences/${o.id}`,
      headers: { ...r.jordan, "if-match": `"${o.version}"` },
      payload: { status: "skipped" },
    });
    const p = proposalOf(res, "occurrence_skip");
    expect((await a.approve(r.sam, p.id)).statusCode).toBe(200);
    expect((await occurrenceFor(o.id, "2026-11-01", "2026-11-30", r.fx("b-car"))).status).toBe("skipped");
  });

  it("the partner's planned expense: delete, owner change and date move are proposals; other edits apply", async () => {
    const create = async () =>
      (
        await call({
          method: "POST",
          url: `${r.base}/planned-expenses`,
          headers: { ...r.jordan, ...key() },
          payload: {
            name: "Dentist",
            amountCents: 20000,
            dueOn: "2026-11-20",
            ownerType: "member",
            ownerUserId: r.seeded.userIds.partner,
          },
        })
      ).json() as { id: string; version: number };
    const p1 = await create();
    const move = proposalOf(
      await a.patch(r.sam, `/planned-expenses/${p1.id}`, { dueOn: "2026-12-05" }, p1.version),
      "planned_patch",
    );
    expect((await a.approve(r.jordan, move.id)).statusCode).toBe(200);
    expect(
      (await a.get(r.sam, "/planned-expenses")).json().data.find((x: { id: string }) => x.id === p1.id).dueOn,
    ).toBe("2026-12-05");
    const current = (await a.get(r.sam, "/planned-expenses"))
      .json()
      .data.find((x: { id: string }) => x.id === p1.id);
    expect(
      (await a.patch(r.sam, `/planned-expenses/${p1.id}`, { name: "Dentist (copay)" }, current.version))
        .statusCode,
    ).toBe(200);
    const del = proposalOf(await a.del(r.sam, `/planned-expenses/${p1.id}`), "planned_delete");
    expect((await a.approve(r.jordan, del.id)).statusCode).toBe(200);
    expect(
      (await a.get(r.sam, "/planned-expenses")).json().data.some((x: { id: string }) => x.id === p1.id),
    ).toBe(false);
  });

  it("a member's own items and Both items stay directly editable", async () => {
    const own = await call({
      method: "POST",
      url: `${r.base}/items`,
      headers: { ...r.sam, ...key() },
      payload: {
        direction: "outflow",
        kind: "bill",
        category: "other",
        name: "Gym",
        amountType: "fixed",
        amountCents: 4500,
        schedule: { type: "monthly_day", day: 12, dtstart: "2026-10-01" },
        ownerType: "member",
        ownerUserId: r.seeded.userIds.creator,
      },
    });
    const id = own.json().id as string;
    expect((await a.patch(r.sam, `/items/${id}`, { status: "paused" })).statusCode).toBe(200);
    expect((await a.del(r.sam, `/items/${id}`)).statusCode).toBe(204);
  });

  it("the summary counts the proposals waiting for you, not the ones you made", async () => {
    const summary = async (headers: Record<string, string>) =>
      (await call({ method: "GET", url: `/v1/households/${r.seeded.householdId}/summary`, headers })).json()
        .badges.proposalsPending as number;
    const jordanBefore = await summary(r.jordan);
    const samBefore = await summary(r.sam);
    await a.post(r.sam, "/proposals", { type: "goal_monthly", goalId: r.fx("g-tahoe"), monthlyCents: 26000 });
    expect(await summary(r.jordan)).toBe(jordanBefore + 1);
    expect(await summary(r.sam)).toBe(samBefore);
  });
});

// ===== Shortfall options as proposals =====
describe("proposals (shortfall options, engine effects from the fixture scenario)", () => {
  let r: Rivera;
  let a: Api;
  beforeEach(() => a.settle());
  beforeAll(async () => {
    clock = T0;
    r = await seedRivera("wp13s");
    a = new Api(r);
    // The fixture's shortfall scenario: a $1,800 car repair tomorrow.
    const repair = await a.post(r.sam, "/planned-expenses", {
      name: "Car repair",
      amountCents: 180000,
      dueOn: "2026-10-28",
      ownerType: "both",
    });
    expect(repair.statusCode, repair.body).toBe(201);
  });

  it("move from the emergency fund: $1,300 → $507 safe to spend; on approval a withdrawal is recorded", async () => {
    const res = await a.post(r.sam, "/proposals", {
      type: "shortfall_option",
      option: "move_from_emergency_fund",
    });
    expect(res.statusCode, res.body).toBe(201);
    const p = res.json() as ProposalBody;
    expect(p).toMatchObject({ kind: "shortfall_option", status: "pending" });
    expect(p.payload).toMatchObject({
      type: "shortfall_move_from_fund",
      goalId: r.fx("g-emergency"),
      amountCents: 130000,
      effect: { safeToSpendBeforeCents: -79299, safeToSpendAfterCents: 50701 },
    });
    expectProblem(await a.approve(r.sam, p.id), 403, "forbidden");
    expect((await a.approve(r.jordan, p.id)).statusCode).toBe(200);
    const fund = (await a.get(r.sam, `/goals/${r.fx("g-emergency")}`)).json();
    expect(fund.savedCents).toBe(640000 - 130000);
  });

  it("move the car insurance to payday: the bill moves on approval; the effect comes from the engine", async () => {
    // After the withdrawal the plan still has the shortfall (the balance is entered by the household).
    const res = await a.post(r.sam, "/proposals", {
      type: "shortfall_option",
      option: "move_bill_to_payday",
    });
    expect(res.statusCode, res.body).toBe(201);
    const p = res.json() as ProposalBody;
    expect(p.payload).toMatchObject({
      type: "shortfall_move_bill",
      itemId: r.fx("b-carins"),
      fromDate: "2026-11-04",
      toDate: "2026-11-06",
      amountCents: 68400,
    });
    expect((p.payload.effect as { safeToSpendAfterCents: number }).safeToSpendAfterCents).toBe(-10899);
    expect((await a.approve(r.jordan, p.id)).statusCode).toBe(200);
    const occ = (
      await a.get(r.sam, `/occurrences?from=2026-11-01&to=2026-11-30&itemId=${r.fx("b-carins")}`)
    ).json().data[0];
    expect(occ).toMatchObject({ dueOn: "2026-11-06", movedBy: r.seeded.userIds.creator });
  });

  it("split the repair: half now, half after payday; a changed plan supersedes the proposal", async () => {
    const res = await a.post(r.sam, "/proposals", { type: "shortfall_option", option: "split_expense" });
    expect(res.statusCode, res.body).toBe(201);
    const p = res.json() as ProposalBody;
    expect(p.payload).toMatchObject({
      type: "shortfall_split_expense",
      amountNowCents: 90000,
      laterOn: "2026-11-07",
      nowOn: "2026-10-28",
    });
    // The household deletes the repair before the partner answers: the option is gone.
    const repair = (await a.get(r.sam, "/planned-expenses"))
      .json()
      .data.find((x: { name: string }) => x.name === "Car repair");
    expect((await a.del(r.sam, `/planned-expenses/${repair.id}`)).statusCode).toBe(204);
    expectProblem(await a.approve(r.jordan, p.id), 409, "conflict");
    expect(((await a.get(r.jordan, `/proposals/${p.id}`)).json() as ProposalBody).status).toBe("superseded");
  });
});

// ===== Tasks =====
describe("tasks (golden values)", () => {
  let r: Rivera;
  let a: Api;
  beforeEach(() => a.settle());
  beforeAll(async () => {
    clock = T0;
    r = await seedRivera("wp13t");
    a = new Api(r);
  });

  it("returns 3 due this week, 4 later, 3 done and a nav badge of 3, in the engine's order", async () => {
    const res = await a.get(r.sam, "/tasks");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.dueThisWeek.map((x: { title: string }) => x.title)).toEqual([
      "Review 2 flagged subscriptions",
      "Enter the actual electricity amount",
      "Compare car insurance renewal quote",
    ]);
    expect(body.later.map((x: { title: string }) => x.title)).toEqual([
      "Choose a 2027 health plan",
      "Decide whether to keep antivirus",
      "Shop around for renters insurance",
      "Renew car registration",
    ]);
    expect(body.done).toHaveLength(3);
    expect(body.navBadge).toBe(3);
    expect(body.dueThisWeek[2]).toMatchObject({
      linkedItemName: expect.stringMatching(/car insurance/i),
      createdBy: r.seeded.userIds.creator,
    });
    expect(body.dueThisWeek[1]).toMatchObject({
      dueHint: "When the bill arrives, about Nov 1",
      source: "engine",
      linkedItemId: r.fx("b-power"),
      autoCompleteRule: { type: "actual_amount_received", itemId: r.fx("b-power") },
    });
    expect(
      body.done.every(
        (x: { completed: boolean; completedAt: string | null }) => x.completed && x.completedAt,
      ),
    ).toBe(true);
  });

  it("filters by owner with Both and Split included (rule 13), but the badge stays for everyone", async () => {
    const sam = (await a.get(r.sam, `/tasks?owner=${r.seeded.userIds.creator}`)).json();
    expect(sam.dueThisWeek.map((x: { title: string }) => x.title)).toEqual([
      "Review 2 flagged subscriptions",
      "Enter the actual electricity amount",
    ]);
    expect(sam.navBadge).toBe(3);
    const both = (await a.get(r.sam, "/tasks?owner=both")).json();
    expect(both.dueThisWeek).toHaveLength(1);
  });

  it("the household summary carries the nav badge of 3", async () => {
    const res = await call({
      method: "GET",
      url: `/v1/households/${r.seeded.householdId}/summary`,
      headers: r.jordan,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().badges).toMatchObject({ tasksDue: 3, proposalsPending: 0 });
  });

  it("creates a task (source user), completes and reopens it with If-Match, and the badge follows", async () => {
    const created = await a.post(r.sam, "/tasks", {
      title: "Call the plumber",
      ownerType: "member",
      ownerUserId: r.seeded.userIds.partner,
      dueOn: "2026-10-30",
    });
    expect(created.statusCode, created.body).toBe(201);
    const task = created.json();
    expect(task).toMatchObject({ source: "user", completed: false, ownerUserId: r.seeded.userIds.partner });
    expect(created.headers.etag).toBe(`"${task.version}"`);
    expect((await a.get(r.sam, "/tasks")).json().navBadge).toBe(4);

    const done = await a.patch(r.jordan, `/tasks/${task.id}`, { completed: true });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({
      completed: true,
      completedBy: r.seeded.userIds.partner,
      completedReason: "manual",
    });
    expect((await a.get(r.sam, "/tasks")).json().navBadge).toBe(3);

    const reopened = await a.patch(r.jordan, `/tasks/${task.id}`, { completed: false, dueOn: "2026-11-30" });
    expect(reopened.json()).toMatchObject({
      completed: false,
      completedBy: null,
      completedReason: null,
      dueOn: "2026-11-30",
    });
    expect((await a.get(r.sam, "/tasks")).json().navBadge).toBe(3);
    expectProblem(
      await call({
        method: "PATCH",
        url: `${r.base}/tasks/${task.id}`,
        headers: { ...r.sam, "if-match": '"1"' },
        payload: { title: "x" },
      }),
      409,
      "conflict",
    );
  });

  it("rejects bad input: a member owner without an id, a foreign owner, an empty title", async () => {
    const bad = (payload: object) => a.post(r.sam, "/tasks", payload);
    expectProblem(await bad({ title: "x", ownerType: "member" }), 400, "validation_failed");
    expectProblem(
      await bad({ title: "x", ownerType: "member", ownerUserId: stranger.id }),
      400,
      "validation_failed",
    );
    expectProblem(await bad({ title: "", ownerType: "both" }), 400, "validation_failed");
  });

  it("auto-completes the electricity task when the actual amount is entered, and says why", async () => {
    const o = (
      await a.get(r.sam, `/occurrences?from=2026-11-01&to=2026-11-30&itemId=${r.fx("b-power")}`)
    ).json().data[0];
    const res = await call({
      method: "PATCH",
      url: `${r.base}/occurrences/${o.id}`,
      headers: { ...r.sam, "if-match": `"${o.version}"` },
      payload: { actualAmountCents: 14200 },
    });
    expect(res.statusCode, res.body).toBe(200);
    const tasks = (await a.get(r.sam, "/tasks")).json();
    const power = tasks.done.find((x: { id: string }) => x.id === r.fx("t2"));
    expect(power).toMatchObject({
      completed: true,
      completedBy: null,
      completedReason: "actual_amount_received",
    });
    expect(tasks.navBadge).toBe(2);
  });

  it("a task can complete itself when a proposal is decided", async () => {
    const goal = (await a.get(r.sam, "/goals")).json().data[1] as { id: string; version: number };
    const p = proposalOf(await a.patch(r.sam, `/goals/${goal.id}`, { monthlyCents: 27000 }), "goal_monthly");
    await worker.withJobTx(r.seeded.householdId, async (tx) => {
      const { sql } = await import("drizzle-orm");
      await tx.execute(sql`insert into tasks (household_id, title, owner_type, source, auto_complete_rule)
        values (${r.seeded.householdId}, 'Answer the goal request', 'both', 'engine',
          ${JSON.stringify({ type: "proposal_decided", proposalId: p.id })}::jsonb)`);
    });
    expect((await a.reject(r.jordan, p.id)).statusCode).toBe(200);
    const done = (await a.get(r.sam, "/tasks")).json().done as { title: string; completedReason: string }[];
    expect(done.find((x) => x.title === "Answer the goal request")?.completedReason).toBe("proposal_decided");
  });

  it("a stranger sees no tasks and can't add one", async () => {
    expectProblem(
      await call({ method: "GET", url: `${r.base}/tasks`, headers: stranger.headers }),
      404,
      "not_found",
    );
    expectProblem(
      await call({
        method: "POST",
        url: `${r.base}/tasks`,
        headers: { ...stranger.headers, ...key() },
        payload: { title: "x", ownerType: "both" },
      }),
      403,
      "forbidden",
    );
  });
});
