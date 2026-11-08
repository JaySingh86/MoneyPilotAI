"use client";

import { Avatar, AvatarStack } from "@mp/ui";
import type { AvatarSize } from "@mp/ui";
import type { Owners } from "../owners";
import styles from "./owner-cell.module.css";

/**
 * An owner's avatar and first name. Items owned by Both show both avatars stacked (S + J), or with
 * `combined` one circle reading "S+J", as the Household tasks board draws it.
 */
export function OwnerCell({
  ownerId,
  owners,
  size = 24,
  showName = true,
  combined = false,
}: {
  ownerId: string;
  owners: Owners;
  size?: AvatarSize;
  showName?: boolean;
  combined?: boolean;
}) {
  const member = owners.member(ownerId);
  const name = owners.label(ownerId);
  const initials = [owners.partnerA, owners.partnerB]
    .map((m) => [...(m?.name.trim() ?? "")][0]?.toUpperCase() ?? "")
    .filter(Boolean)
    .join("+");
  return (
    <span className={styles.cell}>
      {member ? (
        <Avatar name={member.name} role={member.role} size={size} decorative={showName} />
      ) : combined ? (
        <Avatar name="Both" role="both" initials={initials} size={size} decorative={showName} />
      ) : (
        <AvatarStack label={showName ? undefined : "Both"} ring="surface">
          {owners.partnerA && <Avatar name={owners.partnerA.name} role="partnerA" size={size} decorative />}
          {owners.partnerB && <Avatar name={owners.partnerB.name} role="partnerB" size={size} decorative />}
        </AvatarStack>
      )}
      {showName && name}
    </span>
  );
}
