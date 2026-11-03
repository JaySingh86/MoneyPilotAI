// @mp/review-rules: the pure auto-apply policy (decide) and apply planning for the review queue. Imports only
// types from @mp/contracts, so the API and the worker run the same rules (enforced by dependency-cruiser).
export const PACKAGE = "@mp/review-rules";
export { AUTO_APPLY_TOLERANCE_PERCENT, decideExtraction } from "./decide";
export type {
  AutoApplyChange,
  DecideInput,
  DecideOutcome,
  Decision,
  ExpectedItem,
  ExpectedRenewal,
  ReviewReason,
} from "./decide";
export { itemFromFields, planAutoApply, planUpdate, snapshotMatches } from "./apply";
export type { AutoApplyPlan, NewItemResult, PlanItem, UpdatePlan } from "./apply";
