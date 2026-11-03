// Review module (WP-14): the review queue, applied changes and undo, sender rules. The pure auto-apply policy
// and apply planning live in @mp/review-rules, shared with the worker.
import { defineModule } from "../../lib/module";
import { runtime, type RuntimeSource } from "../../auth/runtime";
import { reviewRoutes } from "./routes";

export interface ReviewModuleOptions {
  /** UTC instant as ISO 8601. Default: the system clock. */
  now?: () => string;
}

export function createReviewModule(source: RuntimeSource = runtime, options: ReviewModuleOptions = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  return defineModule({
    name: "review",
    routes: reviewRoutes(() => ({ db: source().db, now })),
  });
}

export const reviewModule = createReviewModule();
export { hasPriorDecidedFromSender } from "./repo";
