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

## Q-126 · WP-14 · Consented eval feed from edited review items
- Asked by: wp-builder/wp/14-review-queue · 2026-11-03
- Where: BACKEND_PLAN §8.2 (`edit` "feeds eval data (with consent)"); BACKEND_PLAN §7.9 (evals); G3
- Question: An edit now keeps the original extraction in `extracted_items.original_fields` and marks `evidence_stale`, so the corrected values and what the model produced are both available. The feed itself is not built: which household setting records consent, what is copied (fields only, never the subject or evidence quotes), where it goes (the eval dataset in `packages/ai`), how long it is kept, and whether it is redacted again. Decide at G3.
- Options considered: (a) opt-in household setting, fields and doc type only, redacted, 90 days; (b) no feed until a separate consent flow exists.
- Blocking: no.
- Answer:

## Q-125 · WP-14 · Where does the auto-apply policy live, and who applies an automatic change?
- Asked by: wp-builder/wp/14-review-queue · 2026-11-03
- Where: BACKEND_PLAN §7.8.2 (decide); ARCHITECTURE §3 (dependency rules); WORK_PLAN WP-14 / WP-22
- Question: WP-14 owns only `apps/api/src/modules/review/**`, so the pure policy `decideExtraction` is in `apps/api/src/modules/review/decide.ts`. It takes `domainMatch: boolean` (the caller passes `isDomainMatch(match)`), because apps/api may not import `@mp/email` (rule `only-worker-touches-secrets`). Two things need a decision for WP-22: (1) may the worker import `apps/api/src/modules/review/decide.ts`, or should the policy move to a shared package (for example `packages/contracts` or a new `packages/review`)? (2) Auto-apply must edit items and write `applied_changes` as `mp_worker`, but the items service (`apps/api/src/modules/items/service.ts`) is bound to `ApiDb`. Should WP-22 get a worker-side port of that apply path, or should the items rules move into a shared package?
- Options considered: (a) leave as is and let WP-22 import across apps (no depcruise rule forbids worker to api); (b) move policy and apply planning (`decide.ts`, `apply.ts`) to a package; (c) worker enqueues an API call with a service token.
- Blocking: no. The policy is implemented and tested; `applied_changes` and `extracted_items` already grant the worker the insert and update it needs.
- Answer: Answered (tech lead for owner, 2026-11-03): (b). The policy and the pure apply planning live in `packages/review-rules` (`@mp/review-rules`), a pure package like the engine (types-only imports from contracts, enforced by dependency-cruiser and a fitness test). apps/api uses it now; WP-22's worker uses it through a worker-side items-apply port with the same guards.

## Q-124 · WP-14 · Source of items created from a confirmed email
- Asked by: wp-builder/wp/14-review-queue · 2026-11-03
- Where: BACKEND_PLAN §5.2 (`recurring_items.source`); migration `202610281300_wp06_items-schedules.sql` (insert policy)
- Question: Confirming a `new` extraction creates an item through the WP-06 items service. The mp_api insert policy forces `source = 'manual'`, so the item is not marked `email` (or `csv`). The owner is the person who confirmed. Is that right, or should a confirmed email item carry `source = 'email'` (needs a policy change so mp_api may insert `email`/`csv` when it comes from a confirm) and should the owner be asked for?
- Options considered: (a) keep `manual` and the confirmer as owner (implemented); (b) widen the policy and set the source; (c) add `ownerUserId` to the edit body.
- Blocking: no.
- Answer: Answered (tech lead for owner, 2026-11-03): the source comes from the server, never the client. mp_api's general insert policy stays manual-only; a second policy lets it insert an `email`/`csv` item only inside a decision about a still-queued extracted item of the same household and the same source. The confirmer stays the owner.

## Q-123 · WP-14 · Hard-coded rules for turning an extraction into a new item
- Asked by: wp-builder/wp/14-review-queue · 2026-11-03
- Where: BACKEND_PLAN §7.8.2 (extraction schema), §5.2 (`recurring_items`)
- Question: The spec says what is queued but not how a confirmed `new` item is built. `apply.ts` (`itemFromFields`) uses: name = provider name; due date (else renewal date) = schedule start; frequency maps to a schedule (monthly, every 2 months, quarterly, every 6 months, yearly; `one_time` is yearly ending the same day); a missing name, date or frequency asks the user to edit instead of guessing; category `debt` becomes kind `loan`, `income` becomes an inflow; amount type is `statement` for bills and statements, `fixed` for notices, `estimated` when there is no amount. Please confirm or correct.
- Options considered: as listed.
- Blocking: no.
- Answer: Answered (tech lead for owner, 2026-11-03): approved as written. Fixtures added for the debt to loan and income mappings.

## Q-122 · WP-14 · Undo cannot delete a renewal record or an amount-history point
- Asked by: wp-builder/wp/14-review-queue · 2026-11-03
- Where: BACKEND_PLAN §8.2 (`PUT …/renewal`, `GET …/history`); `apps/api/src/modules/items/service.ts`
- Question: Undo restores values through the items service, which can set renewal details but not remove them, and `patchOccurrence` adds an amount-history point when an actual amount is set. After undoing a change on an item that had no renewal, it keeps an empty renewal record (it would list in Subscriptions & renewals with no dates), and an undone actual amount stays in the item's amount history. Should WP-06 add `deleteRenewal` and a history delete (or make `putRenewal` accept null to clear)?
- Options considered: (a) accept the leftovers (implemented); (b) add the two operations to the items service.
- Blocking: no.
- Answer: Answered (tech lead for owner, 2026-11-03): (b). `deleteRenewal` and `deleteHistoryPoint` are added to the WP-06 items service, guarded like other partner-item writes; undo uses them and leaves no empty renewal or leftover history point.

## Q-121 · WP-14 · Plan delta and number-free summary on the review card
- Asked by: wp-builder/wp/14-review-queue · 2026-11-03
- Where: BACKEND_PLAN §8.3 (`effect.planDelta`, `effect.summary` example "flags a $19 increase")
- Question: `effect.planDelta.safeToSpendCents` needs a plan computed with and without the change, which needs the plan service (WP-12). It is `null` for now. `effect.summary` is built from templates without any amount (for example "Updates Renters insurance and flags a price change."), because a "$19" difference would be arithmetic on money outside `packages/engine` (hard rule 4). Should the summary carry the difference (computed by the engine and formatted by `packages/format`) once WP-12 lands?
- Options considered: (a) null delta and no amounts (implemented); (b) engine-computed delta and increase in a follow-up.
- Blocking: no. The card shows `fields` (new and previous amount) as they are.
- Answer: Answered (tech lead for owner, 2026-11-03): accepted. `planDelta` stays null and the summary stays number-free. A `plan` field on the decision response is added only with WP-12/WP-23 and never computed by the review service.

## Q-120 · WP-14 · `email_messages` does not exist yet, so `extracted_items.message_id` has no foreign key
- Asked by: wp-builder/wp/14-review-queue · 2026-11-03
- Where: BACKEND_PLAN §5.2 (`extracted_items.message_id`, `email_messages`); WORK_PLAN WP-20 owns the `email_messages` migration
- Question: `extracted_items` references `email_messages(id)`, but that table is created by WP-20. Migrations are expand-only and cannot reference a missing table, so `message_id` is a plain uuid for now and WP-20 adds the foreign key (`on delete set null`). Also, the review payload needs the sender domain, subject and received time (§8.3 `message`), so `extracted_items.message_meta` (jsonb: `fromDomain`, `subject`, `receivedAt`) holds a copy; no body is stored. Is the denormalized `message_meta` acceptable, or should the API join `email_messages` once it exists (CSV items have no message)?
- Options considered: (a) `message_meta` copy (implemented); (b) join `email_messages` for email and nothing for CSV.
- Blocking: no.
- Answer: Answered (tech lead for owner, 2026-11-03): accepted. The WP-20 foreign key comes later; the retention purge (WP-24) nulls `message_meta`.
## Q-107 · WP-12 · An estimated item with no amount history
- Asked by: wp-builder/wp/12-planning-api · 2026-11-03
- Where: `packages/db/src/planning/engine-input.ts`; engine `validateInput` ("an estimated amount needs history"); contracts `CreateItem` (only `fixed` requires `amountCents`)
- Question: A member can create an `estimated` item with neither history nor an amount. The engine refuses an estimated item without history, which would make `GET /plan` fail for the whole household because of one row. The projection uses the stored amount as a one-entry history, else `[0]`, so the bill is in the plan (at $0, flagged `estimate`) instead of the plan being unavailable. Is that right, or should `CreateItem` require an amount or a first history entry for estimated items (a WP-06 contract change)?
- Options considered: (a) the fallback as built; (b) require `amountCents` for estimated and statement items at create and patch; (c) leave the item out of the plan and say so in a flag.
- Blocking: no.
- Answer: Answered (tech lead for owner, 2026-11-03): (b) `amountCents` is required for estimated and statement items at create and patch (WP-06 contract and service). The projection fallback stays as a defensive path and raises a `data_missing` flag instead of a silent $0.

## Q-106 · WP-12 · Plan for a past `asOf`: which balance, which occurrences?
- Asked by: wp-builder/wp/12-planning-api · 2026-11-03
- Where: BACKEND_PLAN §8.2 (`GET /plan?asOf=`), DESIGN_SPEC §6 rule 7
- Question: `asOf` before the latest balance's date would make the engine refuse the input (balance after asOf). The projection picks the latest balance dated on or before `asOf`, and the occurrence rows as they are today (paid marks made later still show). So a past `asOf` is a recomputation with today's data, not a historical replay. Is that the intended meaning (the web never sends `asOf`; it is for tests and the weekly digest), or must past plans be reproduced from their stored snapshot?
- Options considered: (a) as built; (b) `asOf` earlier than today returns the stored snapshot for that date if there is one, else 404.
- Blocking: no.
- Answer: Answered (tech lead for owner, 2026-11-03): Keep (recompute from today's data). `asOf` is bounded to local today +-400 days and only today's plan is stored.

## Q-105 · WP-12 · Which database role runs pg-boss, and who may enqueue from the API?
- Asked by: wp-builder/wp/12-planning-api · 2026-11-03
- Where: BACKEND_PLAN §9, ADR-004 (jobs enqueued in the same transaction as the data change); `apps/worker/src/index.ts`
- Question: pg-boss creates and migrates its own `pgboss` schema on start, which needs the right to create a schema; `mp_worker` has no such right and `mp_api` cannot enqueue at all. Locally the worker starts pg-boss with `PGBOSS_DATABASE_URL`, falling back to the migrator URL. What should AWS use (a dedicated `mp_queue` role with USAGE on `pgboss` and the schema created by a migration step; or run `getConstructionPlans` output as a migration), and may `mp_api` get INSERT on `pgboss.job` so the API can enqueue in the data-change transaction? The pgboss tables have no `household_id`, are outside `public`, and are not covered by the RLS suite; jobs carry only a household id and ids.
- Options considered: (a) migrator creates the schema in a migration, a `mp_queue` role runs the worker's pg-boss and the API enqueues through `mp_queue` grants; (b) pg-boss runs as migrator everywhere (not acceptable for a long-running process).
- Blocking: no for local and tests. The API does not enqueue yet (Q-102).
- Answer: Answered (tech lead for owner, 2026-11-03): WP-09 adds an `mp_queue` role (on its checklist). Locally the migrator fallback stays; in production the worker refuses to start without `PGBOSS_DATABASE_URL` and checks the role.

## Q-104 · WP-12 · Retention of `calc_snapshots`
- Asked by: wp-builder/wp/12-planning-api · 2026-11-03
- Where: BACKEND_PLAN §5.2 (`calc_snapshots`), §7.11 (retention)
- Question: `GET /plan` stores one immutable snapshot per distinct input (so also one per day, because `asOf` is part of the input). Neither app role may delete them (no DELETE grant), so they only grow: roughly one per household per active day plus one per edit. Explain texts and proposals will reference some of them. How long are snapshots kept, and which ones are exempt (those referenced by `ai_texts` or proposals)? Needs a definer purge function like Q-055, in WP-24.
- Options considered: keep 90 days plus anything referenced; keep the last N per household.
- Blocking: no.
- Answer: Answered (tech lead for owner, 2026-11-03): WP-24 does the purge (on its checklist).

## Q-103 · WP-12 · Bills averages: `?include=averages` on the items list, or their own endpoint?
- Asked by: wp-builder/wp/12-planning-api · 2026-11-03
- Where: WORK_PLAN WP-12 ("bills averages (on the items list response)"), BACKEND_PLAN §8.2 (no averages endpoint listed), DESIGN_SPEC §6 rule 17
- Question: Built as the work plan says: `GET /households/:hid/items?include=averages` adds `averages` ({ rows, monthlyBillsAverageCents, monthlyIncomeAverageCents, leftAfterBillsCents, estimatesToConfirm, byItem }) to the page. The averages always cover every Bills & recurring item of the household, whatever filters, owner or cursor the list uses (they are the screen's KPI strip, not a total of the visible page). Is that the intended meaning, and should the web call it once with the first page only? The extra field is optional, so existing clients are unaffected.
- Options considered: (a) as built; (b) a separate `GET /households/:hid/bills/averages` (the web would not need a list call for the KPIs).
- Blocking: no.
- Answer: Answered (tech lead for owner, 2026-11-03): Keep. The web calls it on page 1 only.

## Q-102 · WP-12 · Who enqueues `plan.recompute` after a data change?
- Asked by: wp-builder/wp/12-planning-api · 2026-11-03
- Where: BACKEND_PLAN §7.2 ("any write to items, occurrences, balances, planned expenses or goals enqueues `plan.recompute`"), WORK_PLAN WP-12, QUESTIONS Q-056
- Question: The job (debounced singleton, 2 s) and `enqueuePlanRecompute(sender, householdId)` exist in `apps/worker/src/jobs/plan/recompute.ts`, but nothing calls it: the writes live in WP-05 (cushion, primary income), WP-06 (items, occurrences, planned expenses, balances) and WP-13 (goals), the API has no pg-boss connection (Q-105), and WP-12 may not edit those modules. Correctness does not depend on the job: `GET /plan` computes on read and dedupes by `inputs_hash`, so a cushion or primary-income change gives a new `calcSnapshotId` and new values on the next read (tested). Should each write path call an `onPlanInputsChanged(tx, householdId)` hook from its own transaction (once Q-105 is answered), or is a database trigger that records the change for the worker preferred?
- Options considered: (a) a hook in each owning module, enqueue after commit; (b) pg-boss `send` inside the write transaction (needs INSERT on `pgboss.job`); (c) a trigger on the input tables writing an outbox row that the worker polls.
- Blocking: no. Compute-on-read covers the acceptance item "recompute when the cushion or primary income changes".
- Answer: Answered (tech lead for owner, 2026-11-03): Compute-on-read stays. Enqueue hooks come after the queue role (WP-09/WP-26 checklists). `enqueuePlanRecompute` is marked not yet wired.

## Q-101 · WP-12 · Which error answers a plan request before onboarding is complete?
- Asked by: wp-builder/wp/12-planning-api · 2026-11-03
- Where: BACKEND_PLAN §8.1 (error codes), §8.2
- Question: `GET /plan`, `/calendar` and `/plan/what-if` need a primary income and a balance. Without them the API answers 409 `conflict` with a static message ("Enter your current balance before planning."). There is no code the web can switch on to show the empty/onboarding state, so it would have to read `detail`. Should we add `plan_not_ready` (409) to the error codes? `/renewals`, `/renewals/summary` and the bills averages work without either.
- Options considered: (a) 409 `conflict` as built; (b) a new `plan_not_ready` code with a `reason` of `no_primary_income` or `no_balance`.
- Blocking: no.
- Answer: Answered (tech lead for owner, 2026-11-03): Add a `plan_not_ready` 409 code with a static `reason` (`no_balance` or `no_primary_income`). Built.

## Q-100 · WP-12 · The plan payload follows the engine's result, not the abridged §8.3 example
- Asked by: wp-builder/wp/12-planning-api · 2026-11-03
- Where: BACKEND_PLAN §8.3 (`GET /plan` payload), `packages/engine/src/types.ts` (`FullPlanResult`), WP-17 mocks
- Question: §8.3 is marked abridged and differs from the engine in places: runway events there are `{ type, itemId, name, amountCents }`, the engine's are `{ kind, sourceId, occurrenceId, name, owner, amountCents, date, scheduledOn, dueOn, status, isEstimate }`; decisions there carry `impact` and a ready `templateText`, the engine's carry `rank`, `subjectId`, `params` and two template strings (the client fills them through packages/format, so every number stays engine-sourced); `flags` there use `type` and `itemId`, the engine's `code` and `subjectId`. Hard rule 4 and the precedence (engine and DESIGN_SPEC over an abridged example) point to the engine's shape, so `Plan` mirrors `FullPlanResult` field for field and adds `calcSnapshotId`, `cushionCents` and `aiText: null` (reserved for WP-27). `POST /plan/what-if` takes `move_occurrence` and `set_actual_amount` by `occurrenceId` (as in §8.3); the other changes use the engine's fields. The response is `{ before, after, diff }` where `before` and `after` are the plan headline (state, safe to spend, display values, lowest, belowCushionFrom, belowZeroDates, math) and `diff` is the engine's `PlanDiff`. Confirm, or list the fields the WP-17 mocks need to change.
- Options considered: (a) the engine's shape (built; the contract test fails if the engine adds a field the schema lacks); (b) the §8.3 shape with an adapter in the API (a second source of names for the same numbers).
- Blocking: no. WP-17 is built against mocks and needs the shape above to switch to the live API.
- Answer: Answered (tech lead for owner, 2026-11-03): Keep the engine (`FullPlanResult`) shape. BACKEND_PLAN section 8.3 now says its examples are abridged and the contracts are the source of truth.

## Q-076 · WP-11 · Refusals in backfill batches get no fallback
- Asked by: wp-builder/wp/11-ai · 2026-11-03
- Where: BACKEND_PLAN §7.9 (fallbacks, Batch API); `packages/ai/src/sdk-transport.ts`
- Question: The Batches API rejects the `fallbacks` parameter, so a refused request in a 13-month backfill is not rescued by the fallback model. What should the pipeline do with a `refusal` result from a batch?
- Options considered: (a) treat it as "needs review" and move on; (b) re-run only the refused items through the single-call path (which has fallbacks).
- Current behavior (WP-11): batch refusals come back as `status: "refusal"`; the caller (WP-22) decides. No re-run is built.
- Blocking: no.
- Answer: Answered (owner, 2026-11-03): (b). Refused batch items are retried through the single-call path, which has fallbacks. WP-22 does this; `collectExtractionBatch` documents it and leaves the `refusal` outcome as is.

## Q-075 · WP-11 · Is a phishing "pay now" email `irrelevant`, and what is the label policy?
- Asked by: wp-builder/wp/11-ai · 2026-11-03
- Where: BACKEND_PLAN §7.8.2 (doc types), §7.9 (eval corpus: "phishing-style injections")
- Question: The doc types have no "suspicious" value. A fake "account suspended, pay $499" email contains a verbatim amount and date, so evidence validation passes it. I labelled the 6 seed phishing cases `irrelevant`, and the prompt tells the model to extract only a sender's own charge. Is that the intended policy? Evidence validation cannot catch this class: only the prompt and the sender matching in WP-22 (new items always go to review) can.
- Options considered: (a) `irrelevant` (current); (b) add a `suspicious` doc type (schema change, v2).
- Blocking: no. The G3 reviewer should look at the phishing rows in the report.
- Answer: Answered (owner, 2026-11-03): keep `irrelevant` for v1. The G3 report has a Phishing rows section so a reviewer sees them first. Revisit a `suspicious` doc type in schema v2.

## Q-074 · WP-11 · Eval corpus is synthetic and small; who supplies the real-format set?
- Asked by: wp-builder/wp/11-ai · 2026-11-03
- Where: BACKEND_PLAN §7.9 Evals ("300+ real-format emails ... plus pilot emails with consent")
- Question: I have no real emails and no API key, so the committed corpus is 137 template-generated cases and the committed recording is a synthetic oracle built from the labels. The offline report passes trivially and says so in its banner. Who provides the 300+ real-format and consented pilot emails, and who runs the first live eval (`pnpm ai:eval -- --live --record`)? Gate G3 cannot close without both.
- Options considered: grow the synthetic set to 300+ (cheap, still no evidence of model quality); wait for pilot mail.
- Blocking: G3 only.
- Answer: Answered (owner, 2026-11-03): the synthetic set is the regression floor. The owner supplies consented real emails and an API key for G3; they stay outside the repo (`--corpus`). More synthetic variants toward 300 only if cheap (added: yearless-date styles and fence-breakout variants).

## Q-073 · WP-11 · Evidence matching rules the spec leaves open
- Asked by: wp-builder/wp/11-ai · 2026-11-03
- Where: BACKEND_PLAN §7.8.2 validation rules 1–3
- Question: Please confirm the following choices made in `extract/validate.ts`. (1) "Verbatim" ignores differences in whitespace and line wraps only (case and punctuation must match). (2) A date quoted without a year matches when its month and day equal the field and the field's year is within 1 of the received year; the prompt tells the model to pick the nearest upcoming date. (3) The −30/+400 day window applies to all four date fields, not just due and renewal. (4) An amount must equal one of the `$`-prefixed or `n.nn` amounts in the quote; bare integers are not amounts. (5) An `irrelevant` result carrying any amount, date or evidence is sent to review (an addition to the six rules).
- Blocking: no.
- Answer: Answered (owner, 2026-11-03): choices 1-5 approved, tightened by the security review. Yearless dates must equal the single nearest upcoming date (M1). Amounts are `$`-prefixed or a bare `n.nn` right after an amount keyword (M2). `provider_name` and `account_last4` must appear in the source and are length and character checked; `frequency` and `auto_renews` need a quote or are returned as advisory (M3).

## Q-072 · WP-11 · `max_tokens` ~4k with always-on thinking, and the prompt-cache minimum
- Asked by: wp-builder/wp/11-ai · 2026-11-03
- Where: BACKEND_PLAN §7.9 (extract `max_tokens` ~4k, effort `low`, cached system prefix)
- Question: Opus 5.5 cannot disable thinking, and thinking tokens count against `max_tokens`. At effort `low` 4096 is probably enough, but a `max_tokens` stop is handled as `invalid_output` (sent to review). Also, a cached prefix below the model's minimum cacheable length silently does not cache; `extract.v1.md` is about 1,100 tokens. Please confirm both from the first live run: the share of `max_tokens` stops, and `cache_read_input_tokens > 0`. If the prefix is too short, the options are to pad with worked examples (a new prompt version and eval) or accept no caching.
- Blocking: no. Needs the live run.
- Answer: Answered (owner, 2026-11-03): keep `max_tokens` 4096 and omit `thinking`. Decide from the first live run: raise to 8192 if the `max_tokens` stop rate is above 1%. Do not pad the prompt for caching.

## Q-071 · WP-11 · Price table for `ai_runs.cost_micros` and the eval budget cap
- Asked by: wp-builder/wp/11-ai · 2026-11-03
- Where: `packages/ai/src/config.ts` (PRICING); BACKEND_PLAN §5 `ai_runs.cost_micros`
- Question: I used $4 / $20 per million input / output tokens, $0.20 cache read, $5 cache write (1.25x input), and 50% for batch, taken from the model price list available to me. Please confirm they match the contract, and say whether `cost_micros` should be recomputed from the invoice or only estimated.
- Blocking: no.
- Answer: Answered (owner, 2026-11-03): the price table stays a placeholder until the owner checks it against Anthropic's published pricing before G3. `cost_micros` is an estimate; an unknown response model is priced by the requested model and flagged `costEstimated`.

## Q-070 · WP-11 · Plausible amount ceilings per category (validation rule 4)
- Asked by: wp-builder/wp/11-ai · 2026-11-03
- Where: BACKEND_PLAN §7.8.2 rule 4 ("configured ranges, e.g. a subscription < $500/month")
- Question: Only the subscription example is given. I set ceilings in `MAX_AMOUNT_CENTS` (housing $20,000; utilities $1,000; childcare $6,000; transport $5,000; debt $20,000; subscription $500; insurance $10,000; membership $2,000; vehicle/home $20,000; income $50,000; other and unknown $20,000). Please supply the real ranges (and whether there is a floor above $0).
- Blocking: no. Failing items go to review, never auto-apply.
- Answer: Answered (owner, 2026-11-03): the current ceilings stay as placeholders (marked in `validate.ts`); the owner confirms the real ranges before G3.

## Q-068 · WP-19 · How the sandbox worker entry is loaded (tsx) and one Worker per message
- Asked by: wp-builder/wp/19-email-core · 2026-11-03
- Where: BACKEND_PLAN §7.8.2 (parsing sandbox), apps/worker `start` script (`tsx src/index.ts`)
- Question: The repo runs TypeScript directly with tsx, so the sandbox Worker loads `src/mime/worker-entry.ts`. When the parent was not started under tsx (for example Vitest), `sandbox.ts` adds `--import tsx/esm`; a production build that ships `.js` needs no flag but must keep `worker-entry` next to `sandbox`. Each message also pays a Worker start (about 0.3 s, plus about 1 s the first time pdfjs loads). Is one Worker per message acceptable for backfill volumes, or should WP-22 add a small pool that recycles workers (the isolation and `terminate()` behavior stay the same)?
- Blocking: no.
- Answer: …

## Q-067 · WP-19 · Sandboxing PDF parsing
- Asked by: wp-builder/wp/19-email-core · 2026-11-03
- Where: BACKEND_PLAN §7.8.2 (`email.fetch`, pdfjs)
- Question: `pdfToText` runs pdfjs in the worker process with size (5 MB), page (10), output (200k chars) and elapsed-time budgets checked between pages. A malicious PDF can still spin the CPU inside one pdfjs call, because a timer cannot interrupt synchronous work. Should parsing move to a `worker_threads` thread or child process with a hard kill and memory cap?
- Options considered: (a) accept for the pilot (staff and pilot accounts only); (b) run pdfjs in a `worker_threads` Worker with `resourceLimits` and `terminate()` on timeout (small change inside `packages/email/src/pdf`).
- Blocking: no. Recommend (b) before G2 (any real inbox).
- Answer: Answered (owner, 2026-11-03), per b2595c1. Build the sandbox now. Done: `prepareEmail` runs in a `worker_threads` Worker (heap cap, hard timeout, terminate(); `parse_limit` on timeout, out-of-memory or an inflate bomb); more than 200 MIME parts are refused before parsing. See Q-068 for how the worker entry loads.

## Q-066 · WP-19 · Matcher: unknown kind, and fuzzy matching against items with a known domain
- Asked by: wp-builder/wp/19-email-core · 2026-11-03
- Where: BACKEND_PLAN §7.8.2 (`email.match`: provider_domain + account_last4 → provider_domain + kind → fuzzy name)
- Question: The spec does not say (1) what happens when the extraction has no kind and the sender domain matches exactly one item, or (2) whether the fuzzy-name step may match an item whose known provider domain differs from the sender.
- Chosen behavior (conservative): (1) no domain-only step: a null kind falls through to fuzzy; two policies at one provider are never guessed (`ambiguous`, no itemId). (2) Fuzzy never matches an item whose known domain differs from the sender (spoof guard); a stored last 4 that differs from the message's last 4 excludes the item; consumer webmail senders never match by domain. Fuzzy needs Dice similarity ≥ 0.85 and a 0.10 margin over the runner-up.
- Blocking: no. Easy to relax in `packages/email/src/match/match.ts`.
- Answer: Answered (owner, 2026-11-03), per b2595c1. Accept as built.

## Q-065 · WP-19 · Prefilter: use of List-Id, and watched domain vs the promotions label
- Asked by: wp-builder/wp/19-email-core · 2026-11-03
- Where: BACKEND_PLAN §7.8.2 (`email.prefilter`: fetch From, Subject, Date, List-Id)
- Question: §7.8.2 fetches `List-Id` but never says how it is used, and the stop order (ignored / promotions / social first, then watched) means a bill that Gmail files under Promotions from a watched sender is dropped.
- Chosen behavior: follow the order literally; `List-Id` is only a -1 in the keyword score. Keyword weights and threshold 3 are my tuning.
- Blocking: no.
- Answer: Answered (owner, 2026-11-03), per b2595c1. Accept as built.

## Q-064 · WP-19 · Prefilter accuracy gate uses a synthetic corpus
- Asked by: wp-builder/wp/19-email-core · 2026-11-03
- Where: WORK_PLAN WP-19 acceptance ("labeled metadata corpus")
- Question: No labeled corpus exists in the repo. I generated 662 synthetic samples (312 positive) in `packages/email/testing/metadata-corpus.ts` (precision 100%, recall 99.4%, including 2 deliberate misses). These numbers are a regression gate, not a measurement of real inboxes. Who supplies a real, consented, labeled metadata sample (staff test accounts, G2) to validate the threshold?
- Blocking: no for WP-19; yes for trusting the numbers before a pilot.
- Answer: Answered (owner, 2026-11-03), per b2595c1. The synthetic corpus is a regression gate only. A real labeled sample is required before the pilot.

## Q-063 · WP-19 · Fixture has no provider domains or insurance subtypes
- Asked by: wp-builder/wp/19-email-core · 2026-11-03
- Where: `design/fixtures/rivera-household.json` (`renewals`), BACKEND_PLAN §5 (`provider_domain`), §7.8.2 extraction schema (`insurance_type`)
- Question: The matcher keys on provider domain, last 4 and kind, but the fixture renewals have only a provider name, one `policyLast4` (renters, 4821) and no domain or subtype. The matcher tests use fictional domains and subtypes defined in `packages/email/testing/items.ts` (fixture not edited, hard rule 10). Should the fixture gain `providerDomain` and `insuranceType`?
- Blocking: no. WP-22's fixture-inbox acceptance (4 review items, 3 auto-applied) will need them.
- Answer: Answered (owner, 2026-11-03), per b2595c1. Done: `providerDomain` and `insuranceType` are now in the fixture; `packages/email/testing/items.ts` reads them from it.

## Q-062 · WP-19 · Sender authenticity (SPF/DKIM/DMARC) for provider-domain matching
- Asked by: wp-builder/wp/19-email-core · 2026-11-03
- Where: BACKEND_PLAN §7.8.2 (`email.match`, auto-apply policy), ADR-009
- Question: Auto-apply trusts "the match is by provider_domain", but the From header can be forged and forwarded mail carries the forwarder's authentication, not the original sender's. Should a failed or missing `Authentication-Results` block auto-apply (review only)? Not implemented; the matcher only compares the domain it is given, and `prepareEmail` returns `senderDomain` taken from the actual address, not the display name.
- Blocking: no for WP-19; WP-22 needs the answer before `auto_apply` can be enabled.
- Answer: Answered (owner, 2026-11-03), per b2595c1. Auto-apply only with DMARC pass aligned to From, from our own receiver; otherwise review (WP-22 implements). WP-19 carries parsed verdicts only: `prepareEmail(...).authentication` = `{ authservId, dkim, spf, dmarc, dmarcAligned }`, read from the first Authentication-Results header whose authserv-id is in `trustedAuthservIds`. The receiver must strip inbound copies of that header.

## Q-061 · WP-19 · Redaction output format and what "masks card-like numbers" keeps
- Asked by: wp-builder/wp/19-email-core · 2026-11-03
- Where: WORK_PLAN WP-19; BACKEND_PLAN §7.8.2 (`email.redact`), §7.8.2 evidence rule 1
- Question: Long digit runs keep the last 4; the WP says card-like numbers are "masked" without saying whether the last 4 stay. Chosen: Luhn-valid 13-19 digit numbers become `[card ••••1111]`, other 8+ digit runs and keyworded policy/account/member ids become `[acct ••••9012]`, SSNs become `[ssn]` and phones `[phone]` (no digits kept), other-domain emails become `[email]`. Evidence quotes are validated against this redacted text, so WP-22 must quote the masked form. Consumer webmail senders (forwarded mail from a member) keep no addresses. Please confirm the formats.
- Blocking: no.
- Answer: Answered (owner, 2026-11-03), per b2595c1. Masked formats confirmed. Evidence quotes must use the masked form; documented at the top of `packages/email/src/redact/redact.ts` for WP-22.

## Q-060 · WP-19 · Hidden-text coverage and prompt-injection stance
- Asked by: wp-builder/wp/19-email-core · 2026-11-03
- Where: BACKEND_PLAN §7.8.2 (prompt-injection posture)
- Question: HTML hidden text is removed for inline styles (display:none, font-size:0, opacity:0, off-screen, same-colour on the same element, etc.), `hidden`, `aria-hidden`, and common preheader/sr-only class names. White text on a parent's background and CSS from `<style>` blocks are not evaluated. Visible injection text is kept as data and flagged `injection_suspected` (heuristic), and `<email` / `</email` in the body is neutralized so it cannot close the prompt's `<email>` block. Is a heuristic flag acceptable, and should flagged messages always go to review?
- Blocking: no.
- Answer: Answered (owner, 2026-11-03), per b2595c1. Keep the heuristic flag. Flagged messages always go to review and never auto-apply (enforced in WP-22). The hidden-text gaps (white-on-parent, PDF invisible text) are accepted for now. Built since: a `<style>` class-hiding pass for simple `.class` selectors (rules inside `@media` ignored), and `neutralizeDelimiters` now also covers `<email attr>` and full-width forms.

## Q-056 · WP-06 · Skipped or interim items after the G1 fix round (informational)
- Asked by: wp-builder/wp/06-items · 2026-11-03
- Where: BACKEND_PLAN §8.2 (move may require a proposal), §7.3 interim guard, WORK_PLAN WP-06 (cushion change recomputes the plan), WP-13 (tasks)
- Question: None to decide; recorded so nothing is lost. (1) "Move may require a proposal" is the interim 403 `approval_required` guard until WP-13. (2) The fixture `tasks` are not seeded (WP-13 owns the table). (3) A cushion change has nothing to recompute yet: there is no plan endpoint or stored snapshot, and the plan is computed on read, so WP-12 must recompute on its first read after a cushion change (`calcSnapshotId` changes with `inputs_hash`). (3b) Interim guard, as built (403 `approval_required` on the other member's item): delete; change of owner or status; a `schedule` or `weekendRule` change that differs from the stored values (a PATCH that repeats them is a no-op and works); moving an occurrence's due date; skipping an occurrence (marking paid stays allowed); and, for planned expenses, delete, owner change and date move. A member's own items and Both/Split items stay directly editable. (4) The items module takes its database from the shared API runtime, so it has no pool of its own to close; the shared provider and `onClose` of the runtime pool are on WP-12's checklist.
- Options considered: n/a
- Blocking: no.
- Answer:

## Q-055 · WP-06 · Retention purge of soft-deleted rows (G1 L-4)
- Asked by: wp-builder/wp/06-items · 2026-11-03
- Where: BACKEND_PLAN §5.1 (soft delete), §7.11 (retention)
- Question: Soft-deleted `recurring_items` (and their occurrences and history) are kept for undo, but nothing deletes them for good. The security review asks for a purge after the retention window.
- Options considered: a `retention.purge` job in WP-24 that hard-deletes items soft-deleted more than N days ago (app roles have no DELETE on `recurring_items` by design, so it needs its own definer function).
- Blocking: no. Not built in WP-06.
- Answer: Answered (owner, 2026-11-03), spec in 6c8bb8e. Goes to WP-24; not built in WP-06.

## Q-054 · WP-06 · Which engine fields do `item_amount_history` rows feed, and how do multiple sources map?
- Asked by: wp-builder/wp/06-items · 2026-10-28
- Where: BACKEND_PLAN §5.2 (`recurring_items.source` is one value; `item_amount_history.source`); engine `ItemInput.sources` (`email+csv`); fixture `source` and `expected.renewals.foundAutomatically`
- Question: The fixture says `email+csv` for car insurance, but `recurring_items.source` holds one value. The seed stores the first source (`email`) on the item and an extra `item_amount_history` row with the other source (`csv`) at the last occurrence date, so WP-12 can rebuild `sources` as the item source plus the history sources. Is that the intended mapping?
- Options considered: (a) as seeded; (b) `sources text[]` on `recurring_items`; (c) drop multi-source and count only the primary.
- Blocking: no. WP-12 builds the engine input; `foundAutomatically` (16) needs the mapping.
- Answer: Answered (owner, 2026-11-03), spec in 6c8bb8e. Accepted as built: the item holds the first source, and extra `item_amount_history` rows carry the others.

## Q-053 · WP-06 · Does a schedule change keep a user's move or actual amount on a future occurrence?
- Asked by: wp-builder/wp/06-items · 2026-10-28
- Where: BACKEND_PLAN §7.1 ("future `scheduled` occurrences are deleted and rebuilt"); WORK_PLAN WP-06 acceptance
- Question: Implemented literally: a rebuild deletes every future `scheduled` row, including one the household moved ("pay on Nov 6 instead") or gave an actual amount. A paid, received or skipped row is never touched. Should a rebuild keep the move or actual amount when the scheduled date still exists in the new schedule? Rebuilds run only when the rule, start, end, weekend rule or status changes, not on an amount or name edit.
- Options considered: (a) literal, as built; (b) keep rows whose `scheduled_on` is still in the new set and that carry `moved_by` or an actual amount.
- Blocking: no.
- Answer: Answered (owner, 2026-11-03), spec in 6c8bb8e. Option (b): a rebuild keeps future `scheduled` rows whose `scheduled_on` is still in the new set and that carry `moved_by` or an actual amount; a kept row that was not moved takes the new weekend-rule date. Built and tested in WP-06 (G1 fix round).

## Q-052 · WP-06 · Where is a renewal's renewal date stored?
- Asked by: wp-builder/wp/06-items · 2026-10-28
- Where: BACKEND_PLAN §5.2 `renewal_details` (has `coverage_start`, `coverage_end`, `cancel_by`, `decision_by`, no `renews_on`); engine `RenewalInput.renewsOn`
- Question: The engine needs `renewsOn`, the schema has no such column. The seed stores it in `coverage_end` (the term end is the renewal date), and the item's schedule starts on it (`dtstart`). For health insurance paid monthly from payroll the item recurs monthly but the plan-year renewal (2027-01-01) is `coverage_end`. Is `coverage_end` right, or should WP-12 derive it from the next occurrence?
- Options considered: (a) `coverage_end` (as seeded); (b) next item occurrence (wrong for the payroll health plan); (c) add a `renews_on` column.
- Blocking: no.
- Answer: Answered (owner, 2026-11-03), spec in 6c8bb8e. Keep `coverage_end` as the renewal date; the column now has a comment saying so.

## Q-051 · WP-06 · The nightly `occurrences.materialize` fan-out cannot list households
- Asked by: wp-builder/wp/06-items · 2026-10-28
- Where: BACKEND_PLAN §9 (nightly 02:00 UTC), §5.3 (`mp_worker` is scoped to one household); `households_worker_access` policy; pg-boss is not yet in `apps/worker`
- Question: The job body (`apps/worker/src/jobs/occurrences/materialize.ts`) handles one household. The nightly trigger must enqueue one job per household, but no app role can read all households. Which role or function enumerates them (a `SECURITY DEFINER` `app_list_household_ids()` for `mp_worker`, which also needs a G1-style sign-off; or a scheduler role)? Queue registration is also left out until the worker has pg-boss.
- Options considered: (a) a definer function returning household ids for `mp_worker`; (b) a separate scheduler role; (c) enqueue lazily on first request per household.
- Blocking: no. Item-change rebuilds already run synchronously in the API transaction.
- Answer: Answered (owner, 2026-11-03), spec in 6c8bb8e. `app_list_household_ids()` (SECURITY DEFINER, ids only, pinned search_path, EXECUTE for mp_worker only) is in the WP-06 migration with RLS and coverage tests. pg-boss registration and the nightly fan-out stay with WP-12.

## Q-050 · WP-06 · Who owns the `goals` table?
- Asked by: wp-builder/wp/06-items · 2026-10-28
- Where: WORK_PLAN WP-06 acceptance (`goals.is_emergency_fund` exists) vs WP-13 (goals module and migrations); BACKEND_PLAN §5.2
- Question: WP-06 must have `goals.is_emergency_fund` and seed the fixture goals, and `planned_expenses.goal_id` references `goals`, so the `goals` table is created in the WP-06 migration (with RLS and tests), without `goal_events`, proposals or any goals API. WP-13 then owns only routes, goal_events and proposals. Confirm, or move the table to a WP-13 migration that WP-06 depends on?
- Options considered: (a) WP-06 creates `goals` (as built); (b) WP-13 first.
- Blocking: no.
- Answer: Answered (owner, 2026-11-03), spec in 6c8bb8e. WP-06 owns the `goals` table; mp_api has SELECT only. The seed and the RLS tests insert goals as mp_worker (a minimal INSERT grant, needed because the RLS suite and the seed have no other role that may write; mp_api gets no write access until WP-13 adds the proposal gate).
## Q-049 · WP-10 · CalendarCell: the spec's aria-label vs WCAG 2.5.3 Label in Name
- Asked by: wp-builder/wp/10-ui-kit · 2026-10-28
- Where: DESIGN_SPEC §4.2 ("The aria-label reads “November 4, 1 item”"); WCAG 2.2 SC 2.5.3
- Question: A cell's visible text is the day number plus its event chips ("4 Car insurance −$684"), but the spec's accessible name "November 4, 1 item" doesn't contain it, so axe `label-content-name-mismatch` fails in the browser run. Keep the spec label, or name the cell with its visible text too?
- Options considered: (a) keep the spec label and exempt only that rule for the Calendar stories in `visual/a11y.spec.ts` (implemented); (b) "November 4, 1 item: Car insurance −$684" built from the chips, which a screen-reader user hears in full; (c) hide the chips from the name with a separate description (`aria-describedby`).
- Blocking: no.
- Answer: (c) Name the cell from its visible content plus visually hidden words (“November 4, payday, Car insurance −$684”), with the item count in `aria-describedby`. Remove the axe exemption. DESIGN_SPEC §4.2 updated. (owner, 2026-10-28)

## Q-048 · WP-10 · Attention tokens used for errors (§1 rule 4 vs §5.3 and §4)
- Asked by: wp-builder/wp/10-ui-kit · 2026-10-28
- Where: DESIGN_SPEC §1 rule 4 ("amber means needs a decision and nothing else… not for errors"); §5.3 (error = an attention card); §4 (input error border `attention.text`)
- Question: The error banner and invalid input borders use `attention.*` while rule 4 forbids it for errors. Which wins?
- Options considered: keep §5.3 and §4 as written (implemented, matching the canvas error banner); add dedicated error tokens.
- Blocking: no. Left unchanged.
- Answer: Keep §5.3 and §4 as drawn: errors use the attention tokens. §1 rule 4 reworded to allow errors. (owner, 2026-10-28)

## Q-047 · WP-10 · Switch knob shadow
- Asked by: wp-builder/wp/10-ui-kit · 2026-10-28
- Where: DESIGN_SPEC §2.3 (shadows only on selected segments and overlays) vs canvas switch
- Question: The knob carries `shadow.selected` in code; §2.3 says the UI is flat apart from the selected segment and overlays. Does the canvas knob have a shadow?
- Options considered: keep `shadow.selected` on the knob (implemented); remove it.
- Blocking: no. Left unchanged.
- Answer: Keep `shadow.selected` on the knob; §2.3 and the Switch row updated. (owner, 2026-10-28)

## Q-046 · WP-10 · ErrorBanner padding and radius
- Asked by: wp-builder/wp/10-ui-kit · 2026-10-28
- Where: DESIGN_SPEC §5.3 (error = an attention card) and §4 (attention card: radius xl, padding 14); canvas "Design specification" error row
- Question: The canvas error banner is drawn with its own padding and radius that may differ from the attention card (xl, 14). Which values should `ErrorBanner` use?
- Options considered: the attention card values (implemented); the canvas row's values.
- Blocking: no. Left unchanged.
- Answer: The canvas wins: padding 12×14, radius lg. DESIGN_SPEC §5.3 updated. (owner, 2026-10-28)

## Q-045 · WP-10 · IconButton color and glyph size
- Asked by: wp-builder/wp/10-ui-kit · 2026-10-28
- Where: DESIGN_SPEC §2.4 and §4 (icon 20, `text.primary`) vs the canvas header buttons (`text.secondary`, 18)
- Question: Canvas and spec differ on the icon button glyph color and size. Which wins?
- Options considered: the spec, `text.primary` at 20 (implemented); the canvas, `text.secondary` at 18.
- Blocking: no. Left unchanged.
- Answer: The canvas wins: web icon buttons use `text.secondary` at 18. DESIGN_SPEC §2.4 updated. (owner, 2026-10-28)

## Q-044 · WP-10 · CalendarCell aria-label adds ", payday"
- Asked by: wp-builder/wp/10-ui-kit · 2026-10-28
- Where: DESIGN_SPEC §4.2 (aria-label "November 4, 1 item")
- Question: Paydays are marked by the visible "PAYDAY" label, and the spec label has no equivalent, so the label is "November 6, payday, 1 item". Keep the suffix?
- Options considered: keep (implemented; it is the accessible name for the visible PAYDAY); drop it.
- Proposed answer: keep.
- Blocking: no.
- Answer: Keep “payday” in the name; it now comes from visually hidden text (see Q-049). (owner, 2026-10-28)

## Q-043 · WP-10 · Runway chart: how much space below $0, and the lowest-bar tooltip when it is negative
- Asked by: wp-builder/wp/10-ui-kit · 2026-10-27
- Where: DESIGN_SPEC §4.1 (negative balances); canvas board "Web · Safe-to-spend states"
- Question: (1) "Reserve space below it scaled the same way as above it" doesn't say how deep that space is. (2) §4.1 gives the single lowest bar a "Lowest · $X" tooltip, but the shortfall board draws none on the −$293 bar.
- Options considered: (1a) the lowest balance rounded down to the next −$1,000, mirroring the top rule (implemented; −$293 → −$1,000, which matches the board's proportions); (1b) exactly the lowest balance. (2a) keep the tooltip ("Lowest · −$293", implemented); (2b) drop it for negative bars.
- Blocking: no. `runwayScale` and the fixture snapshots in `packages/ui/src/components/runway-chart/` encode (1a) and (2a).
- Answer: Answered (owner, 2026-10-28). Below $0, round the lowest balance down to the next −$1,000, mirroring the top rule. A negative lowest bar keeps its "Lowest · −$293" tooltip, placed under the negative value so it doesn't overlap the $500 dashed cushion line. Implemented in `RunwayChart`.

## Q-042 · WP-10 · Canvas and spec differ on three small visual details
- Asked by: wp-builder/wp/10-ui-kit · 2026-10-27
- Where: DESIGN_SPEC §4, §4.1, §4.2; canvas boards "Web · Overview", "Web · Calendar", "Design specification v1.1"
- Question: (1) The calendar "PAYDAY" label is 10/700 and the shortfall runway uses 10 px labels, but there is no 10 px type token. (2) The runway legend's cushion swatch is `attention.text` on the canvas, while §4.1 draws the cushion line in `chart.cushion` and §1 rule 4 reserves amber for decisions. (3) The web hero label is 14/500 on the canvas and 13/500 in §4.
- Options considered: (1) add a `nano` 10 px token, or use `micro` 11 px (implemented). (2) `chart.cushion` for both line and swatch (implemented) or follow the canvas. (3) 13/500 per §4 (implemented) or 14/500.
- Blocking: no. Each is one CSS line in `packages/ui/src/components/`.
- Answer: Answered (owner, 2026-10-28). PAYDAY uses `--mp-type-nano`; the cushion legend swatch uses `chart.cushion`; the hero label is 14/500 (`--mp-type-body`, weight 500). Implemented.

## Q-041 · WP-10 · Date and amount forms the UI kit needs that @mp/format doesn't offer
- Asked by: wp-builder/wp/10-ui-kit · 2026-10-27
- Where: DESIGN_SPEC §4.1 ("Rent −2,150"), §4.2 (aria-label "November 4, 1 item"), §4 list row (weekday over day); `packages/format`
- Question: Three forms have no `@mp/format` function: (a) the runway event amount without "$" ("−2,150", "+2,900", "~−142"); (b) the long month for screen-reader labels ("November 4"); (c) the short weekday alone ("Wed"). Should WP-04's package add them?
- Options considered: implemented locally for now on top of `@mp/format`: (a) `money(c, { mode: "chip" })` with the "$" removed; (b) a month-name table in `components/internal/dates.ts`; (c) the weekday part of `date(d, { weekday: true })`. Moving them into `@mp/format` later is a small change.
- Blocking: no.
- Answer: Answered (owner, 2026-10-28). Add to `packages/format` with tests and delete the local helpers: `money(c, { mode: "chart", estimate })`, `date(d, { month: "long" })` and `weekday(d)`. Implemented; `internal/dates.ts` is gone.

## Q-040 · WP-10 · Stylelint "no raw px": which properties, and spec values with no token
- Asked by: wp-builder/wp/10-ui-kit · 2026-10-27
- Where: WORK_PLAN WP-10 ("no hex or raw px outside the token files"); ARCHITECTURE §8; DESIGN_SPEC §2.3–§4
- Question: DESIGN_SPEC §4 gives many component dimensions in px with no token (switch track 52×32, calendar cell min-height 112, runway plot 230, 1 px and 2 px borders), plus a few off-scale values (chip and segment-track padding 3, badge padding 1, mini-runway radius 3). A literal "no px anywhere" rule can't express them.
- Options considered: implemented in `packages/ui/stylelint.config.mjs`: no hex, named or functional colors anywhere; no px/rem for font, line-height, letter-spacing, padding, margin, gap, radius or shadow (tokens only); px allowed for width, height, border and outline sizes. The off-scale values, and two "border grows 1 → 2 px" padding compensations, use `stylelint-disable-next-line` with a DESIGN_SPEC citation, and a disable without a reason fails the lint. Alternatives: add 1 px and 3 px spacing tokens and a 3 px radius token, or component-size tokens for the §4 dimensions.
- Blocking: no.
- Answer: Answered (owner, 2026-10-28). Keep the split: tokens are required for color, type, spacing, radius and shadow; px is allowed for component dimensions and border/outline widths. Off-scale paddings keep their cited disable comments for now. Rules tightened and the config moved to the repo root (`stylelint.config.mjs`).

## Q-087 · WP-05 · Notify the creator when a partner accepts an invite
- Asked by: wp-builder/wp/05-auth · 2026-11-03
- Where: BACKEND_PLAN §6 (Invites, step 3)
- Question: Accepting should create a notification for the creator, but the `notifications` table and `packages/notify` do not exist yet.
- Options considered: (a) add the notification in the notify WP; (b) a placeholder table now.
- Blocking: no. Skipped; the membership and the `invite.accepted` audit event (from `app_accept_invite`) are done. The notify WP should hook `invite.accepted`.
- Answer: Answered (owner, 2026-11-03), spec in e50f29e. Deferred to WP-15 (on its checklist).

## Q-086 · WP-05 · Household PATCH: primary income item
- Asked by: wp-builder/wp/05-auth · 2026-11-03
- Where: BACKEND_PLAN §8.2 (PATCH household: cushion and primary income)
- Question: `primaryIncomeItemId` needs `recurring_items` (WP-06) to validate that the item belongs to the household and is income. Until then PATCH accepts name, timezone and cushionCents only (a `primaryIncomeItemId` field is a 400).
- Options considered: (a) WP-06 adds the field and the check to PATCH; (b) WP-05 accepts any uuid (unsafe: cross-household reference).
- Blocking: no. Skipped until WP-06 lands. Also: the plan recompute on cushion change has no target yet (no plan endpoint).
- Answer: Answered (owner, 2026-11-03), spec in e50f29e. Deferred to WP-06 (on its checklist).

## Q-085 · WP-05 · Can one user belong to several households?
- Asked by: wp-builder/wp/05-auth · 2026-11-03
- Where: BACKEND_PLAN §6, §5.2
- Question: Nothing forbids a user creating or joining a second household, and `/me` returns a list of memberships. Should the MVP allow only one active household per user?
- Options considered: (a) allow many (current behaviour, no rule invented); (b) one active household: 409 on create/accept.
- Blocking: no. Current behaviour is (a).
- Answer: Answered (owner, 2026-11-03), spec in e50f29e. One active household per user, enforced by a partial unique index on active memberships (`household_members_one_active_uq`, in the WP-05 migration). Create or accept into a second household returns 409 `conflict`.

## Q-084 · WP-05 · PATCH /me concurrency
- Asked by: wp-builder/wp/05-auth · 2026-11-03
- Where: BACKEND_PLAN §8.1 (PATCH requires If-Match), §8.2
- Question: `users` has no `version` column, so `PATCH /me` cannot use If-Match. Only the user edits their own profile.
- Options considered: (a) last write wins, no If-Match (current); (b) add `users.version` in a migration and require If-Match.
- Blocking: no. Current behaviour is (a).
- Answer: Answered (owner, 2026-11-03), spec in e50f29e. `PATCH /me` is last-write-wins; documented as a BACKEND_PLAN §8.1 exception.

## Q-083 · WP-05 · Same email, two sign-in identities (password + Google)
- Asked by: wp-builder/wp/05-auth · 2026-11-03
- Where: ADR-017, BACKEND_PLAN §5.2 (`users.email` unique)
- Question: Cognito creates a separate `sub` for Google federation and for password sign-up with the same email. Bootstrap for the second `sub` hits the unique email and returns 409 `conflict` (and so does an email sync that would collide). Should the pools link accounts?
- Options considered: (a) link federated and native users in the pool (pre-sign-up trigger, WP-09) so one `sub` exists per email; (b) allow several `auth_subject`s per user.
- Blocking: no. Current behaviour: 409, no data changed.
- Answer: Answered (owner, 2026-11-03), spec in e50f29e. Keep 409.

## Q-082 · WP-05 · Name for a new user
- Asked by: wp-builder/wp/05-auth · 2026-11-03
- Where: ADR-017, BACKEND_PLAN §6
- Question: `users.first_name` is NOT NULL but the access token carries no trusted name claim. Bootstrap therefore requires `firstName` in the body the first time (the email is never read from the body).
- Options considered: (a) body `firstName` (current); (b) add a `given_name` claim in the pre-token-generation trigger and read it from the token.
- Blocking: no.
- Answer: Answered (owner, 2026-11-03), spec in e50f29e. The first name comes from the body, first call only. It is untrusted display text (escaped by the invite sender).

## Q-081 · WP-05 · Invite email delivery
- Asked by: wp-builder/wp/05-auth · 2026-11-03
- Where: BACKEND_PLAN §6 (Invites, step 1)
- Question: `POST /households/:hid/invites` must email a link, but delivery is `packages/notify` (not in WP-05's paths). WP-05 defines an `InviteSender` port, calls it after the invite commits, and cancels the invite if it throws (502). `apps/api/src/index.ts` wires a stub that sends nothing, so invites cannot be delivered in a running stack. The web app's accept route (`/invite?token=`) is also undecided.
- Options considered: (a) notify WP supplies the sender and link format; (b) WP-05 adds SMTP now.
- Blocking: yes for end-to-end delivery only. Tests use a capturing sender.
- Answer: Answered (owner, 2026-11-03), spec in e50f29e. Keep the `InviteSender` port. In production with no real sender wired, invite creation fails (the invite is cancelled), it does not return 201. WP-15 supplies the sender. Built: `createUnconfiguredInviteSender` in `apps/api/src/auth/runtime.ts`.

## Q-080 · WP-05 · Problem codes for invite failures
- Asked by: wp-builder/wp/05-auth · 2026-11-03
- Where: WORK_PLAN WP-05 acceptance, BACKEND_PLAN §8.1 (code list), §6 (403 with hint)
- Question: The code list has no invite-specific codes. Current mapping: unknown token 404 `not_found`; expired, revoked, already used, household full or being deleted, already a member: 409 `conflict` (the `detail` text says which); email mismatch: 403 `forbidden` with the masked address (from `app_invite_lookup`). Clients cannot branch on expired vs revoked without reading text.
- Options considered: (a) keep (current); (b) add codes `invite_expired`, `invite_revoked`, `invite_mismatch` (WP-08 owns the list); (c) 410 for expired/revoked.
- Blocking: no.
- Answer: Answered (owner, 2026-11-03), spec in e50f29e. Keep 404 / 409 / 403 with the masked hint.

## Q-032 · WP-08 · Webhook paths: `/webhooks/*` or `/v1/webhooks/*`?
- Asked by: wp-builder/wp/08-api-platform · 2026-10-27
- Where: BACKEND_PLAN §8.1 (base URL `/v1`), §8.4 (paths `/webhooks/clerk` …)
- Question: §8.1 puts the API under `/v1`, but §8.4 lists webhook paths without it. Which is canonical? The URL is registered with Clerk, Google Pub/Sub, SNS and the billing provider, so it is costly to change later.
- Options considered: (a) `/webhooks/*` at the root, unversioned (providers call a fixed URL); (b) `/v1/webhooks/*`.
- Current behavior (WP-08): modules mount at `/v1` by default and may set their own `prefix`, so either works. No webhook routes exist yet.
- Blocking: no. The webhooks module (WP-05 for Clerk, WP-19+ for the rest) needs the answer.
- Answer: Option (a). `/webhooks/*` stays at the root, unversioned. (owner, 2026-10-27) WP-08 exports `WEBHOOKS_PREFIX` and hides those routes from the public OpenAPI document.

## Q-031 · WP-08 · Shared store for rate limits (daily Ask and export limits)
- Asked by: wp-builder/wp/08-api-platform · 2026-10-27
- Where: BACKEND_PLAN §8.1 (rate limits), §3 (no Redis in the stack), ARCHITECTURE §6 (more than one API task)
- Question: Limits are per user, but the counters live in each API process (`@fastify/rate-limit` in-memory store). With N ECS tasks, a user gets up to N× the limit, and a deploy resets the daily Ask (30/day) and export (3/day) counters. Which shared store should back them?
- Options considered: (a) a Postgres-backed store (a small `rate_limit_counters` table, unlogged, outside RLS); (b) ElastiCache Redis (new infra); (c) keep per-minute limits in memory and enforce the daily Ask/export limits in their services from `ai_runs` / `data_requests` counts.
- Current behavior (WP-08): in-memory store with a TODO in `apps/api/src/plugins/rate-limit.ts`; presets in `RATE_LIMITS`.
- Blocking: no.
- Answer: Option (c). Per-minute limits stay in memory per instance. Ask 30/day and exports 3/day are not enforced by the platform limiter; their services count today's `ai_runs` / `data_requests` rows (WP-28, WP-24). BACKEND_PLAN §8.1 updated in c235112. (owner, 2026-10-27) WP-08 removed the daily presets and left TODOs in `apps/api/src/plugins/rate-limit.ts`.

## Q-030 · WP-08 · Error codes, statuses and problem `type` beyond §8.1
- Asked by: wp-builder/wp/08-api-platform · 2026-10-27
- Where: BACKEND_PLAN §8.1 (Errors, Writes, Optimistic concurrency); `packages/contracts/src/errors`
- Question: §8.1 says the codes "include" seven names. The platform needs a few more, and some statuses and the `type` URI are not specified. Please confirm or correct:
  1. Extra codes: `unauthorized` (401), `idempotency_key_reused` (422, same key with a different request), `precondition_required` (428, PATCH without `If-Match`), `payload_too_large` (413), `unsupported_media_type` (415), `bad_request` (other 4xx), `internal_error` (500).
  2. Statuses: `entitlement_required` and `mfa_required` default to 403 (alternatives: 402 for entitlement, 401 for step-up).
  3. Problem `type` is the relative URI `/problems/<code>` because the product domain is undecided (§17). Should it become an absolute docs URL later?
  4. Validation errors carry `fields: [{ in: "body"|"querystring"|"params"|"headers", path: "a.b", message }]`.
  5. A repeated key while the first request is still running returns 409 `conflict`. Only successful (< 400) responses are stored; errors (4xx and 5xx) release the key, so a client can fix the cause (for example complete step-up MFA) and retry with the same key.
- Options considered: as listed; each is one constant in `packages/contracts/src/errors/index.ts`.
- Blocking: no. Implemented as listed and covered by `apps/api/src/plugins/errors.test.ts`.
- Answer: Accepted as built. `entitlement_required` and `mfa_required` return 403; problem `type` is the relative `/problems/<code>`; the `fields` shape is fine. BACKEND_PLAN §8.1 updated in c235112. (owner, 2026-10-27)

## Q-021 · WP-07 · Split items in a partner's filter (informational)
- Asked by: wp-builder/wp/07-engine-rules · 2026-10-28
- Where: DESIGN_SPEC §6 rule 13 ("a partner's filter includes their own items plus items owned by Both"); `packages/engine/src/rules/owners.ts`
- Question: Rule 13 names Both only. The engine also includes `split` items (Split = 50/50, both partners get reminders, mobile Bill detail) in each partner's filter. Confirm?
- Options considered: include split (implemented); or own and Both only.
- Blocking: no.
- Proposed answer: yes, include split.
- Answer: Yes, include split. DESIGN_SPEC §6 rule 13 updated. (owner, 2026-10-28)

## Q-020 · WP-07 · How do renewal-only items map to items (WP-06, WP-12)?
- Asked by: wp-builder/wp/07-engine-rules · 2026-10-28
- Where: BACKEND_PLAN §5.2 (`renewal_details` is 1:1 with `recurring_items`), §7.5; fixture `renewals` (9 rows) vs `bills`; `expected.billsPage` (18 rows, $4,956.94 a month) and `expected.renewals` (16 items)
- Question: In production every renewal is a recurring item, but the fixture's renewals r-health, r-renters, r-moto, r-life, r-av, r-shop, r-club and r-reg have no matching `bills` entry (only r-car matches b-carins). `billsAverages` must stay at 18 rows and $4,956.94, which excludes them. So when they exist as items, how should WP-06 and WP-12 treat them for bill averages and the runway? The loader links r-car to b-carins only; the other renewals stay renewal-only input (`RenewalInput.itemId` null). `renewalList` skips a subscription item that a renewal links to, so the count of 16 holds either way.
- Options considered: (a) renewal-only items are items too, but carry a marker (e.g. `paid_from = payroll` for health, or a flag) so averages and the runway skip them; (b) they are items and are included in averages and the runway (the golden values would change; needs a fixture decision); (c) renewals can exist without an item, contradicting §5.2.
- Blocking: no. Nothing was skipped; this decides how WP-06 builds the engine input.
- Answer: (a) for the bills page, but not for the runway. Every renewal is a recurring item. Items that exist only as renewals carry `recurring_items.on_bills_page = false`, so the Bills & recurring page and `billsAverages` skip them (18 rows, $4,956.94 hold). They still count in the runway like any outflow paid from the account; payroll-paid items (health) stay out through `paid_from = payroll`. BACKEND_PLAN §5.2 and DESIGN_SPEC §6 rule 17 updated; WP-06 maps the marker and the engine honours it. (owner, 2026-10-28)

## Q-019 · WP-07 · Which expense "caused the shortfall" (shortfall option 2)?
- Asked by: wp-builder/wp/07-engine-rules · 2026-10-28
- Where: DESIGN_SPEC §5.3 option 2 ("Split the expense that caused the shortfall into two halves"); `packages/engine/src/rules/shortfall.ts`
- Question: The spec doesn't say how the cause is chosen. Implemented heuristic: the largest planned expense dated from today through the lowest day (ties: earliest, then id); halves are floor(amount ÷ 2) now and the rest the day after payday. Bills are not considered, only planned expenses. In the fixture this is the $1,800 car repair. Is this right, and should bills count as a cause (e.g. the largest outflow of any kind before the lowest day, which in the fixture would be rent, not the repair)?
- Options considered: (a) planned expenses only (implemented); (b) the largest planned expense or bill; (c) the expense whose removal brings safe to spend closest to 0.
- Blocking: no. Golden values pass under (a).
- Answer: (a) The largest planned expense from today through the lowest day; regular bills are never the cause. DESIGN_SPEC §5.3 option 2 updated. (owner, 2026-10-28)

## Q-018 · WP-07 · "Safe to spend is now $998" vs rule 4 flooring
- Asked by: wp-builder/wp/07-engine-rules · 2026-10-27
- Where: DESIGN_SPEC §5.1 Email & imports golden values; §6 rule 4; §7 Money in hero ("money you can spend rounds down"); fixture `expected.safeToSpendAfterElectricityActual15137Cents` (99764)
- Question: After confirming electricity at $151.37, safe to spend is $997.64. Rule 4 and §7 floor it to "$997", but the Email & imports golden value says "Safe to spend is now $998". Which is right?
- Options considered: (a) floor everywhere ("$997"; the §5.1 string changes); (b) round to the nearest dollar in that confirmation sentence only.
- Blocking: no. The engine returns 99764 cents and the floored display value 99700, as rule 4 says; the test asserts the cents value only.
- Answer: Answered (owner, 2026-10-28; spec commit a535a33): $997, flooring everywhere. DESIGN_SPEC §5.1 is fixed. `golden-rules.test.ts` asserts the display value "$997" for the $151.37 case.

## Q-017 · WP-07 · "Decide this week": which cards, and in what order?
- Asked by: wp-builder/wp/07-engine-rules · 2026-10-27
- Where: DESIGN_SPEC §5.1 Overview region 4; BACKEND_PLAN §7.2 `decisions` ("ranked"); canvas Overview board (3 cards: car insurance, electricity estimate, Lake Tahoe)
- Question: The spec doesn't define what becomes a decision or how they rank. Implemented: shortfall first, then not-in-usual-month bills in the window (with rule 9's "pay on payday" value when it changes safe to spend), estimates due before payday, decide-by deadlines within 7 days (rule 15's "this week"), then savings goals that are behind; ties by date, then id. Price-up and possible-duplicate flags are not decisions (the canvas shows them as the task "Review 2 flagged subscriptions"). This gives exactly the canvas's 3 cards for the fixture. Is this the intended ranking and scope?
- Options considered: as implemented; or include every rule 8 flag as a decision (6+ cards, the count chip would no longer read "3 items").
- Blocking: no.
- Answer: Answered (owner, 2026-10-28; spec commit a535a33): accepted as built; now DESIGN_SPEC §6 rule 19. Note from the WP-07 fix round: the calendar chips (`calendarMonth`) still show price-up and possible-duplicate bills as "Needs a decision" chips, because the canvas Web · Calendar board draws Streaming (Nov 2) and Music second service (Nov 21) that way. Rule 19 only governs the Overview cards. Confirmed: the canvas wins on the calendar; rule 19 now says so. (owner, 2026-10-28)

## Q-016 · WP-07 · Which bills "could be moved" to payday (shortfall option 3)?
- Asked by: wp-builder/wp/07-engine-rules · 2026-10-27
- Where: DESIGN_SPEC §5.3 option 3 ("the largest bill in the window that could be moved to payday"); fixture `scenarios.shortfall.expected.options[2]` (car insurance, not rent or daycare)
- Question: Rent ($2,150) and daycare ($1,240) are larger than car insurance ($684) and in the window, yet the golden option moves car insurance. Nothing in the spec or fixture says which bills are movable. Implemented: an optional `ItemInput.movable`; when absent it defaults to true for subscription, insurance, membership, registration and other items, and false for bill, loan and income items (hard due dates, late fees). Among movable bills due before payday, the largest whose move changes safe to spend wins (ties: earliest, then id). Should movability be a stored field on `recurring_items` (and in the fixture), or is the kind-based default acceptable?
- Options considered: (a) kind-based default plus override (implemented); (b) a `movable`/`grace_period` column set by the user or from email; (c) only infrequent (not-in-usual-month) bills are movable.
- Blocking: no. Golden values pass under (a).
- Answer: Answered (owner, 2026-10-28; spec commit a535a33): kind-based default plus the optional per-item `movable` override, as built; now DESIGN_SPEC §6 rule 18, and BACKEND_PLAN has `recurring_items.movable`.

## Q-015 · WP-07 · Does a cancel-by date raise "Decide by"?
- Asked by: wp-builder/wp/07-engine-rules · 2026-10-27
- Where: DESIGN_SPEC §6 rule 8 ("Decide by: an email gives a deadline (enrollment, cancel-by)"); WORK_PLAN WP-07 acceptance ("decide by", listed once); fixture `renewals` r-health (`decisionBy` Nov 13) and r-av (`cancelBy` Nov 30)
- Question: Rule 8 says cancel-by deadlines raise "Decide by", so the antivirus renewal flags too (the canvas shows it as "Cancel by Nov 30?"). That gives 2 decide-by flags, while the WP acceptance lists "decide by" without "×2". Implemented per rule 8: both flag, each dated by its earliest upcoming deadline. Should a cancel-by deadline be a separate code (e.g. `cancel_by`), or limited to a horizon (e.g. 30 days, which would leave only health)?
- Options considered: (a) both raise `decide_by` (implemented); (b) a separate `cancel_by` code; (c) a 30-day horizon.
- Blocking: no. The flags test asserts health and antivirus explicitly.
- Answer: Answered (owner, 2026-10-28; spec commit a535a33): (a). Both raise `decide_by`. The flag carries `deadlineKind` ("decision" or "cancel") so the copy can read "Decide by Nov 13" or "Cancel by Nov 30?". DESIGN_SPEC §6 rule 8 says this.

## Q-014 · WP-07 · Data the rules need that the fixture doesn't carry
- Asked by: wp-builder/wp/07-engine-rules · 2026-10-27
- Where: `design/fixtures/rivera-household.json`; canvas boards Web · Bills & recurring, Renewals, Household tasks, Safe-to-spend states
- Question: Several golden values depend on data only the canvas has. The test loader (`packages/engine/src/testing/`) fills them from the canvas, without editing the fixture: (1) `source` for incomes and bills ("Found in" column) for `renewals.foundAutomatically` = 16; (2) a sub-category for the two music subscriptions (possible duplicate); (3) which goal is the emergency fund (shortfall option 1); (4) the task list behind `expected.tasks` (3 / 4 / 3, badge 3), with task t2's due hint read as due Nov 1. Should these be added to the fixture (and `goals` get an emergency-fund marker in BACKEND_PLAN §5.2)?
- Options considered: add them to the fixture and schema; or keep the canvas-derived constants in the test loader (current).
- Blocking: no. All golden values pass with the loader constants.
- Answer: Answered (owner, 2026-10-28; spec commit a535a33): the data is now in the fixture (`source`, `subcategory`, `emergencyFund`, top-level `tasks` with t2 `dueOn` and `dueHint`). The test loader reads it from there; the canvas-derived constants are gone.

## Q-013 · WP-03 · Masked-email hint for a mismatched invite vs. invites RLS
- Asked by: wp-builder/wp/03-db-foundation · 2026-10-27
- Where: BACKEND_PLAN §6 (Invites, step 2); WORK_PLAN WP-05 acceptance
- Question: `POST /invites/accept` must answer a signed-in user whose email does not match with 403 and a "sign in with {masked email}" hint. Under the WP-03 policies, a non-member sees only unaccepted invites addressed to their own email, so mp_api cannot read a mismatched invite at all. How should the API find it?
- Options considered: (a) a `app.invite_token_hash` session variable plus a policy `token_hash = app_invite_token_hash()` (possession of the emailed token grants read access to that one invite); (b) a SECURITY DEFINER lookup returning only status + masked email for a token hash; (c) return a generic `not_found` for mismatches.
- Blocking: no for WP-03 (no policy added for this case). WP-05 needs the answer for that acceptance item.
- Answer: SECURITY DEFINER `app_invite_lookup(token_hash bytea)` returning only `status` (valid / expired / revoked / accepted / mismatch) and the masked invited email, using the same rule as `@mp/format` `maskEmail` (at most 3 characters, always hide one). EXECUTE to mp_api only. (tech lead, 2026-10-27) Implemented in `202610271600_wp03_g1-hardening.sql` (`app_invite_lookup`, `app_mask_email`); tests in `packages/db/test/rls/g1-hardening.test.ts`, including parity with `maskEmail`.

## Q-012 · WP-03 · Who may UPDATE/DELETE audit_events for retention and deletion tombstones?
- Asked by: wp-builder/wp/03-db-foundation · 2026-10-27
- Where: BACKEND_PLAN §5.3 (audit_events insert-only for app roles), §7.11 (retention 2 years; tombstones after household deletion)
- Question: `retention.purge` must delete audit events older than 2 years, and household deletion keeps "only a tombstone" (strip metadata). Both need UPDATE/DELETE, which §5.3 revokes from app roles. WP-03 implements the revoke strictly. Which role performs these?
- Options considered: (a) a dedicated maintenance role (e.g. `mp_maintenance`, created in init.sql/infra) with narrow DELETE/UPDATE policies (`created_at < now() - interval '2 years'`; tombstoning only where the household no longer exists); (b) SECURITY DEFINER purge/tombstone functions owned by mp_migrator, callable by mp_worker; (c) run them as the migrator.
- Blocking: no for WP-03. Blocks WP-24 retention/tombstone work.
- Answer: A narrow SECURITY DEFINER `app_purge_audit_events()` executable by mp_worker only: deletes rows older than 2 years and tombstones events of deleted households per BACKEND_PLAN §7.11. audit_events stays append-only for all app roles otherwise. (tech lead, 2026-10-27) Implemented in `202610271600_wp03_g1-hardening.sql`: tombstoning keeps household_id, action, actor_type and created_at, sets the new `tombstoned_at`, and tombstones are deleted 1 year after `tombstoned_at`. Tested in `packages/db/test/integration/audit-purge.test.ts` with backdated rows.

## Q-011 · WP-03 · Confirm RLS design choices the spec leaves open (G1)
- Asked by: wp-builder/wp/03-db-foundation · 2026-10-27
- Where: BACKEND_PLAN §5.3 shows only the standard household policy; ADR-003
- Question: Please confirm these choices at G1:
  1. **Membership helpers are SECURITY DEFINER functions owned by mp_migrator** (`app_is_household_member`, `app_household_unclaimed_by_me`, `app_user_email`). A `household_members` policy cannot query `household_members` (Postgres reports infinite recursion), and FORCE RLS applies to the owner too, so mp_migrator has read-only `*_definer_read` SELECT policies on `users`, `households`, `household_members`. Alternative: a NOLOGIN BYPASSRLS function-owner role created by init.sql/infra.
  2. **Bootstrap uses `app.auth_subject`**: mp_api may insert/read/update a `users` row only for the verified auth subject (or `app.user_id`). Partners see each other's users rows.
  3. **Creating a household cannot use INSERT ... RETURNING** (the creator is not a member until the membership row exists in the same transaction); the API supplies the id.
  4. **`households.plan` is not writable by mp_api**; only mp_worker (`billing.sync`) can set it. The seed sets it through mp_worker.
  5. **Joining**: mp_api may insert only its own membership, either as creator of a household with no members, or as non-creator holding an open (unexpired, unrevoked, unaccepted) invite to its email.
  6. **`webhook_events`** has forced RLS with allow-all policies for mp_api and mp_worker (no tenant data; webhooks arrive with no user context).
  7. **Pre-context lookups** the worker will need (e.g. `forwarding_token` → household for `email.inbound`, WP-20) are not possible under these policies yet; WP-20 will need a narrow SECURITY DEFINER lookup.
- Options considered: as listed per item.
- Blocking: no (implemented as described; easy to change before merge).
- Answer: Confirmed as built. Also recorded: data backfills in future migrations need an explicit mp_migrator policy, because FORCE RLS applies to the owner. (tech lead, 2026-10-27) The G1 review also replaced item 5's invite path with `app_accept_invite(token_hash)` (see `202610271600_wp03_g1-hardening.sql`).

## Q-010 · WP-03 · Seed values missing from the golden fixture
- Asked by: wp-builder/wp/03-db-foundation · 2026-10-27
- Where: `design/fixtures/rivera-household.json` (`household`, `members`); BACKEND_PLAN §5.2 (`users.email`, `households.timezone` are NOT NULL)
- Question: The fixture has no household timezone and no member emails. The seed needs both. What should they be? The timezone matters for later engine work (what "today" is).
- Options considered: placeholders now: timezone `America/New_York` (the `users.timezone` default), emails `sam@rivera-household.example` / `jordan@rivera-household.example`, defined as constants in `packages/db/src/seed/rivera.ts`; or add `timezone` and member emails to the fixture (spec change).
- Blocking: no (placeholders used; the fixture was not edited).
- Answer: Fixture updated on main (93261bd): `household.timezone = "America/New_York"`, member emails `sam@rivera-household.example` and `jordan@rivera-household.example`. The seed now reads them from the fixture; the placeholders are gone. (tech lead, 2026-10-27)

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
