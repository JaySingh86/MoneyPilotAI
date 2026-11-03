// Planning module (WP-12): the plan, what-if, calendar, renewals and bills averages. The database comes
// from the shared API runtime (`configureRuntime` at startup), resolved on each request, so registration
// does no I/O and the one pool is closed by the app that owns it.
import { runtime, type RuntimeSource } from "../../auth/runtime";
import { defineModule } from "../../lib/module";
import { planningRoutes } from "./routes";

export interface PlanningModuleOptions {
  /** UTC instant as ISO 8601. Default: the system clock. */
  now?: () => string;
}

export function createPlanningModule(source: RuntimeSource = runtime, options: PlanningModuleOptions = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  return defineModule({
    name: "planning",
    routes: planningRoutes(() => ({ db: source().db, now })),
  });
}

export const planningModule = createPlanningModule();
