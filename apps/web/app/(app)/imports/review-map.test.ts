import { describe, expect, it } from "vitest";
import type { AppliedChange, ReviewDecision } from "../../../lib/api/imports-types";
import { noFields, reviewQueueCount, resetWp23, wp23 } from "../../../mocks/wp23-data";
import { appliedRow, decisionMessage, effectText, reviewFields, reviewTag, reviewTitle } from "./review-map";

resetWp23();
const [renters, power, health, antivirus] = wp23.queue;
if (!renters || !power || !health || !antivirus) throw new Error("the mock inbox must have four items");

const labelled = (item: typeof renters) =>
  reviewFields(item.fields).map((f) => [
    f.label,
    "text" in f.value ? f.value.text : "cents" in f.value ? f.value.cents : f.value.date.toString(),
  ]);

describe("review item titles and tags", () => {
  it("names the four canvas items", () => {
    // An update is named after the item it matches plus the document type; the name is looked up by
    // `matchItemId` (Q-171), so the canvas reads "Electricity bill", not the sender's name.
    expect(reviewTitle(renters, "Renters insurance")).toBe("Renters insurance renewal");
    expect(reviewTitle(power, "Electricity")).toBe("Electricity bill");
    // A new match uses the provider name; an update whose item is not loaded yet falls back to it too.
    expect(reviewTitle(antivirus)).toBe("Antivirus auto-renewal");
    expect(reviewTitle(power)).toBe("City Power & Light bill");
    expect(reviewTitle(health)).toBe("Health plan open enrollment");
  });

  it("tags updates, decisions and new renewals", () => {
    expect(reviewTag(renters)).toEqual({ variant: "info", label: "Updates existing" });
    expect(reviewTag(health)).toEqual({ variant: "attention", label: "Needs a decision" });
    expect(reviewTag(antivirus)).toEqual({ variant: "ok", label: "New renewal" });
  });
});

describe("extracted fields", () => {
  it("shows only what the email said, with masked account numbers", () => {
    expect(labelled(power)).toEqual([
      ["Amount due", 15137],
      ["Due", "2026-11-03"],
      ["Account", "•••0937"],
    ]);
    expect(labelled(renters)).toEqual([
      ["Premium", "$168.00 / year"],
      ["Renews", "2027-01-09"],
      ["Last year", 14900],
      ["Account", "•••4821"],
    ]);
    expect(labelled(antivirus)).toContainEqual(["Price", "$49.99 / year"]);
    expect(labelled(health)).toContainEqual(["Current premium", "$248.00 / month"]);
    expect(labelled({ ...power, fields: noFields() })).toEqual([]);
  });
});

describe("effect and confirmation text", () => {
  it("shows the API's effect text only: planDelta is a change, null for now, and never added up (Q-171)", () => {
    expect(power.effect.planDelta).toBeNull();
    expect(effectText(power)).toBe("Replaces the estimate with the actual amount.");
    // Even a non-null delta never becomes a "goes from … to …" sentence: the web does not compute it.
    const withDelta = { ...power, effect: { ...power.effect, planDelta: { safeToSpendCents: -937 } } };
    expect(effectText(withDelta)).toBe(power.effect.summary);
  });

  const change = (after: Record<string, unknown>): AppliedChange => ({
    id: "c",
    origin: "email",
    entityType: "recurring_item",
    entityId: "e",
    entityName: "Electricity",
    before: { amountCents: null },
    after,
    appliedBy: "u",
    appliedAt: "2026-10-27T13:00:00Z",
    undoUntil: null,
    undoneAt: null,
    undoneBy: null,
    undoable: true,
  });

  it("says what changed after confirming the electricity item (golden)", () => {
    const decision: ReviewDecision = {
      item: power,
      appliedChange: change({ amountCents: 15137 }),
      plan: { safeToSpendCents: 99764 },
    };
    expect(decisionMessage(decision, "confirm", 100701)).toBe(
      "Electricity set to $151.37. Safe to spend is now $997.",
    );
    // Without the number the page showed before, there is nothing to compare, so no sentence.
    expect(decisionMessage(decision, "confirm")).toBe("Electricity set to $151.37.");
  });

  it("covers decisions, new renewals, updates and ignore", () => {
    expect(decisionMessage({ item: health, appliedChange: change({}), plan: null }, "confirm")).toBe(
      "Decision task added, due Nov 13.",
    );
    expect(decisionMessage({ item: antivirus, appliedChange: change({}), plan: null }, "confirm")).toBe(
      "Electricity added to renewals.",
    );
    expect(
      decisionMessage(
        { item: renters, appliedChange: change({ amountCents: 16800 }), plan: { safeToSpendCents: 100701 } },
        "confirm",
        100701,
      ),
    ).toBe("Electricity updated.");
    expect(decisionMessage({ item: renters, appliedChange: null, plan: null }, "ignore")).toBe(
      "Ignored. We won’t suggest this email again.",
    );
  });
});

describe("applied automatically rows", () => {
  const [internet, carIns, streaming] = [
    {
      entityName: "Internet",
      before: { amountCents: 7000 },
      after: { amountCents: 7000, dueDate: "2026-11-05" },
      appliedAt: "2026-10-21T13:00:00Z",
    },
    {
      entityName: "Car insurance renewal",
      before: { amountCents: 68400 },
      after: { amountCents: 68400, dueDate: "2026-11-04" },
      appliedAt: "2026-10-20T13:00:00Z",
    },
    {
      entityName: "Streaming bundle",
      before: { amountCents: 1999 },
      after: { amountCents: 2299 },
      appliedAt: "2026-09-28T13:00:00Z",
    },
  ].map(
    (c) =>
      ({
        ...c,
        id: "x",
        origin: "email",
        entityType: "r",
        entityId: "e",
        appliedBy: null,
        undoUntil: null,
        undoneAt: null,
        undoneBy: null,
        undoable: true,
      }) as AppliedChange,
  );

  it("matches the canvas rows", () => {
    expect(appliedRow(internet!, "2026-10-27", "America/New_York")).toEqual({
      title: "Internet, $70.00 due Nov 5",
      detail: "Matched something you’d already confirmed · Oct 21",
    });
    expect(appliedRow(carIns!, "2026-10-27", "America/New_York").title).toBe(
      "Car insurance renewal, $684.00 due Nov 4",
    );
    expect(appliedRow(streaming!, "2026-10-27", "America/New_York")).toEqual({
      title: "Streaming bundle, $19.99 → $22.99",
      detail: "Price change in an email · flagged for review · Sep 28",
    });
  });
});

describe("mock inbox", () => {
  it("has 4 items to review and the nav badge follows", () => {
    expect(wp23.queue).toHaveLength(4);
    expect(reviewQueueCount("base")).toBe(4);
    expect(reviewQueueCount("empty")).toBe(0);
  });
});
