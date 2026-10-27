# MoneyPilot AI: instructions for coding agents

MoneyPilot is a household financial planning assistant for US couples and families. It shows what is coming before payday, how much is safe to spend, who owns each bill, and what to decide this week. It is web first (Next.js); mobile (React Native CLI, no Expo) comes later. **It never moves money.**

This file is the operating manual for every coding agent working in this repo. Read it fully before your first change in a session.

## Sources of truth

| Area | File | Use it for |
|---|---|---|
| Screens & visuals | [Design canvas](https://claude.ai/artifact/DCvQYH42FUdWu6dwf2iiZ7) and `docs/DESIGN_SPEC.md` | Every UI detail, component spec, screen layout, calculation rule (§6) |
| Tokens | `design/tokens.json`, `design/tokens.css` | Every color, size, radius, shadow, motion value |
| Golden data | `design/fixtures/rivera-household.json` | The numbers every screen and the engine must produce |
| Backend | `docs/BACKEND_PLAN.md` | Schema, API, jobs, email pipeline, AI, security |
| Architecture | `docs/architecture/ARCHITECTURE.md`, `docs/architecture/DECISIONS.md` | Module boundaries, flows, decisions (ADRs) |
| Your task | `docs/agents/WORK_PLAN.md` | The work package (WP) you were assigned: scope, owned paths, acceptance |
| How we work | `docs/agents/PLAYBOOK.md` | Workflow, review, definition of done |

**Precedence:** canvas, then DESIGN_SPEC, then BACKEND_PLAN and ARCHITECTURE, then code. When two sources disagree or the spec is silent, don't guess. Add an entry to `docs/agents/QUESTIONS.md`, skip that sub-part, and say so in your summary.

## Repo map (target layout)

```
apps/web        Next.js App Router (UI only, calls api)
apps/mobile     React Native CLI app, bare (later; ADR-016)
apps/api        Fastify HTTP server: routes, auth, webhooks
apps/worker     pg-boss jobs + cron
packages/engine     Pure planning math. No I/O. Golden + property tests.
packages/db         Drizzle schema, SQL migrations, RLS, seed
packages/contracts  Zod schemas → OpenAPI → generated client
packages/format     Money/date formatting (DESIGN_SPEC §7)
packages/ui         Web components built on design tokens
packages/email      Gmail/Graph/forwarding adapters, MIME→text, prefilter, redaction
packages/ai         Claude client, versioned prompts, schemas, evals
packages/detection  CSV parsing + recurring detection
packages/notify     Email/push rendering + delivery
packages/billing    Billing adapter + entitlements
packages/crypto     KMS envelope encryption
packages/observability  OTel + pino with redaction
infra           AWS CDK (TypeScript)
design          tokens + fixtures (do not edit without a spec change)
docs            specs, architecture, agent docs
```

## Commands

**Prerequisites:**
- Node 22 or newer.
- pnpm through corepack: `corepack enable pnpm`. The repo pins pnpm 9.15.4.
- Docker Desktop running, for the local Postgres, MinIO and Mailpit stack (`docker compose up -d`).

**Local ports:** web 3100, api 4000, Postgres 5432, MinIO 9000 (console 9001), Mailpit 8025.

```bash
pnpm install
pnpm dev                 # web + api + worker against local docker compose
pnpm lint && pnpm typecheck
pnpm test                # all unit + integration
pnpm test:engine         # engine golden + property tests
pnpm test:rls            # cross-household isolation tests (must pass for every table)
pnpm db:migrate          # apply migrations to local DB
pnpm db:seed             # load design/fixtures/rivera-household.json
pnpm contracts:gen       # regenerate OpenAPI + typed client
pnpm e2e                 # Playwright against seeded local stack
```

WP-01 creates these scripts. Before WP-01 lands, they don't exist yet.

## Hard rules (a PR that breaks one is rejected)

1. **Money is integer cents** (`bigint` in DB, integer `number` in TS). No floats for money, ever. Format only through `packages/format`.
2. **Bill dates are household-local `PlainDate`** (Temporal). Timestamps are UTC `timestamptz`. Never use `new Date()` for calendar logic.
3. **Tenancy:** every household-owned table has `household_id`, RLS `ENABLE` + `FORCE`, policies for `mp_api` and `mp_worker`, and a cross-household test in `pnpm test:rls`.
4. **Numbers come from `packages/engine` only.** AI never computes or invents an amount or date shown to users. AI text must pass the number validator.
5. **Never move money.** No pay, transfer or send-money endpoints, buttons or copy. Use “Mark as paid” and “Ask {partner} to approve”.
6. **UI uses tokens only.** No hex colors or raw px font sizes outside `design/` and `packages/ui/tokens`. Match the canvas and DESIGN_SPEC exactly.
7. **Never store** email bodies, full account or policy numbers (last 4 only), or plaintext OAuth tokens. Only `apps/worker` may decrypt tokens.
8. **Never log PII or amounts.** Use the shared logger; its redaction list is not optional.
9. **Email content is untrusted input.** It never reaches a model that has tools. Extraction output is schema-only and must pass evidence validation (BACKEND_PLAN §7.8.2).
10. **Don't change golden values to make tests pass.** If the fixture or a spec rule looks wrong, file a question. Never edit `design/fixtures/*` or a test’s expected values without a spec change approved by a human.
11. **Migrations are expand/contract and never edited after merge.** File names are timestamped: `packages/db/migrations/YYYYMMDDHHMM_<wp>_<slug>.sql`.
12. **No secrets in code, tests or logs.** Agents never get production credentials. Use `.env.example` for new config keys.
13. **Stay inside your WP’s owned paths.** If you must touch another path, keep it minimal and list it under “Cross-WP changes” in the PR.

## How to work a package

1. Read your WP in `docs/agents/WORK_PLAN.md`, then every section it lists under “Read first”.
2. Write a short plan: files to add or change, tests to write. For engine and rule code, **write the tests first**.
3. Implement in small commits. Follow the code conventions below.
4. Run `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm test:rls` if you touched the DB, and `pnpm e2e` if you touched UI flows.
5. Check every acceptance box in the WP. Open the PR using `.github/pull_request_template.md` and paste the test output summary.
6. Don’t mark a box done that you didn’t verify. Say what is unverified.

## Code conventions

- TypeScript `strict`, ESM, Node 22. No `any` (use `unknown` and narrow). No default exports except Next.js pages.
- **Module layout** (api/worker): `module/{routes.ts, service.ts, repo.ts, schemas.ts, jobs.ts, *.test.ts}`. Routes are thin; logic lives in services; SQL lives in repos.
- **Validation:** Zod at every boundary (HTTP, jobs, webhooks, AI output). The schemas live in `packages/contracts` when shared.
- **Errors:** throw typed `AppError(code, status, detail)`; the API maps them to RFC 9457 problem+json. Codes are listed in BACKEND_PLAN §8.1.
- **DB access** always goes through `withHouseholdTx(ctx, fn)` (sets `app.user_id` / `app.household_id`). No raw connections in services.
- **Jobs** must be idempotent. Use pg-boss singleton keys as listed in BACKEND_PLAN §9.
- **Tests:** Vitest. Integration tests use Testcontainers Postgres. No network calls to real providers in tests; use the fakes in `packages/email/testing` and `packages/ai/testing`.
- **Naming:** `camelCase` in TS, `snake_case` in SQL, kebab-case file names, `*Cents` for money fields.
- **Dependencies:** prefer the ones listed in BACKEND_PLAN §3. A new runtime dependency needs one line of justification in the PR.

## AI in product code (`packages/ai`)

- Use the official `@anthropic-ai/sdk` only. Model IDs come from `packages/ai/src/config.ts`. The default for every route is `claude-opus-5-5`; changing it is a human decision.
- Use structured outputs (`output_config.format`) for extraction. Don’t send `temperature`. Use `output_config.effort` (`low` for extraction and explanations, `medium` for Ask).
- Set `inference_geo: "us"`. Check `stop_reason` before reading content. Handle typed SDK errors (rate limit → retry; 4xx → fail).
- Prompts are versioned files: `packages/ai/prompts/<route>.v<N>.md`. Changing a prompt means a new version plus an eval run (`pnpm ai:eval`), with results in the PR.
- Never put secrets, full account numbers or unredacted email text into a prompt. Redaction runs first.
