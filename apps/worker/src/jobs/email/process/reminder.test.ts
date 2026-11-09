import { describe, expect, it } from "vitest";
import { planPriceChangeReminders, priceChangeDedupeKey } from "./reminder";

const item = {
  id: "item-stream",
  name: "Streaming bundle",
  ownerType: "member" as const,
  ownerUserId: "u-sam",
  scheduled: [{ id: "o1", scheduledOn: "2026-11-02", dueOn: "2026-11-02", actualAmountCents: null }],
};
const base = {
  item,
  members: ["u-sam", "u-jordan"],
  timezone: "America/New_York",
  nowIso: "2026-10-27T15:00:00Z",
  today: "2026-10-27",
};

describe("planPriceChangeReminders", () => {
  it("reminds the owner once, at 09:00 local three days before the next charge when that is still ahead", () => {
    const r = planPriceChangeReminders(base);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      userId: "u-sam",
      itemId: "item-stream",
      scheduledOn: "2026-11-02",
      dueOn: "2026-11-02",
      offsetDays: 3,
      // Oct 30, 09:00 in New York (EDT, UTC-4)
      sendAt: "2026-10-30T13:00:00Z",
      dedupeKey: priceChangeDedupeKey("item-stream", "2026-11-02", "u-sam"),
    });
    expect(r[0]?.dedupeKey.startsWith("price_change:")).toBe(true);
  });

  it("sends right away when the reminder time has passed (the price already changed)", () => {
    const r = planPriceChangeReminders({ ...base, nowIso: "2026-11-01T20:00:00Z", today: "2026-11-01" });
    expect(r[0]).toMatchObject({ sendAt: "2026-11-01T20:00:00Z", offsetDays: 1 });
  });

  it("a shared item reminds both members; an owner who left reminds nobody", () => {
    expect(
      planPriceChangeReminders({ ...base, item: { ...item, ownerType: "both", ownerUserId: null } }),
    ).toHaveLength(2);
    expect(planPriceChangeReminders({ ...base, members: ["u-jordan"] })).toEqual([]);
  });

  it("no upcoming bill means no reminder", () => {
    expect(planPriceChangeReminders({ ...base, item: { ...item, scheduled: [] } })).toEqual([]);
  });

  it("the text names the item and carries no amount (numbers come from the engine)", () => {
    const r = planPriceChangeReminders(base)[0];
    expect(r?.title).toBe("Streaming bundle: the price is changing");
    expect(`${r?.title} ${r?.body}`).not.toMatch(/\$|\d/);
  });
});
