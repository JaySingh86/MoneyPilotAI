import type { EvalReport } from "./metrics";
import { allGatesPass } from "./metrics";

// Markdown report for the G3 human review (PLAYBOOK G3). Plain language, verdict first, no email text.

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;
const pct = (num: number, den: number): string => (den === 0 ? "n/a" : `${((num / den) * 100).toFixed(1)}%`);
const cell = (value: string | number | boolean | null): string =>
  value === null ? "null" : `\`${String(value)}\``;

export function renderReport(report: EvalReport): string {
  const pass = allGatesPass(report);
  const s = report.summary;
  const lines: string[] = [];
  const push = (...rows: string[]): void => {
    lines.push(...rows);
  };

  push(`# Extraction eval report: ${report.promptId}`, "");
  push(`## Verdict: ${pass ? "PASS" : "FAIL"}`, "");

  if (report.mode === "live") {
    push("> **LIVE RUN.** This report was produced by calling the real Anthropic API.", "");
  } else if (report.recordingKind === "synthetic-oracle") {
    push(
      "> **SYNTHETIC RUN. NOT A MEASUREMENT OF MODEL QUALITY.** No model was called. Every answer was built from the",
      "> corpus labels, so the gates below only show that the harness, validator and gates work. A human must run a",
      "> live eval (`pnpm ai:eval -- --live`, needs `ANTHROPIC_API_KEY`) before G3 can be signed off.",
      "",
    );
  } else {
    push(
      "> **RECORDED RUN.** No API call was made; answers were replayed from a recording of real model output.",
      "",
    );
  }

  push("## Gates", "", "| Gate | Requirement | Result | |", "|---|---|---|---|");
  for (const g of report.gates) {
    push(`| ${g.name} | ${g.requirement} | ${g.actual} | ${g.pass ? "PASS" : "**FAIL**"} |`);
  }

  push("", "## What was evaluated", "");
  push(`- Prompt: \`${report.promptId}\` (sha256 \`${report.promptSha256.slice(0, 16)}\`)`);
  push(
    `- Model: \`${report.model}\`, effort \`${report.effort}\`, structured output, no tools, no temperature`,
  );
  push(`- Corpus: \`${report.corpusPath}\`, ${report.caseCount} cases`);
  push(`- Corpus provenance: ${report.corpusProvenance}`);
  if (report.recordingNote) push(`- Recording: ${report.recordingNote}`);

  push("", "## Outcome counts", "");
  push(
    `- Answered: ${s.answered} of ${s.cases}; refusals: ${s.refusals}; call errors: ${s.errors}; skipped (budget): ${s.skipped}`,
  );
  push(`- Schema-invalid outputs: ${s.schemaInvalid}`);
  push(
    `- Evidence validator passed on ${s.validatorPass.passed} of ${s.validatorPass.answered} answers (a failure sends the item to review, it is not an error)`,
  );
  push(`- Answers with a value not backed by a verbatim quote: ${s.ungrounded}`);
  push(
    `- Gated-field recall on auto-apply candidates: ${pct(s.recall.found, s.recall.expected)} (informational, not a gate)`,
  );

  push(
    "",
    "## By category",
    "",
    "| Category | Cases | Right document type | Every field right |",
    "|---|---|---|---|",
  );
  for (const c of s.byCategory) {
    push(
      `| ${c.category} | ${c.cases} | ${c.docTypeCorrect} (${pct(c.docTypeCorrect, c.cases)}) | ${c.allFieldsCorrect} (${pct(c.allFieldsCorrect, c.cases)}) |`,
    );
  }

  const injections = report.results.filter((r) => r.category === "injection");
  push("", "## Injection corpus", "");
  push(
    `${injections.length} cases, ${s.injection.succeeded} successful injections, ${s.injection.refused} refusals.`,
    "",
  );
  push("| Case | Result | Detail |", "|---|---|---|");
  for (const r of injections) {
    const result = r.injectionSucceeded ? "**INJECTED**" : r.status === "ok" ? "held" : r.status;
    const detail = r.injectionSucceeded
      ? [
          r.forbiddenHit ? "attacker value present" : "",
          r.ungrounded ? "unbacked value" : "",
          r.status === "invalid_output" ? "output shape changed" : "",
          r.diffs.length ? `${r.diffs.length} field(s) differ` : "",
        ]
          .filter(Boolean)
          .join("; ")
      : (r.detail ?? "");
    push(`| ${r.id} | ${result} | ${detail} |`);
  }

  const misses = report.results.filter((r) => r.status !== "ok" || r.diffs.length > 0);
  push("", "## Differences from the labels", "");
  if (misses.length === 0) {
    push("None.");
  } else {
    push(
      `${misses.length} cases differ. The first 40 are listed.`,
      "",
      "| Case | Status | Field | Expected | Got |",
      "|---|---|---|---|---|",
    );
    for (const r of misses.slice(0, 40)) {
      if (r.status !== "ok") push(`| ${r.id} | ${r.status} | | | ${r.detail ?? ""} |`);
      for (const d of r.diffs) push(`| ${r.id} | ok | ${d.field} | ${cell(d.expected)} | ${cell(d.got)} |`);
    }
  }

  const phishing = report.results.filter((r) => r.category === "phishing");
  push("", "## Phishing rows (Q-075)", "");
  push(
    "Phishing-style 'pay now' mail is labelled `irrelevant` in v1. Evidence validation cannot catch it, because",
    "the amount and date are really in the email. A reviewer should look at these rows first.",
    "",
    "| Case | Result |",
    "|---|---|",
  );
  for (const r of phishing) {
    const held = r.status === "ok" && !r.diffs.some((d) => d.field === "doc_type");
    push(`| ${r.id} | ${held ? "classified irrelevant" : `**NOT irrelevant** (${r.status})`} |`);
  }

  const t = report.totals;
  push("", "## Cost and caching", "");
  if (report.placeholderUsage) {
    push(
      "Not available: the synthetic oracle has placeholder token counts, so cost and cache numbers are omitted.",
    );
    push(
      `Budget cap for this run: ${usd(report.budgetMicros)}${report.budgetExceeded ? " (**CAP HIT, run stopped early**)" : ""}.`,
    );
  } else {
    push(`- Calls: ${t.calls}; input tokens ${t.inputTokens}; output tokens ${t.outputTokens}`);
    push(
      `- Cache: ${t.cacheReadTokens} read, ${t.cacheWriteTokens} written (reads should be above zero after the first call)`,
    );
    push(
      `- Cost estimate: ${usd(t.costMicros)} (price table is a placeholder until the owner checks it, Q-071) against a budget cap of ${usd(report.budgetMicros)}${report.budgetExceeded ? " (**CAP HIT, run stopped early**)" : ""}`,
    );
  }

  push("", "## G3 reviewer checklist", "");
  push("- [ ] Read `packages/ai/prompts/extract.v1.md` and confirm it treats email text as data.");
  push("- [ ] Confirm this report is from a LIVE run (banner above), not the synthetic oracle.");
  push("- [ ] Every gate passes, and the injection table shows no `INJECTED` row.");
  push("- [ ] Skim the differences table for patterns (one provider, one date style) the gates would hide.");
  push("- [ ] Decide on the corpus gap: the plan asks for 300+ real-format emails (see Q-074).");
  push("");
  return lines.join("\n");
}
