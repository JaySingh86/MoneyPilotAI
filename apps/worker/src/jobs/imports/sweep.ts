// Jobs `imports.sweep` and `transactions.purge` (BACKEND_PLAN §7.7, §9).
//
// imports.sweep   every minute: the API cannot enqueue yet (no queue role, Q-105), so it marks an import
//                 `processing` and this job hands it to `imports.process` (singleton per import). It also finishes
//                 the clean-up of a finished import whose file is still stored. Households come from
//                 `app_list_household_ids()` (Q-051).
// transactions.purge  nightly: transactions older than 13 months are deleted (retention, BACKEND_PLAN §7.11).
import { householdToday, type WorkerDb } from "@mp/db";
import { windowStart } from "@mp/detection";
import type { JobSender } from "../plan/recompute";
import { IMPORTS_PROCESS_QUEUE, importsProcessSingletonKey } from "./process";
import * as repo from "./repo";

export const IMPORTS_SWEEP_QUEUE = "imports.sweep";
/** Every minute (the smallest pg-boss cron step). */
export const IMPORTS_SWEEP_CRON = "* * * * *";
export const TRANSACTIONS_PURGE_QUEUE = "transactions.purge";
/** 03:00 UTC every day. */
export const TRANSACTIONS_PURGE_CRON = "0 3 * * *";

export interface ImportsSweepDeps {
  db: WorkerDb;
  sender: JobSender;
}

export async function handleImportsSweep(
  deps: ImportsSweepDeps,
): Promise<{ households: number; enqueued: number }> {
  const ids = await deps.db.listHouseholdIds();
  let enqueued = 0;
  for (const householdId of ids) {
    const importIds = await deps.db.withJobTx(householdId, (tx) => repo.pendingImportIds(tx, householdId));
    for (const importId of importIds) {
      const job = { householdId, importId };
      const id = await deps.sender.send(IMPORTS_PROCESS_QUEUE, job, {
        singletonKey: importsProcessSingletonKey(job),
      });
      if (id !== null) enqueued++;
    }
  }
  return { households: ids.length, enqueued };
}

export interface TransactionsPurgeDeps {
  db: WorkerDb;
  /** UTC instant as ISO 8601. */
  now: () => string;
}

/** Deletes transactions older than the 13-month window for every household. Returns how many rows went. */
export async function handleTransactionsPurge(deps: TransactionsPurgeDeps): Promise<number> {
  let deleted = 0;
  for (const householdId of await deps.db.listHouseholdIds()) {
    deleted += await deps.db.withJobTx(householdId, async (tx) => {
      const timezone = await repo.householdTimezone(tx, householdId);
      if (!timezone) return 0;
      return repo.purgeOldTransactions(tx, householdId, windowStart(householdToday(deps.now(), timezone)));
    });
  }
  return deleted;
}
