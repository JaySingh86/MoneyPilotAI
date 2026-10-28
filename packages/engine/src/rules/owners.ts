// Rule 13: a partner's filter includes their own items plus items owned by Both (and Split, which both
// partners share 50/50). No filter shows everything.
import { OWNER_BOTH, OWNER_SPLIT } from "../types";
import type { OwnerKey } from "../types";

export function ownerMatches(owner: OwnerKey, filter: OwnerKey | null): boolean {
  return filter === null || owner === filter || owner === OWNER_BOTH || owner === OWNER_SPLIT;
}
