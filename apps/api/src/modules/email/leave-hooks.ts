// WP-05's leave transaction calls this (households/service.ts `LeaveHooks`): the leaver's mailbox connections are
// marked disconnected in the same transaction, so nothing of theirs keeps reading mail once they are gone. The
// worker (job `email.revoke`) then revokes at the provider, stops the watch and deletes the token. Runs before the
// membership ends, which the audit insert needs.
//
// The hook shape is declared here, not imported from households/service: that module imports this one (for the
// summary count), and a type import back would be a cycle. The shapes are structurally the same.
import type { Tx } from "@mp/db";
import { recordAudit } from "../identity/audit";
import * as repo from "./repo";

export interface LeaveHookSet {
  reassignOwnedItems(
    tx: Tx,
    input: { householdId: string; fromUserId: string; toUserId: string },
  ): Promise<void>;
  revokeEmailConnections(tx: Tx, input: { householdId: string; userId: string }): Promise<void>;
}

export const emailLeaveHooks: LeaveHookSet = {
  async reassignOwnedItems() {},
  async revokeEmailConnections(tx, input) {
    const ids = await repo.revokeAllOf(tx, input.householdId, input.userId);
    for (const id of ids) {
      await recordAudit(tx, {
        householdId: input.householdId,
        actorUserId: input.userId,
        action: "email.disconnected",
        entityType: "email_connection",
        entityId: id,
        metadata: { reason: "left_household" },
      });
    }
  },
};

/** Runs every hook set in order. */
export function combineLeaveHooks(...sets: readonly LeaveHookSet[]): LeaveHookSet {
  return {
    async reassignOwnedItems(tx, input) {
      for (const s of sets) await s.reassignOwnedItems(tx, input);
    },
    async revokeEmailConnections(tx, input) {
      for (const s of sets) await s.revokeEmailConnections(tx, input);
    },
  };
}
