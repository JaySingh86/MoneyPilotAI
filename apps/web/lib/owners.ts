"use client";

import type { OwnerRole, PartnerRole } from "@mp/ui";
import { useMemo } from "react";
import { useSummary } from "./api/hooks";

export interface Member {
  id: string;
  name: string;
  role: PartnerRole;
}

export interface Owners {
  members: readonly Member[];
  /** Who an owner id is; shared items (`both`, `split`) have no single member. */
  member: (ownerId: string) => Member | null;
  /** The color role for an owner id (§1 rule 5): the member's role, `both` for shared items. */
  role: (ownerId: string) => OwnerRole;
  /** "Sam", "Jordan", "Both". */
  label: (ownerId: string) => string;
  /** The household creator and the invited partner, in that order. */
  partnerA: Member | null;
  partnerB: Member | null;
}

/** Members of the active household, from the summary. `null` until it has loaded. */
export function useOwners(): Owners | null {
  const { data } = useSummary();
  return useMemo(() => {
    if (!data) return null;
    const members: Member[] = data.members.map((m) => ({
      id: m.userId,
      name: m.firstName,
      role: m.colorRole,
    }));
    const byId = new Map(members.map((m) => [m.id, m]));
    const member = (id: string): Member | null => byId.get(id) ?? null;
    return {
      members,
      member,
      role: (id) => member(id)?.role ?? "both",
      label: (id) => member(id)?.name ?? "Both",
      partnerA: members.find((m) => m.role === "partnerA") ?? null,
      partnerB: members.find((m) => m.role === "partnerB") ?? null,
    };
  }, [data]);
}
