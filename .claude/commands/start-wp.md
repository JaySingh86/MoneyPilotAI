---
description: Start a MoneyPilot work package (e.g. /start-wp WP-07)
argument-hint: WP-xx
---

Start work package $ARGUMENTS.

1. Read `CLAUDE.md` in full.
2. In `docs/agents/WORK_PLAN.md`, find $ARGUMENTS. Check that every dependency in the status table is `done`. If one isn't, stop and say which dependencies are missing.
3. Read every section the work package lists under "Read first".
4. Post a plan covering the files to create or change (all inside "Owns"), the tests to write first, and any open questions. Then wait for a go-ahead before writing code, unless I said to proceed without one.
5. After the go-ahead, implement the package following CLAUDE.md "How to work a package". Run the checks, then run /review-wp, fix blocking findings, and draft the PR description from `.github/pull_request_template.md`.
6. In the status table, set $ARGUMENTS to `in-review` in the same branch.
