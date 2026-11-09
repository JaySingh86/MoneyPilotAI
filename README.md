# MoneyPilot AI

A household financial planning assistant for US couples and families.

MoneyPilot shows a household what is coming before the next payday, how much is safe to spend, who owns each bill, and what needs a decision this week. Two partners share one household: each sees the same plan, confirms bills, and approves changes.

**MoneyPilot never moves money.** There are no pay, transfer or send-money actions. Bills are marked as paid, and changes go to the other partner for approval.

## What it does

- **Overview:** the cash runway to the next payday, safe-to-spend, and an early warning when a shortfall is coming.
- **Calendar:** bills, income and paydays on one household calendar.
- **Bills and renewals:** recurring bills and subscriptions, each with an owner (partner A, partner B or both), plus price-change and renewal flags.
- **Goals, proposals and tasks:** shared savings goals, what-if proposals, and a weekly list of decisions.
- **Email capture:** read-only Gmail and Outlook connections (or forwarding) that find bill, renewal and receipt emails and turn them into suggested updates in a review queue, with undo.
- **CSV import:** upload a bank statement to detect recurring payments.
- **Reminders:** email reminders before bills are due.

### Rules calculate, AI explains

Every number on screen comes from a deterministic planning engine ([`packages/engine`](packages/engine)), checked against a golden sample household ([`design/fixtures/rivera-household.json`](design/fixtures/rivera-household.json)). Claude is used to pull structured data out of bill emails and, later, to explain results in plain language. AI never calculates or invents an amount or a date, and email content never reaches a model that has tools.

## Status

Early development; not yet open to users. Most of the MVP is built: the planning engine, database, API, web UI, CSV import, reminders, billing adapter, Gmail and Outlook connectors (tested against fakes so far), and the email processing pipeline. The pipeline extracts bill details from email, checks each field against the message, and sends suggested changes to the review queue. Automatic applying of changes stays off until it has been checked against real messages. The project is now moving from mock data to a real Supabase project.

Still to do for the MVP: the forwarding channel, privacy operations (export, delete, retention) and production hardening. Planned after the MVP: AI explanations, "Ask MoneyPilot", realtime updates, a React Native mobile app, and bank connections through Plaid.

Progress is tracked in [`docs/agents/WORK_PLAN.md`](docs/agents/WORK_PLAN.md).

## Tech stack

| Area | Choice |
|---|---|
| Language | TypeScript everywhere (strict, ESM, Node 22) |
| Monorepo | pnpm workspaces + Turborepo |
| Web | Next.js (App Router) |
| API | Fastify, Zod contracts, generated OpenAPI client |
| Jobs | pg-boss worker with cron |
| Database | PostgreSQL with forced row-level security per household, Drizzle, SQL migrations |
| Auth, storage | Supabase Auth and Storage, reached only through our API |
| AI | Anthropic Claude (`@anthropic-ai/sdk`), versioned prompts and evals |
| Email | Gmail API, Microsoft Graph, Amazon SES |
| Testing | Vitest, Testcontainers, Playwright, visual and accessibility checks |

## Repository layout

```
apps/web               Next.js web app (UI only, calls the API)
apps/api               Fastify HTTP server: routes, auth, webhooks
apps/worker            Background jobs and cron
packages/engine        Pure planning math (no I/O), golden and property tests
packages/db            Schema, migrations, RLS policies, seed data
packages/contracts     Zod schemas, OpenAPI and the typed client
packages/ui            Web components built on the design tokens
packages/format        Money and date formatting
packages/email         Gmail, Outlook and forwarding adapters, redaction, prefilter
packages/ai            Claude client, prompts, output schemas, evals
packages/detection     CSV parsing and recurring-payment detection
packages/review-rules  Auto-apply policy for suggested changes
packages/notify        Email and push rendering and delivery
packages/billing       Billing adapter and entitlements
packages/crypto        Envelope encryption for OAuth tokens
packages/observability Logging and tracing with PII redaction
design/                Design tokens and the golden fixture
docs/                  Specs, architecture, decisions and runbooks
```

## Getting started

**Prerequisites:** Node 22.13 or newer, pnpm 9 (`corepack enable pnpm`), and Docker Desktop.

### Mock mode (no database)

```bash
pnpm install
pnpm dev            # web on http://localhost:3100 with mocked data and a fake session
```

### Live mode, fully local

```bash
docker compose up -d postgres minio     # local Postgres and S3-compatible storage
cp .env.example .env.local              # defaults point at the local services
pnpm db:migrate && pnpm storage:init
pnpm dev:live                           # api :4000, worker, web :3100
```

To run against a real Supabase project, follow [`docs/runbooks/supabase-setup.md`](docs/runbooks/supabase-setup.md).

### Common commands

```bash
pnpm lint && pnpm typecheck
pnpm test             # unit, integration and architecture checks
pnpm test:engine      # planning engine golden and property tests
pnpm test:rls         # cross-household isolation tests
pnpm e2e              # Playwright end-to-end tests
pnpm contracts:gen    # regenerate the OpenAPI spec and typed client
```

## Security and privacy

- Every household-owned table uses forced row-level security, and CI runs cross-household isolation tests.
- Money is stored as integer cents; bill dates are household-local calendar dates.
- Email bodies, full account numbers and plaintext OAuth tokens are never stored. OAuth tokens are envelope-encrypted, and only the worker can decrypt them.
- Logs go through a shared logger that redacts personal data and amounts.

## Documentation

| Document | Covers |
|---|---|
| [`docs/DESIGN_SPEC.md`](docs/DESIGN_SPEC.md) | Screens, components, calculation rules, content and accessibility |
| [`docs/BACKEND_PLAN.md`](docs/BACKEND_PLAN.md) | Schema, API, jobs, email pipeline, AI and security |
| [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) | System context, containers, flows and module boundaries |
| [`docs/architecture/DECISIONS.md`](docs/architecture/DECISIONS.md) | Architecture decision records |
| [`CLAUDE.md`](CLAUDE.md) | Rules and conventions for contributors and coding agents |

## License

No license has been chosen yet. Until one is added, all rights are reserved.
