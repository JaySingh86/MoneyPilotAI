import { describe, expect, it } from "vitest";
import { riveraRenewalItems } from "../../testing/items.js";
import { isDomainMatch, kindOf, matchItem, type MatchQuery } from "./match.js";

const items = riveraRenewalItems();
const q = (p: Partial<MatchQuery>): MatchQuery => ({
  senderDomain: null,
  providerName: null,
  accountLast4: null,
  kind: null,
  ...p,
});

describe("kindOf", () => {
  it("combines category and insurance type", () => {
    expect(kindOf("insurance", "auto")).toBe("insurance:auto");
    expect(kindOf("insurance", null)).toBe("insurance");
    expect(kindOf("subscription", null)).toBe("subscription");
    expect(kindOf(null, null)).toBeNull();
  });
});

describe("matchItem: provider domain + last 4", () => {
  it("links the Northgate renters policy by domain and last 4", () => {
    const r = matchItem(
      q({ senderDomain: "notices.northgate-home.example", accountLast4: "4821", kind: "insurance:renters" }),
      items,
    );
    expect(r).toMatchObject({ status: "matched", itemId: "r-renters", method: "domain_last4" });
  });

  it("a different last 4 on the same domain is NOT the same policy", () => {
    const r = matchItem(
      q({ senderDomain: "northgate-home.example", accountLast4: "9999", kind: "insurance:renters" }),
      items,
    );
    expect(r.status).toBe("none");
  });

  it("an item without a stored last 4 can still match by domain and kind", () => {
    const r = matchItem(
      q({ senderDomain: "lakeside-auto.example", accountLast4: "1234", kind: "insurance:auto" }),
      items,
    );
    expect(r).toMatchObject({ status: "matched", itemId: "r-car", method: "domain_kind" });
  });
});

describe("matchItem: provider domain + kind", () => {
  it("separates two policies at the same provider by insurance type", () => {
    expect(
      matchItem(q({ senderDomain: "lakeside-auto.example", kind: "insurance:auto" }), items),
    ).toMatchObject({
      itemId: "r-car",
      method: "domain_kind",
    });
    expect(
      matchItem(q({ senderDomain: "lakeside-auto.example", kind: "insurance:motorcycle" }), items),
    ).toMatchObject({
      itemId: "r-moto",
    });
  });

  it("reports ambiguity instead of guessing", () => {
    const r = matchItem(q({ senderDomain: "lakeside-auto.example", kind: "insurance" }), items);
    expect(r.status).toBe("ambiguous");
    expect(r.itemId).toBeNull();
    expect(r.candidates.sort()).toEqual(["r-car", "r-moto"]);
  });

  it("unknown kind on a multi-item domain never picks one", () => {
    expect(matchItem(q({ senderDomain: "lakeside-auto.example" }), items).itemId).toBeNull();
  });
});

describe("matchItem: fuzzy name fallback", () => {
  it("matches a provider name when the sender domain is unknown to us", () => {
    const noDomain = items.map((i) => (i.id === "r-life" ? { ...i, providerDomain: null } : i));
    const r = matchItem(
      q({
        senderDomain: "mailer.example-mail.test",
        providerName: "Evergreen Life Insurance Co.",
        kind: "insurance:life",
      }),
      noDomain,
    );
    expect(r).toMatchObject({ status: "matched", itemId: "r-life", method: "fuzzy_name" });
  });

  it("never fuzzy-matches an item whose known domain differs from the sender (spoof guard)", () => {
    const r = matchItem(
      q({
        senderDomain: "evergreen-life-billing.evil.test",
        providerName: "Evergreen Life",
        kind: "insurance:life",
      }),
      items,
    );
    expect(r.status).toBe("none");
  });

  it("rejects weak name similarity", () => {
    expect(matchItem(q({ providerName: "Evergreen Landscaping" }), items).status).toBe("none");
  });

  it("webmail senders never match by domain", () => {
    const withDomain = items.map((i) => (i.id === "r-life" ? { ...i, providerDomain: "gmail.com" } : i));
    expect(matchItem(q({ senderDomain: "gmail.com", kind: "insurance:life" }), withDomain).status).toBe(
      "none",
    );
  });
});

describe("matchItem: bookkeeping", () => {
  it("passes through the confirmed flag", () => {
    const unconfirmed = items.map((i) => (i.id === "r-renters" ? { ...i, confirmed: false } : i));
    const r = matchItem(q({ senderDomain: "northgate-home.example", accountLast4: "4821" }), unconfirmed);
    expect(r).toMatchObject({ itemId: "r-renters", confirmed: false });
  });

  it("handles no items and no signals", () => {
    expect(matchItem(q({}), [])).toMatchObject({ status: "none", itemId: null, candidates: [] });
    expect(matchItem(q({}), items).status).toBe("none");
  });

  it("ignores a malformed last 4", () => {
    const r = matchItem(
      q({ senderDomain: "northgate-home.example", accountLast4: "48211234567", kind: "insurance:renters" }),
      items,
    );
    expect(r.method).toBe("domain_kind");
  });
});

describe("isDomainMatch: auto-apply must never rest on a name-only match", () => {
  const q2 = (p: Partial<MatchQuery>): MatchQuery => ({
    senderDomain: null,
    providerName: null,
    accountLast4: null,
    kind: null,
    ...p,
  });

  it("true for domain_last4 and domain_kind matches, with byDomain set", () => {
    const a = matchItem(q2({ senderDomain: "northgate-home.example", accountLast4: "4821" }), items);
    const b = matchItem(q2({ senderDomain: "lakeside-auto.example", kind: "insurance:auto" }), items);
    expect([a.byDomain, b.byDomain]).toEqual([true, true]);
    expect([isDomainMatch(a), isDomainMatch(b)]).toEqual([true, true]);
  });

  it("false for fuzzy-name matches, ambiguous results and no match", () => {
    const noDomain = items.map((i) => (i.id === "r-life" ? { ...i, providerDomain: null } : i));
    const fuzzy = matchItem(
      q2({ senderDomain: "other.test", providerName: "Evergreen Life", kind: "insurance:life" }),
      noDomain,
    );
    expect(fuzzy.method).toBe("fuzzy_name");
    expect(fuzzy.byDomain).toBe(false);
    expect(isDomainMatch(fuzzy)).toBe(false);
    const amb = matchItem(q2({ senderDomain: "lakeside-auto.example", kind: "insurance" }), items);
    expect(isDomainMatch(amb)).toBe(false);
    expect(isDomainMatch(matchItem(q2({}), items))).toBe(false);
  });

  it("cannot be forged by hand-building a fuzzy result", () => {
    expect(
      isDomainMatch({
        status: "matched",
        itemId: "r-life",
        method: "fuzzy_name",
        candidates: ["r-life"],
        confirmed: true,
        byDomain: true,
      }),
    ).toBe(false);
  });
});
