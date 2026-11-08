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
| 011 | Auth through an adapter (Clerk proposed) | Superseded by 017 |
| 012 | Hosting on AWS with CDK; web on Vercel | Superseded for data, auth and storage by 020; compute hosting still open |
| 013 | Billing through an adapter (merchant of record proposed) | Proposed |
| 014 | Agent-driven delivery: work packages, path ownership, CI as the contract | Accepted |
| 015 | Timestamped SQL migrations, expand/contract | Accepted |
| 016 | Mobile app on the React Native CLI (no Expo) | Accepted |
| 017 | Auth on AWS Cognito behind the adapter | Superseded by 020 |
| 018 | Step-up requires proof that MFA was used | Accepted (principle kept by 020: Supabase `aal2` plus a recent TOTP `amr` entry) |
| 019 | Web tokens in Amplify's default browser storage, protected by CSP | Superseded by 020 |
| 020 | Supabase for Postgres, Auth and Storage, reached only through our API; local hosting for the real-data phase | Accepted |

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
**Decision:** `apps/api/src/auth/provider.ts` defines `verifyToken`, `getUser` and `requireStepUp`. The first implementation is Clerk (MFA, passkeys). Its React Native SDK depends on Expo modules, which ADR-016 rules out, so mobile sign-in needs a plain React Native integration or a provider with a native RN SDK; settle this together with the provider choice. Our `users` table is keyed by `auth_subject`.
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

## ADR-016 Mobile app on the React Native CLI (no Expo)
**Context:** the mobile app (after web validation) needs the same TypeScript packages as the web app. The owner prefers full native control over the Expo managed toolchain.
**Decision:** `apps/mobile` is a bare React Native app created and built with the React Native CLI, with no Expo SDK or Expo modules. It reuses `@mp/contracts` (generated API client), `@mp/format` and `@mp/ui/tokens`. Choices that previously assumed Expo:
- **Navigation:** React Navigation.
- **Secure token storage:** `react-native-keychain` (iOS Keychain, Android Keystore).
- **Push:** Firebase Cloud Messaging through `@react-native-firebase/messaging`; iOS goes through APNs via FCM.
- **Sign-in:** AWS Amplify Auth with `@aws-amplify/react-native`, which supports bare React Native (ADR-017).
- **Builds and releases:** Xcode and Android Studio projects in the repo, Fastlane for signing and store uploads, CI on macOS runners for iOS.
- **Tests:** Jest with React Native Testing Library; Detox for end-to-end.

**Consequences:** full control over native code and dependencies, at the cost of maintaining the iOS and Android projects ourselves (upgrades with the React Native Upgrade Helper, signing, store builds). There are no over-the-air JS updates; every change ships through the app stores. Pin the React Native version in WP-30 and follow its upgrade guide for each release.

## ADR-017 Auth on AWS Cognito (supersedes ADR-011's Clerk proposal)
**Context:** Clerk's React Native SDK depends on Expo, which ADR-016 rules out. Hosting is proposed on AWS (ADR-012), where Cognito sits next to KMS, SES and the rest.
**Decision:** a Cognito user pool per environment, behind the adapter in `apps/api/src/auth/provider.ts` (`verifyToken`, `getUser`, `requireStepUp`).
- Sign-in: email + password, passkeys, Sign in with Google (federation), and TOTP MFA.
- Clients:
  - Web uses Amplify Auth with our own screens built from the UI kit.
  - Mobile uses Amplify Auth with `@aws-amplify/react-native`; tokens go in the Keychain or Keystore via `react-native-keychain`.
- The API accepts the Cognito **access token** as `Authorization: Bearer`. It verifies the token with `aws-jwt-verify`: issuer, client id, `token_use = access`, expiry, 60 s skew.
- A pre-token-generation trigger (V2) adds `email`, `email_verified` and `mfa_enabled` to the access token.
- Step-up uses `mfa_enabled` and `auth_time`, at most 10 minutes old for destructive actions.
- There are no auth webhooks:
  - `/me/bootstrap` creates the `users` row from verified claims.
  - Email and MFA changes sync from the claims on bootstrap, and only when `email_verified` is true.
  - Account deletion removes the Cognito user from the worker with `AdminDeleteUser`.
- Tests and local dev use a fake issuer with a locally generated JWKS. The real user pool and the trigger Lambda are created in WP-09, and agents never get its credentials.

**Consequences:**
- The sign-in UI is ours to build, since Cognito's managed login isn't used for the in-app look.
- It is cheaper at scale and stays in one cloud.
- `app_sync_auth_user` becomes callable by `mp_api`; the email argument may only come from a verified `email_verified = true` claim.

## ADR-018 Step-up requires proof that MFA was used (amends ADR-017)
**Context:** the G1 review of WP-05 found that `mfa_enabled` + `auth_time` proves a recent sign-in, not that a second factor was used. A federated (Google) sign-in, or a pool with optional MFA, could pass step-up with only a stolen password or session.
**Decision:**
- The pre-token-generation trigger adds `mfa_verified_at` (epoch seconds) only when the session's sign-in completed a second-factor challenge. It keeps the value across token refreshes and never invents it.
- Step-up requires `mfa_verified_at` at most 10 minutes old. `mfa_enabled` stays as an informational "enrolled" flag.
- MFA stays optional for everyday use (owner decision, 2026-11-03). Federated sign-ins must complete our TOTP challenge before step-up actions.
- WP-09 implements the trigger. If Cognito can't provide this signal reliably, WP-09 files a question; the fallback is pool-level MFA REQUIRED.

**Consequences:** sensitive actions (connect email, export, delete, leave) can't be reached with a password alone. WP-05 tests must cover a missing, stale and string-typed `mfa_verified_at`.

## ADR-019 Web sign-in tokens stay in Amplify's default storage, protected by a strict CSP
**Context:** the WP-17 security review noted that Amplify keeps Cognito tokens in localStorage, where any successful XSS could read them. Moving them to cookies the page can read gives no real protection, and httpOnly cookies would need a backend-for-frontend that this project doesn't have yet.
**Decision:** keep Amplify's default storage. Mitigate with a strict nonce-based CSP and the standard security headers, no `dangerouslySetInnerHTML`, React text rendering for all user and engine strings, self-hosted fonts, an API client that sends the token only to the API origin, and short token lifetimes (access and ID tokens ≤ 60 min) set in WP-09.
**Consequences:** XSS prevention is the primary defence, so any new HTML sink or third-party script needs a security review. Revisit (a BFF with httpOnly cookies) if the app ever embeds third-party scripts.

## ADR-020 Supabase for Postgres, Auth and Storage, reached only through our API (supersedes ADR-017 and ADR-019; amends ADR-012)
**Context:** the owner wants to test the product end to end with real data (sign up, connect Gmail, upload a bank CSV, see the dashboard) before any AWS account exists. Owner decision, 2026-11-09.
**Decision:**
- **Database:** a Supabase Postgres project in a US region. Our own roles stay: `mp_migrator` owns the schema objects; `mp_api`, `mp_worker` and `mp_queue` log in. None has BYPASSRLS. A one-time bootstrap script, run as `postgres`, creates them. Forced RLS (ADR-003) and every migration stay as they are. The Supabase Data API (PostgREST) is turned off, and `anon`/`authenticated` get no grants on our tables.
- **Auth:** Supabase Auth (email + password, Sign in with Google, TOTP MFA), behind the existing adapter (`apps/api/src/auth/provider.ts`).
  - **Clients never call Supabase directly.** Web and mobile call our API's `/auth/*` routes (sign up, confirm, sign in, refresh, sign out, password reset, MFA enrol/verify, Google start/callback). The API talks to Supabase Auth server-side. The publishable and secret keys live only in the API's environment.
  - The API verifies the Supabase **access token** on every request with Supabase's asymmetric JWKS. It checks issuer, audience `authenticated`, expiry and a 60 s skew.
  - Step-up (ADR-018 principle): requires `aal = aal2` and a `totp` entry in `amr` at most 10 minutes old.
  - `/me/bootstrap` keeps creating the `users` row from verified claims (`email_confirmed_at` set).
- **Storage:** a private Supabase Storage bucket for CSV uploads, reached by the API and worker through the S3-compatible endpoint, behind the WP-16 storage interface. No client gets storage keys.
- **Hosting (real-data phase):** api, worker and web run on the owner's machine against the Supabase project. Compute hosting is decided later (ADR-012 stays open for compute).
- **OAuth token encryption (ADR-009):** envelope encryption keeps its `KeyProvider` interface. Locally, the master key comes from a worker-only environment variable. A managed KMS is required before any shared or deployed environment.

**Consequences:**
- Cognito, Amplify, the CDK user pool and its trigger Lambdas are parked (WP-09 branch). The web and mobile auth adapters now call our API.
- The API handles passwords in transit. It never logs them (hard rule 8), and auth routes have strict rate limits.
- Tokens are held by the client app. The web keeps the refresh token in an httpOnly cookie set by the API, and the access token in memory.
- Tests keep using vanilla Postgres (Testcontainers) and a fake JWKS issuer. A compatibility test runs the migrations and RLS suite against the Supabase Postgres image.
- Agents never receive the project's database password or secret key. The owner keeps them in `.env.local`.

