// Goals, proposals and tasks (WP-13), registered as one entry in ../index.ts.
import { defineModule, type ApiModule } from "../../lib/module";
import { runtime, type RuntimeSource } from "../../auth/runtime";
import { createProposalsModule } from "../proposals";
import { createTasksModule } from "../tasks";
import { goalsRoutes } from "./routes";

export interface Wp13Options {
  /** UTC instant as ISO 8601. Default: the system clock. */
  now?: () => string;
}

export function createGoalsModule(source: RuntimeSource = runtime, options: Wp13Options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  return defineModule({ name: "goals", routes: goalsRoutes(() => ({ db: source().db, now })) });
}

/** Goals, proposals and tasks share one clock and runtime. */
export function createWp13Modules(
  source: RuntimeSource = runtime,
  options: Wp13Options = {},
): readonly ApiModule[] {
  return [
    createGoalsModule(source, options),
    createProposalsModule(source, options),
    createTasksModule(source, options),
  ];
}

export const wp13Modules = createWp13Modules();
