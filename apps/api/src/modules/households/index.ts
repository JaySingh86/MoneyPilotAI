import { defineModule } from "../../lib/module";
import { runtime, type RuntimeSource } from "../../auth/runtime";
import { householdRoutes } from "./routes";
import { itemsLeaveHooks } from "../items/leave-hooks";
import type { LeaveHooks } from "./service";

/** `/v1/households` and `/v1/invites`: households, summary, invites, leave. */
export function createHouseholdsModule(source: RuntimeSource = runtime, hooks: LeaveHooks = itemsLeaveHooks) {
  return defineModule({ name: "households", routes: householdRoutes(source, hooks) });
}

export const householdsModule = createHouseholdsModule();
export type { LeaveHooks } from "./service";
