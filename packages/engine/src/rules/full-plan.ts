// The full plan (BACKEND_PLAN §7.2 PlanResult): the core plan (rules 1–5, 7) plus rule 8 flags, the ranked
// "Decide this week" cards and, in a shortfall, the ways to cover the gap.
import { computePlan } from "../plan";
import type { EngineInput, FullPlanResult } from "../types";
import { decisions } from "./decisions";
import { ruleFlags, sortFlags } from "./flags";
import { shortfallOptions } from "./shortfall";

export function computeFullPlan(input: EngineInput): FullPlanResult {
  const core = computePlan(input);
  const flagList = sortFlags([...core.flags, ...ruleFlags(input, core.window)]);
  return {
    ...core,
    flags: flagList,
    decisions: decisions(input, core, flagList),
    shortfallOptions: shortfallOptions(input, core),
  };
}
