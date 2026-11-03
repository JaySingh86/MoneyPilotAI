// WP-05's leave transaction calls these (households/service.ts `LeaveHooks`). The leaver's items and planned
// expenses go to the remaining member so every owner stays a current member (BACKEND_PLAN §6).
import type { LeaveHooks } from "../households/service";
import { noopLeaveHooks } from "../households/service";
import * as repo from "./repo";

export const itemsLeaveHooks: LeaveHooks = {
  ...noopLeaveHooks,
  async reassignOwnedItems(tx, input) {
    await repo.reassignOwner(tx, input.householdId, input.fromUserId, input.toUserId);
  },
};
