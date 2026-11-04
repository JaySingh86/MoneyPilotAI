"use client";

import { Avatar, AvatarStack } from "@mp/ui";
import type { AvatarSize } from "@mp/ui";
import type { Owners } from "../owners";
import styles from "./owner-cell.module.css";

/** An owner's avatar and first name; items owned by Both show both avatars stacked (S + J). */
export function OwnerCell({
  ownerId,
  owners,
  size = 24,
  showName = true,
}: {
  ownerId: string;
  owners: Owners;
  size?: AvatarSize;
  showName?: boolean;
}) {
  const member = owners.member(ownerId);
  const name = owners.label(ownerId);
  return (
    <span className={styles.cell}>
      {member ? (
        <Avatar name={member.name} role={member.role} size={size} decorative={showName} />
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
