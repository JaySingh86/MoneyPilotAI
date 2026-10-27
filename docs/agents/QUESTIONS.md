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

## Q-009 · WP-02 · fast-check and vitest are blocked in engine tests by the dependency allowlist
- Asked by: wp-builder/wp/02-engine-core · 2026-10-27
- Where: BACKEND_PLAN §7.2 Tests ("Property (fast-check)"); `.dependency-cruiser.cjs` rule `engine-npm-allowlist`
- Question: The allowlist applies to every file under `packages/engine`, including `*.test.ts`, and covers `npm-dev`. So engine tests can't import `fast-check` (or even `vitest`). Should the engine rules exempt test files (e.g. `pathNot: "\\.test\\.ts$"` on `from`), or should fast-check be added to the allowlist?
- Options considered: (a) exempt test files from the engine npm rule; (b) add fast-check to the allowlist; (c) keep the current approach.
- Current approach (WP-02): engine tests run with `vitest run --globals` (no `vitest` import), and property tests use a seeded generator in `packages/engine/src/testing/prng.ts` (300 fixed seeds per property, with non-vacuity checks). (The related `Temporal.Now` lint gap is closed on main by `eslint.config.js`.)
- Blocking: no. If (a) or (b) is chosen, the property tests can move to fast-check without changing the properties.
- Answer: (tech lead, 2026-10-27; spec commit ee8a55f) (a). `.dependency-cruiser.cjs` now exempts `*.test.ts` and `packages/engine/src/testing/**` from the engine npm allowlist, and a new rule `engine-testing-only-in-tests` stops production code importing `@mp/engine/testing`. fast-check is optional; WP-02 keeps the seeded generator.

## Q-008 · WP-02 · What exactly counts in "Bills before payday"?
- Asked by: wp-builder/wp/02-engine-core · 2026-10-27
- Where: DESIGN_SPEC §5.1 Overview KPI tile; fixture `expected.billsBeforePayday` and `scenarios.shortfall.expected.itemsBeforePayday`
- Question: The fixture fixes the totals but not these edges: (1) does a bill due on the payday itself count as "before payday"? (2) does a bill already marked paid (still due in the window) count? (3) planned expenses: the shortfall scenario's `itemsBeforePayday` (9 items, $6,592.99) includes the car repair, so they seem to count, but the key name differs from `billsBeforePayday`; (4) how should `byOwner` treat Both/Split items (own key, or 50/50 between partners)?
- Options considered: as implemented, or the alternatives in each sub-question.
- Current behavior (WP-02): money out due from today through the day before payday; planned expenses included; paid occurrences still listed; skipped and payroll-paid items left out; `byOwner` uses the raw owner key (`both`, `split`, or a member id). All fixture values pass under this reading.
- Blocking: no.
- Answer: (tech lead, 2026-10-27) Accepted as built.

## Q-007 · WP-02 · Planning window when today is payday
- Asked by: wp-builder/wp/02-engine-core · 2026-10-27
- Where: DESIGN_SPEC §6 rules 1, 3, 5; BACKEND_PLAN §7.2 `planningWindow` ("on or after asOf")
- Question: When today is the primary payday, the window is a single day (`daysToPayday` 0). Rule 3 excludes the final payday from the lowest point, which leaves no days, and rule 5 divides by 0. Should the window instead run to the following payday on payday itself?
- Options considered: (a) keep the single-day window, take the lowest point over that day (including the pay) and show no per-day amount; (b) on payday, plan to the next payday.
- Current behavior (WP-02): (a). `perDayCents` is null.
- Blocking: no.
- Answer: (tech lead, 2026-10-27; spec commit ee8a55f) (b). The window ends at the next primary-income date strictly after `asOf`; on payday (Nov 6 in the fixture) it runs to Nov 20. Implemented in WP-02 with regression tests for asOf 2026-11-06.

## Q-006 · WP-02 · Rule 7 when the balance date equals the paid or due date
- Asked by: wp-builder/wp/02-engine-core · 2026-10-27
- Where: DESIGN_SPEC §6 rule 7; BACKEND_PLAN §7.2 `projectRunway`
- Question: Rule 7 covers a balance that is older or newer than a paid date, but not the same day. Also, should an unpaid occurrence due before the balance date (overdue) count?
- Options considered: (a) treat the balance as the closing balance of its date: a payment made on that date is already in it (doesn't count), an unpaid bill due that date still counts, and unpaid bills due before it don't count ("apply unpaid occurrences between them"); (b) treat it as an opening balance.
- Current behavior (WP-02): (a). A paid occurrence counts on its paid date when that date is after the balance date (a bill paid early moves to its paid date). Unpaid occurrences between the balance date and today are applied before the first day ("carried events"). The fixture's balance date is today, so golden values are the same either way.
- Blocking: no.
- Answer: (tech lead, 2026-10-27; spec commit ee8a55f) (a). Entered balances are end-of-day balances, so an occurrence paid that same day is already included. WP-07 will flag overdue unpaid bills.

## Q-005 · WP-02 · Which holiday observance does the weekend rule use?
- Asked by: wp-builder/wp/02-engine-core · 2026-10-27
- Where: BACKEND_PLAN §7.1 "Weekend rule … US federal holidays from a static table"
- Question: For a holiday on a Saturday, federal employees (OPM) observe the Friday before, but Federal Reserve banks stay open on that Friday. Since the weekend rule is about when money moves, which calendar should the table follow?
- Options considered: (a) Federal Reserve: Sunday → Monday, Saturday not shifted; (b) OPM: Sunday → Monday, Saturday → Friday.
- Current behavior (WP-02): (a), table for 2024–2035 in `packages/engine/src/schedule/holidays.ts`, verified against the statutory rules. Dates outside the table throw `holiday_table_out_of_range`, so a stale table fails loudly. Example difference: Fri Dec 31 2027 is a business day under (a), not under (b).
- Blocking: no.
- Answer: (tech lead, 2026-10-27) (a) Federal Reserve holiday calendar.

## Q-004 · WP-02 · Month-end days: clamp or skip?
- Asked by: wp-builder/wp/02-engine-core · 2026-10-27
- Where: BACKEND_PLAN §7.1 schedule mappings; ADR-006
- Question: A bill "monthly on the 30th" has no February date, an "every 6 months" anchor on Aug 31 has no Feb 31, and a yearly Feb 29 anchor has no date in common years. Under plain RFC 5545 (`BYMONTHDAY=30`) those months are skipped, which would leave a bill out of the plan. Should they clamp to the month's last day instead?
- Options considered: (a) clamp to the last day, encoded as `BYMONTHDAY=d,-1;BYSETPOS=1` so the RRULE and the expansion agree; (b) skip, as plain RFC 5545 does.
- Current behavior (WP-02): (a). `scheduleToRRule` emits the clamped form for days 29–31 (and Feb 29 yearly), and `scheduleFromRRule` rejects a bare `BYMONTHDAY=29..31` because it would skip months. Expansion is checked against the `rrule` library on 300 random schedules.
- Blocking: no.
- Answer: (tech lead, 2026-10-27; spec commit ee8a55f) (a) Clamp to the month's last day; a bill never vanishes.

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
