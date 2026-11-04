// Switches for the mock API: which household scenario it serves, plus faults and delays for testing
// the loading and error states. Read from the URL (`?scenario=shortfall`) and kept for the tab.
import type { Scenario } from "./model";

export type FaultTarget = "plan" | "calendar" | "me" | "summary";

export interface MockState {
  scenario: Scenario;
  /** Added to every planning response, to see the loading state. */
  delayMs: number;
  faults: Set<FaultTarget>;
  /** Times `POST /me/bootstrap` was called (WP-17: after sign-in and every token refresh). */
  bootstrapCalls: number;
}

const SCENARIO_KEY = "mp.mock.scenario";
const SCENARIOS: readonly Scenario[] = ["base", "shortfall", "empty"];
const TARGETS: readonly FaultTarget[] = ["plan", "calendar", "me", "summary"];

export const state: MockState = { scenario: "base", delayMs: 0, faults: new Set(), bootstrapCalls: 0 };

const listeners = new Set<() => void>();

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setScenario(scenario: Scenario): void {
  state.scenario = scenario;
  try {
    window.sessionStorage.setItem(SCENARIO_KEY, scenario);
  } catch {
    // Private mode: the scenario lasts until reload.
  }
  listeners.forEach((l) => l());
}

export function setFault(target: FaultTarget, on: boolean): void {
  if (on) state.faults.add(target);
  else state.faults.delete(target);
  listeners.forEach((l) => l());
}

function asScenario(value: string | null): Scenario | null {
  return SCENARIOS.find((s) => s === value) ?? null;
}

/** Reads `?scenario=`, `?mockDelay=` and `?mockFault=plan,calendar` (and the tab's saved scenario). */
export function initFromLocation(location: Location): void {
  const params = new URLSearchParams(location.search);
  let saved: string | null = null;
  try {
    saved = window.sessionStorage.getItem(SCENARIO_KEY);
  } catch {
    saved = null;
  }
  state.scenario = asScenario(params.get("scenario")) ?? asScenario(saved) ?? "base";
  state.delayMs = Number(params.get("mockDelay") ?? 0) || 0;
  for (const target of (params.get("mockFault") ?? "").split(",")) {
    const match = TARGETS.find((t) => t === target);
    if (match) state.faults.add(match);
  }
}
