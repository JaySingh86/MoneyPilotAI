// Bills & recurring averages (DESIGN_SPEC §6 rule 17), computed by the engine from the projected input.
// Lives here, next to the projection, so the items list can include them in its own transaction without
// importing another API module. Needs neither a primary income nor a balance.
import { billsAverages, type BillsAverages } from "@mp/engine";
import type { Tx } from "../tx";
import { loadEngineInput } from "./engine-input";

export async function loadBillsAverages(
  tx: Tx,
  householdId: string,
  nowIso: string,
): Promise<BillsAverages | null> {
  const loaded = await loadEngineInput(tx, householdId, { nowIso, lenient: true });
  if (!loaded || !loaded.ready) return null;
  return billsAverages(loaded.input);
}
