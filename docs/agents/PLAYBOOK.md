# Agent playbook: how we build MoneyPilot with coding agents

## 1. Roles

| Role | Who | Responsibilities |
|---|---|---|
| **Tech lead** | Human | Makes the decisions in BACKEND_PLAN §17, approves gates G1–G4, merges PRs, answers `QUESTIONS.md`, owns specs |
| **Orchestrator** | An agent session run by the tech lead (`/next-wps`) | Reads WORK_PLAN status, proposes the next WPs whose dependencies are done and whose owned paths don’t overlap, prepares kickoff prompts |
| **Builders** | One agent per WP (`wp-builder` subagent or a top-level session via `/start-wp`) | Implement exactly one WP in its own branch or worktree |
| **Reviewers** | `spec-reviewer`, `security-reviewer`, `ui-fidelity-reviewer` subagents (`/review-wp`) | Independent review of each PR against the specs and hard rules |
| **CI** | GitHub Actions | The authoritative gate: tests, RLS coverage, dependency rules, drift, lint |

## 2. Setup once
1. Finish H-01 in WORK_PLAN.md.
2. The repo contains `CLAUDE.md`, `docs/**`, `design/**`, `.claude/agents/**` and `.claude/commands/**`.
3. Each builder works in a separate worktree so parallel agents never share a working directory:
   ```bash
   git worktree add ../mp-wp07 -b wp/07-engine-rules
   cd ../mp-wp07 && claude          # then: /start-wp WP-07
   ```
4. Give agents dev and staging credentials only (`.env.local` from `.env.example`). Never give them production access.

## 3. The loop for one work package
1. **Pick:** run `/next-wps` (or choose from WORK_PLAN). Set the status to `in-progress (agent, branch)`.
2. **Kick off:** run `/start-wp WP-xx` in the WP’s worktree. The builder reads CLAUDE.md, the WP and its “Read first” sections, then posts a short plan.
3. **Check the plan (human, 2 minutes):** are the files inside the owned paths? Are the tests listed? Correct it now; it’s cheap.
4. **Build:** the builder implements test-first for logic and runs the checks.
5. **Self-review:** the builder runs `/review-wp`. The reviewers return findings; the builder fixes every **blocking** one and lists the rest.
6. **PR:** the builder opens a PR with the template, its acceptance checklist and test output. CI runs.
7. **Human review:** the tech lead reads the PR summary, reviewer findings and CI results, and spot-checks the riskiest file. Gate WPs need explicit approval.
8. **Merge:** squash-merge, set the WP to `done`, remove the worktree.

## 4. Parallelism rules
- At most **3–4 builders at once**. Beyond that, review becomes the bottleneck.
- Run two WPs in parallel only if their **owned paths are disjoint** and neither depends on the other.
- Shared files:
  - Root `package.json` / `pnpm-lock.yaml`: add dependencies only in your WP’s own package where possible. On a lockfile conflict, rebase and run `pnpm install`.
  - **Migrations:** timestamped file names (ADR-015). Never renumber.
  - **Contracts:** one file per module under `packages/contracts/src/<module>/`. Regenerate the client after a rebase (`pnpm contracts:gen`).
  - Module registry in `apps/api/src/modules/index.ts`: append-only, one line per module.
- Frontend WPs start early using the generated client plus MSW mocks built from the golden fixture.

## 5. Kickoff prompt (used by `/start-wp`; for a manual run, copy and fill in)

```
You are implementing work package {WP-ID} for MoneyPilot.
1. Read CLAUDE.md fully. Follow every hard rule.
2. Read docs/agents/WORK_PLAN.md → {WP-ID}, then every section listed under "Read first".
3. Post a plan: files you'll create/change (must be inside "Owns"), tests you'll write, open questions.
4. Implement test-first for any calculation or rule. Use the golden fixture where it applies.
5. Run: pnpm lint && pnpm typecheck && pnpm test (+ test:rls if DB, + e2e if UI flows).
6. Run /review-wp and fix blocking findings.
7. Write the PR description from .github/pull_request_template.md, ticking only boxes you verified.
If a spec is ambiguous or contradictory, add it to docs/agents/QUESTIONS.md and continue with the rest.
```

## 6. Definition of done (every WP)
- [ ] Every acceptance criterion in the WP is verified, with evidence in the PR (test names or output).
- [ ] `lint`, `typecheck`, `test` pass; `test:rls` passes if any table changed; `contracts:gen --check` is clean.
- [ ] No hard-rule violations (reviewer agents report none blocking).
- [ ] New config keys are added to `.env.example`; new decisions are recorded as an ADR in DECISIONS.md.
- [ ] Docs are updated where behavior differs from the spec, **only** with tech-lead approval.
- [ ] WORK_PLAN status is updated.

## 7. Human gates

| Gate | When | The tech lead checks |
|---|---|---|
| **G1** | After WP-03, WP-05, WP-06 | RLS policies and tests on every table, roles and grants, auth step-up, invite flow, migration safety |
| **G2** | Before real inboxes, real credentials or AWS changes (WP-09, 20, 21, 24, 31) | Token encryption and IAM, OAuth scopes and consent copy, webhook verification, deletion completeness, cdk-nag output |
| **G3** | Before AI output reaches users (WP-11, 22, 27, 28) | Prompt text, eval report against the gates, injection corpus results, the auto-apply policy table, number validator |
| **G4** | Before pilot households (WP-26) | DESIGN_SPEC §9 checklist on every screen, E2E, load results, alerts, runbooks, compliance checklist (BACKEND_PLAN §11) |

## 8. What agents must not do
- Change `design/fixtures/**`, golden expected values, `docs/DESIGN_SPEC.md`, `docs/BACKEND_PLAN.md`, or accepted ADRs without tech-lead approval. Use `QUESTIONS.md` instead.
- Disable, skip or weaken tests or lint rules to get green. Broaden an RLS policy. Add a `household_id` table without RLS.
- Touch `infra/` outside WP-09/26, apply infrastructure, or use production credentials.
- Add AI calls outside `packages/ai`, or send unredacted email text to any model.
- Add a payment or transfer capability of any kind.

## 9. Keeping specs and code in sync
- A spec change flows **canvas → DESIGN_SPEC → fixture → tests → code**, in one PR led by the tech lead.
- A question an agent raises is answered in `QUESTIONS.md`. If the answer changes the spec, the tech lead updates the spec first, then the WP continues.

## 10. Tracking and metrics
- One GitHub issue per WP (title `WP-xx · …`, body copied from WORK_PLAN). The PR closes the issue.
- Track per WP: sessions used, review rounds, blocking findings, CI failures after the PR opened. Raise recurring issues as a new hard rule or CI check rather than repeating them in reviews.
