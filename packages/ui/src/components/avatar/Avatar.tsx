// Avatar and owner dot, DESIGN_SPEC §4. Colors come from the member's role (§1 rule 5).
import type { ReactNode } from "react";
import { cx } from "../internal/cx";
import type { OwnerRole } from "../internal/types";
import styles from "./avatar.module.css";

/** 32 header, 28 lists, 24 table, 22 activity, 40 members card. */
export type AvatarSize = 22 | 24 | 28 | 32 | 40;

export interface AvatarProps {
  /** First name; the avatar shows its initial. */
  name: string;
  /** `both` is one circle in brand colors, for items two people own ("S+J" in Household tasks). */
  role: OwnerRole;
  /** Text to draw instead of the first letter of `name`, e.g. "S+J". */
  initials?: string;
  size?: AvatarSize;
  /** Hide from screen readers when the name is already written next to it. */
  decorative?: boolean;
  className?: string;
}

export function Avatar({ name, role, initials, size = 28, decorative = false, className }: AvatarProps) {
  const initial = initials ?? [...name.trim()][0]?.toUpperCase() ?? "";
  const long = [...initial].length > 1;
  return (
    <span
      className={cx(styles.avatar, styles[role], styles[`size${size}`], long && styles.long, className)}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name })}
    >
      {initial}
    </span>
  );
}

export interface AvatarStackProps {
  /** Two or more `Avatar`s, e.g. S + J for items owned by Both. */
  children: ReactNode;
  /** Accessible name for the group, e.g. "Sam and Jordan". Hides the individual avatars. */
  label?: string;
  /** Overlap −8 (sizes up to 28) or −10 (32 and up). */
  overlap?: "sm" | "md";
  /** The 2 px ring matches the background the stack sits on. */
  ring?: "surface" | "canvas" | "subtle" | "tint";
  className?: string;
}

export function AvatarStack({
  children,
  label,
  overlap = "sm",
  ring = "surface",
  className,
}: AvatarStackProps) {
  return (
    <span
      className={cx(styles.stack, overlap === "md" && styles.stackMd, styles[`ring-${ring}`], className)}
      {...(label ? { role: "img", "aria-label": label } : {})}
    >
      {children}
    </span>
  );
}

export interface OwnerDotProps {
  role: OwnerRole;
  /** 7 on web chips and legends, 6 on mobile calendar cells, 10 in mobile day lists. */
  size?: 6 | 7 | 10;
  className?: string;
}

/** A decorative dot in the owner's mark color. The owner's name is always written nearby. */
export function OwnerDot({ role, size = 7, className }: OwnerDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cx(styles.dot, styles[`dot-${role}`], styles[`dot${size}`], className)}
    />
  );
}
