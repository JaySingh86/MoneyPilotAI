# @mp/ai

Claude client, versioned prompts, schemas and the eval harness (WP-11).

## Layout

| Path                      | What                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts`           | Model, effort, `max_tokens`, retry, timeouts, price table (placeholder, Q-071)                                                                    |
| `src/transport.ts`        | The seam to the provider. No request type has a `tools` field                                                                                     |
| `src/sdk-transport.ts`    | The only file that imports `@anthropic-ai/sdk` for calls                                                                                          |
| `src/client.ts`           | Retry on typed errors, `stop_reason` checks, `ai_runs` metering                                                                                   |
| `src/schemas/`            | Zod schemas. The extraction schema is `src/schemas/extraction.v1.ts` (BACKEND_PLAN §7.8.2 names `packages/ai/schemas/...`; this is the real path) |
| `src/extract/`            | Extraction route, evidence validation, batch helpers. Import as `@mp/ai/extract`                                                                  |
| `src/testing/`            | Fake transport for tests (`@mp/ai/testing`)                                                                                                       |
| `src/eval/`, `evals/`     | Eval harness, synthetic corpus, committed offline recording and report                                                                            |
| `prompts/<route>.v<N>.md` | Versioned prompts. A change is a new version plus an eval run                                                                                     |

## Rules that matter

- Email content never reaches a model that has tools. Do not add `tools` to `ModelRequest`.
- Extraction output is schema-only and must pass `validateExtraction` (evidence rules) before it is used.
- Frequency and auto-renew values without a quote come back in `advisoryFields`. Do not auto-apply on them.
- Cost numbers are estimates (`cost_micros`, `costEstimated`), never invoice figures.

## For WP-28 (Ask MoneyPilot)

Ask needs tools and streaming. Extend `transport.ts` and `sdk-transport.ts` (new request type, new transport
method) and keep `client.ts` as the one place that retries and meters. Do not call the SDK from anywhere else,
and do not reuse the extraction request type, which is deliberately tool-free.

## Evals

```
pnpm ai:eval                          offline, replays evals/recordings (no network, no key)
pnpm ai:eval -- --live                real API; needs ANTHROPIC_API_KEY and the explicit flag
pnpm ai:eval -- --live --record       also saves the responses as the new recording (synthetic corpus only)
pnpm ai:eval -- --live --corpus FILE  evaluate an external corpus
```

The committed corpus and recording are synthetic. The recording is an oracle built from the labels, so the
committed report proves the harness works and says nothing about model quality.

Consented real emails never go into this repo. Keep that corpus outside it, in the same JSON format
(`src/eval/corpus.ts`, with `"synthetic": false`), and pass it with `--corpus`. `--record` is refused for it,
and its report is written to `evals/reports/latest-live.*`, which is git-ignored.

Production batch backfills: a `refusal` result from the Batches API is not rescued (no fallbacks there). The
caller (WP-22) re-runs those items through `extractEmail`.
