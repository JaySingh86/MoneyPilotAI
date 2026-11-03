import { defineModule } from "../../lib/module";
import { runtime, type RuntimeSource } from "../../auth/runtime";
import { householdRoutes } from "./routes";
import { itemsLeaveHooks } from "../items/leave-hooks";
import { tasksSummaryBadges } from "../tasks/badges";
import type { LeaveHooks, SummaryBadges } from "./service";

/** `/v1/households` and `/v1/invites`: households, summary, invites, leave. */
export function createHouseholdsModule(
  source: RuntimeSource = runtime,
  hooks: LeaveHooks = itemsLeaveHooks,
  badges: SummaryBadges = tasksSummaryBadges(),
) {
  return defineModule({ name: "households", routes: householdRoutes(source, hooks, badges) });
}

export const householdsModule = createHouseholdsModule();
export type { LeaveHooks, SummaryBadges } from "./service";
