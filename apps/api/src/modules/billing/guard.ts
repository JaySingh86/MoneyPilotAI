// The entitlement gate for Plus endpoints (BACKEND_PLAN §7.10). Other modules add it to a route as
// `preHandler: requireEntitlement(() => db, "goals")`. Reads always pass (a downgrade makes Plus features
// read-only and never hides data); a write on a household whose plan cannot write that feature answers
// 403 `entitlement_required`. Which features are Plus is `DEFAULT_ENTITLEMENT_CONFIG` in @mp/billing, not this file (Q-150).
import type { FastifyRequest } from "fastify";
import { canWrite, type Feature } from "@mp/billing";
import { AppError } from "@mp/contracts";
import type { ApiDb, Tx } from "@mp/db";
import { dbContext } from "../../plugins/request-context";
import { getPlan } from "./repo";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface EntitlementSource {
  db: ApiDb;
}

export function requireEntitlement(source: () => EntitlementSource, feature: Feature) {
  return async function entitlementGuard(request: FastifyRequest): Promise<void> {
    if (SAFE_METHODS.has(request.method)) return;
    const householdId = request.ctx.householdId;
    if (!householdId) return;
    const { db } = source();
    const plan = await db.withHouseholdTx(dbContext(request), (tx) => getPlan(tx, householdId));
    // `plan` is null only when RLS hides the household: the caller is not a member, or it does not exist.
    // Returning is safe because every route that carries this guard reads or writes through
    // `withHouseholdTx` under the same RLS, which finds nothing and answers for itself (404/403). Nothing
    // here ever lets a non-member through to data; the guard only ever adds a refusal.
    if (!plan) return;
    if (!canWrite(plan, feature)) {
      throw new AppError("entitlement_required", 403, "This feature needs Family Plus.");
    }
  };
}

/**
 * The same check inside a transaction, for writes that reach a Plus feature through another door (a
 * proposal being created or approved). Throws 403 `entitlement_required` when the household's plan cannot
 * write `feature`; a household RLS hides is left to the caller's own not-found handling.
 */
export async function assertCanWrite(tx: Tx, householdId: string, feature: Feature): Promise<void> {
  if (!(await canWriteFeature(tx, householdId, feature))) {
    throw new AppError("entitlement_required", 403, "This feature needs Family Plus.");
  }
}

/** True unless the household is on a plan that cannot write `feature`. */
export async function canWriteFeature(tx: Tx, householdId: string, feature: Feature): Promise<boolean> {
  const plan = await getPlan(tx, householdId);
  return plan === null || canWrite(plan, feature);
}
