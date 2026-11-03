// The engine input for goal and proposal routes. The projection itself is WP-12's `loadEngineInput` in
// `@mp/db` (the only one, Q-111); this adds the HTTP mapping: 404 for a missing household, 409
// `plan_not_ready` (reason `no_primary_income` or `no_balance`) before onboarding is complete.
import { AppError } from "@mp/contracts";
import { loadEngineInput, type Tx } from "@mp/db";
import type { EngineInput } from "@mp/engine";

const NOT_READY = {
  no_primary_income: "Choose a primary income first.",
  no_balance: "Enter your current balance first.",
} as const;

/**
 * `requireBalance: false` is for goal reads, which don't depend on the balance. Shortfall options and
 * proposal effects require one (the default).
 */
export async function loadPlanInput(
  tx: Tx,
  householdId: string,
  nowIso: string,
  options: { requireBalance?: boolean } = {},
): Promise<EngineInput> {
  const loaded = await loadEngineInput(tx, householdId, { nowIso, requireBalance: options.requireBalance });
  if (!loaded) throw new AppError("not_found", 404, "Household not found.");
  if (!loaded.ready) {
    throw new AppError("plan_not_ready", 409, NOT_READY[loaded.reason], { reason: loaded.reason });
  }
  return loaded.input;
}
