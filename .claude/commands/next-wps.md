---
description: Orchestrator view — which MoneyPilot work packages can start now, and which can run in parallel
---

Read the status table and work package entries in `docs/agents/WORK_PLAN.md`.

1. List the work packages that are `todo` and whose dependencies are all `done`.
2. Group them into a set that can run in parallel, at most 4 at a time. Members of a set must not overlap in "Owns" paths and must not depend on each other. Prefer packages on the critical path to WP-26.
3. For each work package in the set, give the branch and worktree commands, for example `git worktree add ../mp-wp07 -b wp/07-engine-rules`, plus the `/start-wp` line.
4. List every work package that is `in-progress` or `in-review` for longer than its size suggests, and every `blocked` package with its reason.
5. Name any human gate (G1–G4) that is now due.

Don't change any files.
