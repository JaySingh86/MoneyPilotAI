# Architecture decision records

Each ADR states its context, the decision and its consequences.
- **Accepted:** agents build on it.
- **Proposed:** waiting for an owner decision (BACKEND_PLAN §17). Agents build behind the adapter named in the ADR, so the choice can change without rework.

To change a decision, add a new ADR that supersedes the old one. Don’t edit an accepted ADR.

| # | Decision | Status |
|---|---|---|
| 001 | Modular monolith (api + worker) | Accepted |
| 002 | TypeScript everywhere; pnpm + Turborepo monorepo | Accepted |
| 003 | PostgreSQL with forced RLS as the tenancy boundary | Accepted |
| 004 | pg-boss for jobs and the transactional outbox | Accepted |
| 005 | Deterministic engine package and golden fixture | Accepted |
| 006 | RRULE schedules + materialized occurrences | Accepted |
| 007 | Money as integer cents; Temporal for dates | Accepted |
| 008 | Zod-first contracts → OpenAPI → generated clients | Accepted |
| 009 | Email capture: metadata prefilter, one structured extraction, evidence validation, no bodies stored | Accepted |
| 010 | AI provider and per-route model config | Accepted (default model); per-route changes Proposed |
| 011 | Auth through an adapter (Clerk proposed) | Proposed |
| 012 | Hosting on AWS with CDK; web on Vercel | Proposed |
| 013 | Billing through an adapter (merchant of record proposed) | Proposed |
| 014 | Agent-driven delivery: work packages, path ownership, CI as the contract | Accepted |
| 015 | Timestamped SQL migrations, expand/contract | Accepted |

---

## ADR-001 Modular monolith
**Context:** small team with coding agents and an unvalidated product, which needs fast iteration and simple operations.
**Decision:** one codebase and one database, deployed as two processes: `api` (HTTP) and `worker` (jobs). Modules have explicit boundaries (ARCHITECTURE §3.1), enforced by lint.
**Consequences:** one deploy pipeline and strong consistency. Modules could later be split out along the same boundaries if load requires. Boundary discipline relies on CI rules, not network separation.

## ADR-002 TypeScript everywhere
**Context:** web (Next.js), mobile (React Native), API and worker. Agents work best with one language and shared types.
**Decision:** TypeScript strict on Node 22; pnpm workspaces + Turborepo; Vitest for tests.
**Consequences:** shared Zod schemas and the generated client remove a class of contract bugs. The CPU-heavy work (PDF text) is fine in Node at our scale.

## ADR-003 PostgreSQL with forced RLS
**Context:** two people share sensitive household data, and a tenancy bug is the worst-case failure.
**Decision:** every household-owned table has `household_id` with RLS `ENABLE` + `FORCE`. Separate DB roles exist for api, worker, migrator and analytics. Each request runs in a transaction with `SET LOCAL app.user_id`; each job with `SET LOCAL app.household_id`. A CI test fails if any table lacks cross-tenant coverage.
**Consequences:** isolation holds even when application code is wrong. There is a small per-request overhead, and queries must run inside `withHouseholdTx`.

## ADR-004 pg-boss for jobs
**Context:** many async flows (email, reminders, imports), a small team, and no wish to run Redis or SQS on day 1.
**Decision:** pg-boss on the same Postgres. Jobs are enqueued in the same transaction as the data change. Singleton keys handle per-household and per-connection work.
**Consequences:** no lost or phantom jobs (the outbox comes for free) and one system to back up. If throughput grows past what Postgres handles comfortably, move hot queues to SQS behind the same `enqueue()` interface.

## ADR-005 Deterministic engine + golden fixture
**Context:** users must trust the numbers. The design promises “rules calculate, AI explains”.
**Decision:** `packages/engine` is pure TypeScript (no I/O, clock or randomness) implementing DESIGN_SPEC §6. `design/fixtures/rivera-household.json` is the golden test. Results are stored as `calc_snapshots` with `engine_version`, and AI text references a snapshot.
**Consequences:** the same input always gives the same output. “See the math” is reproducible, and the engine can also run on the client for previews later.

## ADR-006 RRULE + materialized occurrences
**Context:** we need monthly, last-day, last-Friday, biweekly, every-N-months and yearly schedules, plus per-occurrence state (paid, actual amount, moved).
**Decision:** store an RFC 5545 RRULE + `dtstart` per item; the UI uses a friendlier `Schedule` union. Occurrences are materialized from 35 days back to 400 days ahead, unique on `(item_id, scheduled_on)`. Moving one occurrence changes `due_on` only.
**Consequences:** reminders, calendar and paid status become simple queries. Schedule edits rebuild future rows only.

## ADR-007 Money and time representation
**Decision:** money is integer cents everywhere (`bigint` in SQL, integer `number` in TS, guarded `|x| < 2^53`). Bill dates are `PlainDate` (Temporal polyfill) in the household timezone; events are UTC `timestamptz`. Formatting happens only in `packages/format`.
**Consequences:** no float rounding errors and no off-by-one-day bugs across timezones or DST, as long as the hard rules in CLAUDE.md are kept.

## ADR-008 Contracts
**Decision:** Zod schemas in `packages/contracts` are the single source for request/response validation. Fastify generates OpenAPI 3.1, `openapi-typescript` generates the web/mobile client, and CI fails on drift.
**Consequences:** agents working on frontend and backend in parallel stay in sync through a generated artifact rather than conversation.

## ADR-009 Email capture design
**Context:** we need automation with privacy and resistance to prompt injection.
**Decision:**
- Fetch metadata first and prefilter by sender and keywords.
- For messages that pass, fetch the full message, convert to text, redact, and make **one** structured-output extraction call with no tools.
- Validate with rules: verbatim evidence quotes, plausibility.
- Auto-apply only safe updates to confirmed items, with a 30-day undo. Everything else goes to the review queue.
- Don’t store email bodies.
- Gmail uses `gmail.readonly` plus Pub/Sub push; Outlook uses Graph `Mail.Read` plus notifications and delta; any other provider uses a forwarding address via SES inbound.

**Consequences:** fewer AI calls and lower cost; hallucinated values are blocked by evidence checks. Google restricted-scope verification and annual CASA are required before leaving testing mode (≤ 100 users).

## ADR-010 AI provider and model config
**Decision:** Anthropic Claude API through `@anthropic-ai/sdk` in `packages/ai`. Each route (`extract`, `explain`, `ask`) reads its model from `config.ts`. The default for all routes is `claude-opus-5-5`, with effort `low` for extract and explain and `medium` for ask. Structured outputs for extraction, Batch API for backfill, prompt caching for system prompts, `inference_geo: "us"`.
**Status:** default accepted. Switching any route to a cheaper model (for example `claude-haiku-5-5` for extraction) is an owner decision, made after the eval gates in BACKEND_PLAN §7.9.

## ADR-011 Auth adapter (Proposed: Clerk)
**Decision:** `apps/api/src/auth/provider.ts` defines `verifyToken`, `getUser` and `requireStepUp`. The first implementation is Clerk (MFA, passkeys, Expo SDK). Our `users` table is keyed by `auth_subject`.
**Alternative:** AWS Cognito, behind the same interface.

## ADR-012 Hosting (Proposed: AWS + CDK, Vercel for web)
**Decision:** AWS `us-east-1` (RDS, ECS Fargate, S3, KMS, SES, Secrets Manager) defined in CDK TypeScript; separate accounts per environment. The web app runs on Vercel.
**Alternative for the pilot:** managed Postgres (Neon/Supabase) + Render. This would weaken the KMS token story, so it is not recommended.

## ADR-013 Billing adapter (Proposed: merchant of record)
**Decision:** `packages/billing` defines `createCheckout`, `portalUrl`, `handleWebhook` and `entitlements`. Recommend a merchant of record (Paddle or Lemon Squeezy) given the India-based entity; verify eligibility. Mobile uses RevenueCat later.

## ADR-014 Agent-driven delivery
**Context:** the build is done mostly by coding agents working in parallel.
**Decision:**
- Work is split into work packages (WORK_PLAN.md), each with **owned paths**, “read first” sections and checkable acceptance criteria.
- Each package runs in its own git worktree or branch.
- CI fitness functions (ARCHITECTURE §8) and reviewer agents are the contract. A human approves at gates G1–G4.

**Consequences:** parallel work with few merge conflicts. Quality depends on specs and tests being precise, which is why the golden fixture and the spec documents exist.

## ADR-015 Migrations
**Decision:** plain SQL migrations named `YYYYMMDDHHMM_<wp>_<slug>.sql` in `packages/db/migrations`, applied in name order by our runner. Drizzle schema files mirror them for typed queries. Changes are expand → deploy → contract. A merged migration is never edited.
**Consequences:** parallel agents don’t collide on sequence numbers; rollbacks are forward fixes.
