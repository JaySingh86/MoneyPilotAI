// GET /households/:hid/automation-stats (Q-172): the share of active recurring items found automatically.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { key } from "../../auth/testing/app";
import { expectProblem } from "../../lib/testing";
import { createReviewTestApi, type ReviewTestApi } from "./testing";

let t: ReviewTestApi;
beforeAll(async () => {
  t = await createReviewTestApi();
}, 180_000);
afterAll(async () => {
  await t?.close();
});

type Who = { id: string; headers: Record<string, string> };

async function household(label: string): Promise<{ who: Who; hid: string }> {
  const who = await t.signUp(label);
  const res = await t.app.inject({
    method: "POST",
    url: "/v1/households",
    headers: { ...who.headers, ...key() },
    payload: { name: label },
  });
  expect(res.statusCode).toBe(201);
  return { who, hid: (res.json() as { id: string }).id };
}

async function addItem(
  who: Who,
  hid: string,
  source: "manual" | "email" | "csv" | "bank",
  status = "active",
) {
  const res = await t.app.inject({
    method: "POST",
    url: `/v1/households/${hid}/items`,
    headers: { ...who.headers, ...key() },
    payload: {
      direction: "outflow",
      kind: "bill",
      category: "other",
      name: `Item ${randomUUID().slice(0, 6)}`,
      amountType: "fixed",
      amountCents: 1000,
      schedule: { type: "monthly_day", day: 12, dtstart: "2026-11-12" },
      ownerType: "member",
      ownerUserId: who.id,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = (res.json() as { id: string }).id;
  await t.admin((c) =>
    c.query("update recurring_items set source = $2, status = $3 where id = $1", [id, source, status]),
  );
  return id;
}

const stats = (who: Who, hid: string) =>
  t.app.inject({ method: "GET", url: `/v1/households/${hid}/automation-stats`, headers: who.headers });

describe("automation stats", () => {
  it("is 0 percent with no items", async () => {
    const { who, hid } = await household("stats-empty");
    const res = await stats(who, hid);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ percent: 0, automatedCount: 0, handCount: 0 });
  });

  it("counts email and csv as automated, manual as by hand, active items only; rounds half up", async () => {
    const { who, hid } = await household("stats-mix");
    await addItem(who, hid, "email");
    await addItem(who, hid, "csv");
    await addItem(who, hid, "manual");
    await addItem(who, hid, "manual", "paused");
    await addItem(who, hid, "email", "ended");
    const res = await stats(who, hid);
    expect(res.json()).toEqual({ percent: 67, automatedCount: 2, handCount: 1 });
  });

  it("rounds exactly half up (1 of 8 is 13, not 12)", async () => {
    const { who, hid } = await household("stats-half");
    await addItem(who, hid, "email");
    for (let n = 0; n < 7; n++) await addItem(who, hid, "manual");
    expect((await stats(who, hid)).json()).toEqual({ percent: 13, automatedCount: 1, handCount: 7 });
  });

  it("does not count a bank item as automated (Q-172: only email and csv)", async () => {
    const { who, hid } = await household("stats-bank");
    await addItem(who, hid, "email");
    await addItem(who, hid, "manual");
    await addItem(who, hid, "bank");
    expect((await stats(who, hid)).json()).toEqual({ percent: 50, automatedCount: 1, handCount: 1 });
  });

  it("excludes soft-deleted items", async () => {
    const { who, hid } = await household("stats-del");
    const id = await addItem(who, hid, "manual");
    await addItem(who, hid, "email");
    await t.admin((c) => c.query("update recurring_items set deleted_at = now() where id = $1", [id]));
    expect((await stats(who, hid)).json()).toEqual({ percent: 100, automatedCount: 1, handCount: 0 });
  });

  it("another household's member cannot read it (RLS)", async () => {
    const a = await household("stats-a");
    const b = await household("stats-b");
    await addItem(a.who, a.hid, "email");
    expectProblem(await stats(b.who, a.hid), 404, "not_found");
  });
});
