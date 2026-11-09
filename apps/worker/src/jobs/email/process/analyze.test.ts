// The pipeline's decisions, by table: every signal the owner's rules name is flipped on its own against one clean,
// auto-applicable message, and the policy must send it to review for exactly that reason. The policy's own table is in
// packages/review-rules; this file proves the worker feeds it the RIGHT signals (hard rules 4 and 9, Q-060, Q-062).
import { describe, expect, it } from "vitest";
import type { ExtractOutcome, ExtractionResult } from "@mp/ai/extract";
import type { RenewalDetails } from "@mp/contracts";
import type { AuthenticationVerdicts } from "@mp/email";
import type { MatchableItem } from "@mp/email";
import {
  evaluate,
  isPlainReceipt,
  isPriceChange,
  matchTypeForMatched,
  runMatch,
  triage,
  type ItemContext,
  type PreparedSummary,
  type Triage,
} from "./analyze";

const POWER: MatchableItem = {
  id: "item-power",
  providerName: "City Power & Light",
  providerDomain: "citypowerlight.example",
  accountLast4: "0937",
  kind: "utilities",
  confirmed: true,
};

const ctx = (over: Partial<ItemContext> = {}): ItemContext => ({
  id: "item-power",
  name: "Electricity",
  category: "utilities",
  rrule: "FREQ=MONTHLY;BYMONTHDAY=3",
  amountType: "estimated",
  amountCents: null,
  expectedAmountCents: 14200,
  ownerType: "member",
  ownerUserId: "u-sam",
  scheduled: [{ id: "occ-1", scheduledOn: "2026-11-03", dueOn: "2026-11-03", actualAmountCents: null }],
  renewal: null,
  ...over,
});

const extraction = (over: Partial<ExtractionResult> = {}): ExtractionResult => ({
  doc_type: "statement",
  provider_name: "City Power & Light",
  category: "utilities",
  insurance_type: null,
  amount_due_cents: 15137,
  previous_amount_cents: null,
  due_date: "2026-11-03",
  renewal_date: null,
  cancel_by_date: null,
  decision_by_date: null,
  frequency: null,
  auto_renews: null,
  account_last4: "0937",
  evidence: [
    { field: "amount_due_cents", quote: "Amount due: $151.37" },
    { field: "due_date", quote: "Due date: 11/03/2026" },
  ],
  ...over,
});

const outcome = (
  e: ExtractionResult,
  over: { ok?: boolean; advisory?: string[]; fence?: boolean } = {},
): ExtractOutcome => ({
  status: "ok",
  extraction: e,
  validation: {
    ok: over.ok ?? true,
    failures: over.ok === false ? [{ rule: "evidence_not_verbatim", field: "amount_due_cents" }] : [],
    advisoryFields: over.advisory ?? [],
  },
  signals: { fenceTampered: over.fence ?? false },
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

const AUTH_PASS: AuthenticationVerdicts = {
  authservId: "mx.google.com",
  dkim: "pass",
  spf: "pass",
  dmarc: "pass",
  dmarcAligned: true,
};

const prepared = (over: Partial<PreparedSummary> = {}): PreparedSummary => ({
  senderDomain: "citypowerlight.example",
  subject: "Your October statement is ready",
  truncated: false,
  authentication: AUTH_PASS,
  notes: [],
  originalSenderDomain: null,
  originalSenderSource: null,
  ...over,
});

interface Scenario {
  out?: ExtractOutcome;
  prep?: PreparedSummary;
  items?: MatchableItem[];
  item?: ItemContext | null;
  firstSeen?: boolean;
  flag?: boolean;
}

function run(s: Scenario = {}) {
  const prep = s.prep ?? prepared();
  const t = triage(s.out ?? outcome(extraction()), prep);
  if (t.kind !== "extracted") throw new Error(`expected an extraction, got ${t.kind}`);
  const match = runMatch(s.items ?? [POWER], t.mapped.fields, prep, { fromDomain: "citypowerlight.example" });
  const item = s.item === undefined ? (match.status === "matched" ? ctx() : null) : s.item;
  return evaluate({
    extracted: t,
    prepared: prep,
    message: { fromDomain: "citypowerlight.example" },
    match,
    item,
    senderFirstSeen: s.firstSeen ?? false,
    autoApplyEnabled: s.flag ?? true,
  });
}

function reasons(e: ReturnType<typeof evaluate>): readonly string[] {
  if (e.kind !== "route") throw new Error("skipped");
  return e.decision.action === "review" ? e.decision.reasons : [];
}

describe("the clean case", () => {
  it("replaces an estimate with the actual amount automatically, by provider domain and last 4", () => {
    const e = run();
    expect(e).toMatchObject({ kind: "route", matchType: "update", matchItemId: "item-power" });
    expect(e.kind === "route" && e.decision).toEqual({ action: "auto_apply", change: "estimate_to_actual" });
  });

  it("the stored checks carry rule and field names and the signals, never a value", () => {
    const e = run();
    const text = JSON.stringify(e.kind === "route" ? e.checks : {});
    expect(text).not.toMatch(/15137|151\.37|citypowerlight|0937/);
    expect(e.kind === "route" && e.checks).toMatchObject({
      pipeline: "email.v1",
      signals: { dmarcAligned: true, domainMatch: true, senderFirstSeen: false, autoApplyEnabled: true },
      decision: { action: "auto_apply", change: "estimate_to_actual" },
    });
  });
});

describe("one signal at a time goes to review (BACKEND_PLAN §7.8.2 auto-apply policy)", () => {
  const rows: [string, Scenario, string][] = [
    ["the household has not turned auto-apply on (the flag is off)", { flag: false }, "auto_apply_disabled"],
    ["the sender is first-seen for this item", { firstSeen: true }, "first_seen_sender"],
    [
      "no DMARC pass aligned with From (Q-062)",
      { prep: prepared({ authentication: { ...AUTH_PASS, dmarc: "none", dmarcAligned: false } }) },
      "sender_not_authenticated",
    ],
    [
      "a forwarded message, even when the forwarder passes DMARC (its verdict is not the sender's)",
      {
        prep: prepared({
          originalSenderDomain: "citypowerlight.example",
          originalSenderSource: "forward_block",
        }),
      },
      "sender_not_authenticated",
    ],
    [
      "the fence around the email was tampered with (Q-060)",
      { out: outcome(extraction(), { fence: true }) },
      "injection_suspected",
    ],
    [
      "the text sanitizer flagged an injection attempt",
      { prep: prepared({ notes: ["injection_suspected"] }) },
      "injection_suspected",
    ],
    [
      "the body tried to close the model's <email> fence (prepareEmail defused it and left a note, S2)",
      { prep: prepared({ notes: ["fence_tampered"] }) },
      "injection_suspected",
    ],
    [
      "a quote is not verbatim in the redacted text (validation failed)",
      { out: outcome(extraction(), { ok: false }) },
      "validation_failed",
    ],
    [
      "frequency or auto-renew without a quote",
      { out: outcome(extraction({ frequency: "monthly" }), { advisory: ["frequency"] }) },
      "advisory_fields",
    ],
    [
      "the match is by a name only (the item has no provider domain)",
      { items: [{ ...POWER, providerDomain: null }] },
      "no_domain_match",
    ],
    ["the matched item is not confirmed", { items: [{ ...POWER, confirmed: false }] }, "item_not_confirmed"],
    [
      "the amount is more than 50% over the estimate",
      { out: outcome(extraction({ amount_due_cents: 30000 })) },
      "not_an_expected_change",
    ],
    [
      "the bill is not the one we expect on that date",
      { out: outcome(extraction({ due_date: "2026-11-20" })) },
      "not_an_expected_change",
    ],
    [
      "a price change is a decision, not a safe update",
      { out: outcome(extraction({ doc_type: "price_change" })) },
      "doc_type_not_auto",
    ],
  ];
  it.each(rows)("%s", (_name, scenario, reason) => {
    const e = run(scenario);
    expect(e.kind === "route" && e.decision.action).toBe("review");
    expect(reasons(e)).toContain(reason);
  });

  it("a value the review contract cannot hold counts as a failed check", () => {
    const e = run({ out: outcome(extraction({ amount_due_cents: -100 })) });
    expect(reasons(e)).toEqual(expect.arrayContaining(["validation_failed"]));
    expect(e.kind === "route" && e.checks).toMatchObject({
      validation: { ok: false, failures: [{ rule: "contract_refused", field: "amountDueCents" }] },
    });
  });

  it("a value without a verbatim evidence quote never auto-applies, whatever else is true", () => {
    // WP-11 validation says the quote is not in the text; every other signal is perfect.
    const e = run({ out: outcome(extraction({ evidence: [] }), { ok: false }) });
    expect(e.kind === "route" && e.decision.action).toBe("review");
  });
});

describe("domainMatch comes only from isDomainMatch", () => {
  it("an item found by fuzzy name is never a domain match, even with every other signal perfect", () => {
    const fuzzy: MatchableItem = { ...POWER, providerDomain: null, accountLast4: null };
    const e = run({ items: [fuzzy] });
    expect(e.kind === "route" && e.checks).toMatchObject({
      match: { status: "matched", method: "fuzzy_name" },
      signals: { domainMatch: false },
    });
    expect(reasons(e)).toContain("no_domain_match");
  });

  it("an ambiguous match gives no item and no auto-apply, and is queued as a new item with the ambiguity recorded", () => {
    const e = run({
      items: [
        { ...POWER, id: "a", accountLast4: null, kind: "insurance" },
        { ...POWER, id: "b", accountLast4: null, kind: "insurance" },
      ],
      out: outcome(extraction({ category: "insurance", account_last4: null })),
    });
    expect(e).toMatchObject({ kind: "route", matchType: "new", matchItemId: null });
    expect(e.kind === "route" && e.checks).toMatchObject({ match: { status: "ambiguous", candidates: 2 } });
    expect(reasons(e)).toEqual(expect.arrayContaining(["no_matched_item", "no_domain_match"]));
  });

  it("no match at all is a new item for review", () => {
    const e = run({ items: [] });
    expect(e).toMatchObject({ kind: "route", matchType: "new", matchItemId: null });
  });
});

describe("match types", () => {
  const f = (over: Partial<ExtractionResult>) => {
    const t = triage(outcome(extraction(over)), prepared()) as Extract<Triage, { kind: "extracted" }>;
    return t.mapped.fields;
  };

  it("an actual for an estimated bill is an update", () => {
    expect(matchTypeForMatched(f({}), ctx())).toBe("update");
  });

  it("an enrollment deadline is a decision", () => {
    expect(matchTypeForMatched(f({ doc_type: "enrollment_deadline" }), ctx())).toBe("decision");
  });

  it("an identical notice for a fixed item changes nothing: a duplicate", () => {
    const fixed = ctx({ amountType: "fixed", amountCents: 15137, expectedAmountCents: 15137 });
    expect(matchTypeForMatched(f({}), fixed)).toBe("duplicate");
  });

  it("a renewal notice that repeats the renewal details is a duplicate; one that changes a value is an update", () => {
    const renewal: RenewalDetails = {
      autoRenews: "yes",
      coverageStart: null,
      coverageEnd: "2027-01-09",
      cancelBy: null,
      decisionBy: null,
      shopAroundOn: null,
      previousAmountCents: null,
      priceChangedOn: null,
    };
    const fixed = ctx({ amountType: "fixed", amountCents: 16800, expectedAmountCents: 16800, renewal });
    const same = f({
      doc_type: "renewal_notice",
      amount_due_cents: 16800,
      due_date: null,
      renewal_date: "2027-01-09",
    });
    expect(matchTypeForMatched(same, fixed)).toBe("duplicate");
    const changed = f({
      doc_type: "renewal_notice",
      amount_due_cents: 16800,
      due_date: null,
      renewal_date: "2027-02-09",
    });
    expect(matchTypeForMatched(changed, fixed)).toBe("update");
  });
});

describe("what is not worth a card", () => {
  it("a plain receipt (nothing recurring in it) is skipped, matched or not", () => {
    const receipt = extraction({ doc_type: "receipt", due_date: null });
    const t = triage(outcome(receipt), prepared()) as Extract<Triage, { kind: "extracted" }>;
    expect(isPlainReceipt(t.mapped.fields)).toBe(true);
    expect(run({ out: outcome(receipt) })).toEqual({ kind: "skip", reason: "plain_receipt" });
    expect(run({ out: outcome(receipt), items: [] })).toEqual({ kind: "skip", reason: "plain_receipt" });
  });

  it("a receipt that shows a repeat (a frequency or a next charge) is kept", () => {
    expect(
      run({
        out: outcome(extraction({ doc_type: "receipt", frequency: "monthly" }), { advisory: ["frequency"] }),
      }).kind,
    ).toBe("route");
  });

  it("irrelevant, refused and unreadable outputs leave nothing behind", () => {
    expect(triage(outcome(extraction({ doc_type: "irrelevant" })), prepared())).toEqual({
      kind: "irrelevant",
    });
    expect(
      triage(
        {
          status: "refusal",
          category: null,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
        prepared(),
      ),
    ).toEqual({ kind: "unusable", reason: "refusal" });
    expect(
      triage(
        {
          status: "invalid_output",
          reason: "parse_failed",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
        prepared(),
      ),
    ).toEqual({ kind: "unusable", reason: "invalid_output" });
    expect(triage({ status: "batch_error" }, prepared())).toEqual({
      kind: "unusable",
      reason: "batch_error",
    });
  });
});

describe("a reminder needs a clean, domain-matched, confirmed, unforwarded message (S3)", () => {
  const allowed = (s: Scenario) => {
    const e = run(s);
    return e.kind === "route" && e.reminderAllowed;
  };
  it("is allowed for the clean case, even when the item is only queued for review", () => {
    expect(allowed({})).toBe(true);
    expect(allowed({ flag: false, firstSeen: true })).toBe(true);
  });
  it.each<[string, Scenario]>([
    [
      "a forwarded message",
      {
        prep: prepared({
          originalSenderDomain: "citypowerlight.example",
          originalSenderSource: "forward_block",
        }),
      },
    ],
    [
      "a sender that is not DMARC-authenticated and aligned",
      { prep: prepared({ authentication: { ...AUTH_PASS, dmarc: "none", dmarcAligned: false } }) },
    ],
    ["a fence-tampered message", { prep: prepared({ notes: ["fence_tampered"] }) }],
    ["a sanitizer-flagged message", { prep: prepared({ notes: ["injection_suspected"] }) }],
    ["a name-only match", { items: [{ ...POWER, providerDomain: null, accountLast4: null }] }],
    ["an unconfirmed item", { items: [{ ...POWER, confirmed: false }] }],
    ["no match", { items: [] }],
  ])("is not allowed for %s", (_n, s) => {
    expect(allowed(s)).toBe(false);
  });
});

describe("price change (Q-134)", () => {
  const t = (over: Partial<ExtractionResult>, ok = true) =>
    triage(outcome(extraction(over), { ok }), prepared()) as Extract<Triage, { kind: "extracted" }>;

  it("a validated increase over the quoted previous amount is a price change (the engine's own isPriceUp rule)", () => {
    expect(isPriceChange(t({ amount_due_cents: 2499, previous_amount_cents: 2299 }), null)).toBe(true);
  });

  it("a bare price_change notice is compared with what the engine plans for the item", () => {
    const bare = t({ doc_type: "price_change", amount_due_cents: 2499, previous_amount_cents: null });
    expect(isPriceChange(bare, { expectedAmountCents: 2299 })).toBe(true);
    expect(isPriceChange(bare, { expectedAmountCents: 2499 })).toBe(false);
    expect(isPriceChange(bare, null)).toBe(false);
  });

  it("an increase too small to matter, a decrease and an unvalidated email are not", () => {
    expect(isPriceChange(t({ amount_due_cents: 2305, previous_amount_cents: 2299 }), null)).toBe(false);
    expect(isPriceChange(t({ amount_due_cents: 1999, previous_amount_cents: 2299 }), null)).toBe(false);
    expect(isPriceChange(t({ amount_due_cents: 2499, previous_amount_cents: 2299 }, false), null)).toBe(
      false,
    );
  });
});
