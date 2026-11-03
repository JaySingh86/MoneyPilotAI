// Tasks module (WP-13): household tasks, the Tasks screen groups and the nav badge.
import { defineModule } from "../../lib/module";
import { runtime, type RuntimeSource } from "../../auth/runtime";
import { tasksRoutes } from "./routes";

export function createTasksModule(source: RuntimeSource = runtime, options: { now?: () => string } = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  return defineModule({ name: "tasks", routes: tasksRoutes(() => ({ db: source().db, now })) });
}

export const tasksModule = createTasksModule();
export { navBadge } from "./service";
