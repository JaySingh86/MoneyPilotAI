## Work package
WP-__ · <title> ([WORK_PLAN](../docs/agents/WORK_PLAN.md))

## What changed
-

## Acceptance criteria
<!-- Copy the WP's acceptance list. Tick only what you verified, and cite the test name or output for each. -->
- [ ]

## Checks
- [ ] `pnpm lint && pnpm typecheck && pnpm test`
- [ ] `pnpm test:rls` (if any table or policy changed)
- [ ] `pnpm contracts:gen --check` (if contracts changed)
- [ ] `pnpm e2e` (if a UI flow changed)
- [ ] `pnpm ai:eval` results attached (if a prompt or schema changed)

## Hard rules (CLAUDE.md)
- [ ] Money in integer cents · bill dates as PlainDate
- [ ] Every new household table has forced RLS + a cross-tenant test
- [ ] Numbers come from the engine only · no AI calls outside `packages/ai`
- [ ] No money movement · tokens-only UI · no PII in logs · no secrets
- [ ] No changes to fixtures, golden values, or specs

## Reviewer agents
- spec-reviewer: <!-- verdict -->
- security-reviewer: <!-- verdict or n/a -->
- ui-fidelity-reviewer: <!-- verdict or n/a -->

## Cross-WP changes
<!-- Files changed outside this WP's owned paths, and why. -->
None

## Unverified or skipped
<!-- What you didn't verify, and why. Questions added to docs/agents/QUESTIONS.md. -->
None

## Gate
<!-- G1/G2/G3/G4 or none -->
