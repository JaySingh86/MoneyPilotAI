// Items module (WP-06): recurring items, renewals, occurrences, planned expenses, balances.
import { defineModule } from "../../lib/module";
import { runtime, type RuntimeSource } from "../../auth/runtime";
import { itemsRoutes } from "./routes";

export interface ItemsModuleOptions {
  /** UTC instant as ISO 8601. Default: the system clock. */
  now?: () => string;
}

/**
 * The database comes from the shared API runtime (`configureRuntime` at startup), resolved on each request,
 * so registration does no I/O and the one pool is closed by the app that owns it.
 */
export function createItemsModule(source: RuntimeSource = runtime, options: ItemsModuleOptions = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  return defineModule({
    name: "items",
    routes: itemsRoutes(() => ({ db: source().db, now })),
  });
}

export const itemsModule = createItemsModule();
export { itemsLeaveHooks } from "./leave-hooks";
