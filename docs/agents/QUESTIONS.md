# Open spec questions

Agents add questions here instead of guessing. The tech lead answers them. If an answer changes the spec, the spec is updated first (PLAYBOOK §9).

Format (newest first):

```
## Q-001 · WP-xx · short title
- Asked by: {agent/branch} · {date}
- Where: {file §section}
- Question: …
- Options considered: …
- Blocking: yes/no (what was skipped)
- Answer: … (tech lead, date)
```

## Q-003 · WP-04 · "Keep cents" under $100 vs the "+$55 / yr" example
- Asked by: wp-builder, wp/04-format-tokens · 2026-10-27
- Where: DESIGN_SPEC §7, Sign row
- Question: The rule says amounts under $100 "keep cents", but the example shows `+$55 / yr`, not `+$55.00 / yr`. `money(c, { mode: "chip" })` currently drops `.00` under $100 only when the amount is whole, so `+$55` and `−$22.99`. That satisfies every example. Is this the intended reading, or should whole amounts under $100 show `.00`?
- Options considered: (a) drop `.00` for whole amounts (implemented); (b) always 2 decimals under $100, which contradicts the example.
- Blocking: no.
- Answer: (tech lead, 2026-10-27) (a) Exact whole-dollar amounts drop `.00` in chips and per-year changes (`+$55`, `−$95`); other amounts under $100 keep cents (`−$22.99`). DESIGN_SPEC §7 updated.

## Q-002 · WP-04 · Formatting cases DESIGN_SPEC §7 doesn't cover
- Asked by: wp-builder, wp/04-format-tokens · 2026-10-27
- Where: DESIGN_SPEC §7 (and §6 rule 4); `packages/format`
- Question: §7 gives one example per rule. These cases have no example, so `packages/format` uses the provisional behavior listed below. Please confirm or correct each one:
  1. `relative(days)` for 0, ±1 and past days. Now: `today`, `tomorrow`, `yesterday`, `3 days ago` (§7 only shows `in 8 days`).
  2. `maskEmail` when the local part has 3 or fewer characters. Now: the literal rule, so `sam@x.com` becomes `sam•••@x.com`, which shows the whole local part. Should it keep fewer characters, such as `s•••@x.com`?
  3. Headline rounding for KPI tiles other than safe to spend. Now: every `headline` amount is floored toward −∞, as §6 rule 4 says for safe to spend. That matches the fixture (`$1,007`, `−$293`, `−$793`). Is flooring right for income and bill KPIs too, or should they round half-up?
  4. Negative estimates and whole-dollar signed amounts. Now: `~−$142.00` for a negative estimate. Whole-dollar chart labels use `headline` (`−$293`), so they never show `+`. Do calendar event chips ("amount, 600, signed", §4.2) show cents?
- Options considered: as listed. Each case sits in one function, so a change is small.
- Blocking: no. Provisional behavior is implemented and tested. All §7 examples are unaffected.
- Answer: (tech lead, 2026-10-27; DESIGN_SPEC §7 updated in a9b28d9)
  1. Accepted: today, tomorrow, in N days, yesterday, N days ago.
  2. Show at most 3 characters of the name and always hide at least one: `sam@x.com` → `sa•••@x.com`, `jo@x.com` → `j•••@x.com`, `x@x.com` → `•••@x.com`.
  3. Money you can spend (safe to spend, per day) rounds down, shortfalls round up, and averages and summaries round to the nearest dollar. Implemented as `money(c, { mode: "headline", rounding: "floor" | "nearest" })`, with floor as the default.
  4. Calendar chips and per-year changes keep the sign. They show whole dollars, rounded to the nearest dollar, at $100 or more, and keep cents below that. Negative estimates are `~−$142.00`. Implemented as `money(c, { mode: "chip" })`.

## Q-001 · WP-04 · Table-header letter spacing has no value in tokens.json
- Asked by: wp-builder, wp/04-format-tokens · 2026-10-27
- Where: `design/tokens.json` `typography.overline.$description`; `design/tokens.css` `--mp-tracking-table-header`; DESIGN_SPEC §2.2
- Question: `tokens.css` defines `--mp-tracking-table-header: 0.06em`, and DESIGN_SPEC §2.2 says table headers are 11 px / 600 / +0.06em. `tokens.json` mentions this only in a description, not as a value. Should `tokens.json` get a `typography.table-header` token (11px/14px, 600, 0.06em), with a matching `--mp-type-table-header` in `tokens.css`?
- Options considered: (a) add the token to both files (needs a spec change); (b) keep it CSS-only. For now the consistency check treats `--mp-tracking-table-header` as a documented CSS-only variable (`CSS_ONLY` in `packages/ui/src/tokens/build.ts`). The generated `cssVar.tracking.tableHeader` points to it, and there is no raw value in `tokens`.
- Blocking: no. Nothing was skipped. React Native has no raw table-header tracking value until this is answered.
- Answer: (tech lead, 2026-10-27; spec commit a9b28d9) `tokens.json` now has a `tracking.tableHeader` token (0.06em), not a full typography token. The consistency check maps it to `--mp-tracking-table-header`, the CSS-only special case is removed, and `tokens.generated.ts` is regenerated.
