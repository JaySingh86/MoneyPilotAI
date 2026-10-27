---
description: Run the independent reviewers on the current branch and summarize blocking findings
---

Review the current branch against `main`.

1. Run `git diff --stat main...HEAD` to see which areas changed.
2. Launch these reviewers in parallel:
   - `spec-reviewer`: always.
   - `security-reviewer`: if the diff touches `packages/db`, `apps/api`, `apps/worker`, `packages/email`, `packages/ai`, `packages/crypto`, or `infra`.
   - `ui-fidelity-reviewer`: if the diff touches `apps/web`, `apps/mobile`, or `packages/ui`.
3. Merge their findings into one list, deduplicated and ordered by severity, with `file:line` for each.
4. List the blocking findings first, then the rest. For each blocking finding, say whether you will fix it now. If you are the builder for this branch, fix them, re-run the affected tests, and re-run this review once.
