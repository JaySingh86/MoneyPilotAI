import { describe, expect, it } from "vitest";
import { CORPUS, FORWARDED_CORPUS } from "../../testing/corpus-emails.js";
import { riveraRenewalItems } from "../../testing/items.js";
import { buildEmail } from "../../testing/mime-builder.js";
import { prepareEmailInProcess as prepareEmail } from "../mime/prepare.js";
import { kindOf, matchItem } from "./match.js";

// The extraction step (WP-22) is not built yet; these are the values it would return for each corpus email.
const EXPECTED: Record<
  string,
  { itemId: string | null; last4: string | null; kind: string | null; name: string }
> = {
  "lakeside-auto-renewal-html": {
    itemId: "r-car",
    last4: "4410",
    kind: kindOf("insurance", "auto")!,
    name: "Lakeside Auto Insurance",
  },
  "northgate-price-change-text-and-pdf": {
    itemId: "r-renters",
    last4: "4821",
    kind: kindOf("insurance", "renters")!,
    name: "Northgate Home Insurance",
  },
  "evergreen-life-statement-text": {
    itemId: "r-life",
    last4: "7731",
    kind: kindOf("insurance", "life")!,
    name: "Evergreen Life",
  },
};

describe("fixture emails link to the right items (provider domain + last 4)", () => {
  const items = riveraRenewalItems();
  it.each(Object.entries(EXPECTED))("%s", async (id, want) => {
    const c = CORPUS.find((x) => x.id === id)!;
    const prepared = await prepareEmail(buildEmail(c.email));
    if (!prepared.ok) throw new Error(prepared.reason);
    // The last 4 the extractor would quote must exist in the redacted text it sees.
    expect(prepared.text).toContain(want.last4!);
    const r = matchItem(
      {
        senderDomain: prepared.senderDomain,
        providerName: want.name,
        accountLast4: want.last4,
        kind: want.kind,
      },
      items,
    );
    expect(r.itemId).toBe(want.itemId);
  });

  it("forwarded mail: the original sender's domain finds the item, the forwarder's does not", async () => {
    const prepared = await prepareEmail(buildEmail(FORWARDED_CORPUS.email));
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(prepared.senderDomain).toBe("mailbox.example");
    expect(prepared.originalSenderDomain).toBe("billing.lakeside-auto.example");
    expect(prepared.originalSenderSource).toBe("forward_block");
    const query = { providerName: "Lakeside Auto Insurance", accountLast4: "4410", kind: "insurance:auto" };
    // Matching on the forwarder (the member's mailbox) finds nothing by domain.
    expect(matchItem({ ...query, senderDomain: prepared.senderDomain }, items).byDomain).toBe(false);
    // Matching on the original sender's domain finds r-car by domain.
    const r = matchItem({ ...query, senderDomain: prepared.originalSenderDomain }, items);
    expect(r).toMatchObject({ itemId: "r-car", method: "domain_kind", byDomain: true });
  });

  it("emails from unrelated providers match nothing", async () => {
    const c = CORPUS.find((x) => x.id === "brightwave-streaming-receipt")!;
    const prepared = await prepareEmail(buildEmail(c.email));
    if (!prepared.ok) throw new Error(prepared.reason);
    const r = matchItem(
      {
        senderDomain: prepared.senderDomain,
        providerName: "Brightwave",
        accountLast4: null,
        kind: "subscription",
      },
      items,
    );
    expect(r.status).toBe("none");
  });
});
