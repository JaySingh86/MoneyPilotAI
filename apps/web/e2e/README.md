# Web end-to-end, accessibility and visual tests

Playwright runs against `next dev` in **mock mode**: MSW answers the API from the golden fixture
(`design/fixtures/rivera-household.json`, through the engine) and a fake Cognito session is signed
in. No AWS and no network.

| Spec             | What it checks                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flows.spec.ts`  | Golden values, the See the math sheet, owner filter, calendar keyboard movement, sign-in, MFA, `POST /me/bootstrap` after sign-in and token refresh |
| `a11y.spec.ts`   | axe (WCAG 2.2 AA, color contrast on) on every screen and state at 1440 and 390                                                                      |
| `visual.spec.ts` | Full-page snapshots at 1440, 1024 and 390, and no horizontal page scroll                                                                            |

WP-18 adds `lists-flows.spec.ts` (Bills, Renewals, Goals, Tasks golden values, the goal stepper and approval,
saving a task), `lists-a11y.spec.ts` (axe, including the error states) and `lists-visual.spec.ts` (snapshots in
`__screenshots__/lists-visual.spec.ts/`: `bills`, `renewals`, `goals` and `tasks` at 1440, 1024 and 390, matching the
canvas boards Web · Bills & recurring, Subscriptions & renewals, Goals & planned expenses and Household tasks).
Set `MP_E2E_PORT` to run against a dev server on another port.

Screenshots in `__screenshots__/visual.spec.ts/` sit next to the canvas frames they match:

| Snapshot                                 | Canvas board                           |
| ---------------------------------------- | -------------------------------------- |
| `overview-base-{1440,1024,390}.png`      | Web · Overview (before payday)         |
| `overview-shortfall-{1440,1024,390}.png` | Web · Safe-to-spend states (shortfall) |
| `calendar-base-{1440,1024,390}.png`      | Web · Shared bills calendar            |

## Commands

```bash
pnpm --filter @mp/web e2e:docker    # run the whole suite in the pinned Playwright image (Colima/Docker)
pnpm --filter @mp/web e2e:update    # regenerate the baselines in that image
pnpm e2e                            # same suite with a local browser (CI uses this inside the image)
```

With Colima: `DOCKER_HOST=unix:///Users/<you>/.colima/default/docker.sock`.

For a quick look with a browser you already have, run the non-visual specs with
`MP_E2E_CHROMIUM=/path/to/chrome pnpm --filter @mp/web exec playwright test e2e/flows.spec.ts e2e/a11y.spec.ts`.

## Baselines are arm64

The committed baselines were rendered by the Linux arm64 Playwright image on Apple Silicon.
Chromium's text and anti-aliasing differ slightly on x86, so CI runs the `visual` and `web-e2e`
jobs on an arm64 runner (`ubuntu-24.04-arm`). If CI has to run on x86, regenerate the baselines
there (`packages/ui` and `apps/web`) and commit them.

## Test data switches (mock mode only)

`?scenario=base|shortfall|empty`, `?mockDelay=1500`, `?mockFault=plan,calendar`, `?devbar=0`
(hides the mock toolbar). In the browser console, `window.__mpMock` exposes the same switches.
