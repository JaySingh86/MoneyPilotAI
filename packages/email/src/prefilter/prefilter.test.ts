import { describe, expect, it } from "vitest";
import {
  buildMetadataCorpus,
  CORPUS_IGNORED_DOMAINS,
  CORPUS_WATCHED_DOMAINS,
} from "../../testing/metadata-corpus.js";
import { DEFAULT_THRESHOLD, parseFromAddress, prefilter, type PrefilterConfig } from "./prefilter.js";

const cfg: PrefilterConfig = {
  watchedDomains: CORPUS_WATCHED_DOMAINS,
  ignoredDomains: CORPUS_IGNORED_DOMAINS,
};
const meta = (from: string, subject: string, labels: string[] = ["INBOX"], listId: string | null = null) => ({
  from,
  subject,
  labels,
  listId,
});

describe("parseFromAddress", () => {
  it("takes the real address, not the display name", () => {
    expect(parseFromAddress('"billing@lakeside-auto.example" <phish@evil.example>')).toEqual({
      local: "phish",
      domain: "evil.example",
    });
    expect(parseFromAddress("Bill <Billing@Mail.X.Example>")).toEqual({
      local: "billing",
      domain: "mail.x.example",
    });
    expect(parseFromAddress("plain@x.example")).toEqual({ local: "plain", domain: "x.example" });
    expect(parseFromAddress("garbage")).toBeNull();
    expect(parseFromAddress("")).toBeNull();
  });
});

describe("prefilter decisions", () => {
  it("watched domain continues, whatever the subject", () => {
    const r = prefilter(meta("A <x@billing.lakeside-auto.example>", "Hello there"), cfg);
    expect(r).toMatchObject({ decision: "continue", reason: "watched_domain" });
  });

  it("lookalike domains are not watched", () => {
    for (const from of ["x@lakeside-auto.example.evil.test", "x@evillakeside-auto.example"]) {
      expect(prefilter(meta(from, "Hello there"), cfg).decision).toBe("out");
    }
  });

  it("ignored domain, promotions and social labels stop first, even for a watched sender", () => {
    expect(prefilter(meta("x@shopmart-deals.example", "Your statement is ready"), cfg)).toMatchObject({
      decision: "out",
      reason: "ignored_domain",
    });
    expect(
      prefilter(meta("x@lakeside-auto.example", "Your statement", ["INBOX", "CATEGORY_PROMOTIONS"]), cfg),
    ).toMatchObject({ decision: "out", reason: "promotions" });
    expect(prefilter(meta("x@a.example", "Your bill is ready", ["CATEGORY_SOCIAL"]), cfg)).toMatchObject({
      decision: "out",
      reason: "social",
    });
  });

  it("keyword score at or above the threshold continues; below stops", () => {
    expect(prefilter(meta("billing@acme.example", "Your October statement is ready"), cfg).decision).toBe(
      "continue",
    );
    expect(prefilter(meta("x@acme.example", "Lunch on Friday?"), cfg)).toMatchObject({
      decision: "out",
      reason: "low_score",
    });
    expect(DEFAULT_THRESHOLD).toBeGreaterThan(0);
  });

  it("marketing words cancel billing words", () => {
    expect(prefilter(meta("x@acme.example", "Last chance: 20% off premium upgrade"), cfg).decision).toBe(
      "out",
    );
    expect(prefilter(meta("x@acme.example", "Webinar: understanding your policy"), cfg).decision).toBe("out");
  });

  it("a hostile subject cannot force a continue through huge repetition or odd unicode", () => {
    const s = "statement ".repeat(5000);
    expect(prefilter(meta("x@acme.example", s), cfg).score).toBeLessThanOrEqual(10);
    expect(() => prefilter(meta("", "\u0000\uFFFF"), cfg)).not.toThrow();
  });

  it("unparseable From is treated as unknown, not as an error", () => {
    expect(prefilter(meta("???", "Your bill is ready"), cfg).decision).toBe("continue");
  });
});

describe("prefilter accuracy on the labeled metadata corpus", () => {
  const corpus = buildMetadataCorpus();
  const results = corpus.map((s) => ({
    s,
    predicted:
      prefilter({ from: s.from, subject: s.subject, labels: s.labels, listId: s.listId }, cfg).decision ===
      "continue",
  }));
  const tp = results.filter((r) => r.predicted && r.s.label).length;
  const fp = results.filter((r) => r.predicted && !r.s.label).length;
  const fn = results.filter((r) => !r.predicted && r.s.label).length;
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);

  it("is large enough to mean something", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(500);
    expect(corpus.filter((c) => c.label).length).toBeGreaterThanOrEqual(300);
  });

  it("precision >= 95%", () => {
    expect(precision, `precision ${precision.toFixed(4)} (fp=${fp})`).toBeGreaterThanOrEqual(0.95);
  });

  it("recall >= 98%", () => {
    expect(recall, `recall ${recall.toFixed(4)} (fn=${fn})`).toBeGreaterThanOrEqual(0.98);
  });
});
