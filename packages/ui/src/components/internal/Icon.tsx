import type { LucideIcon } from "lucide-react";

/** Lucide icon sizes from DESIGN_SPEC §2.4. */
export type IconSize = 16 | 18 | 20 | 22;

export interface IconProps {
  icon: LucideIcon;
  /** 16 inline in buttons, 18 sidebar nav, 20 header buttons and mobile lists, 22 tab bar. */
  size?: IconSize;
  className?: string;
}

/** A decorative Lucide icon: stroke 1.8, round caps, currentColor, hidden from screen readers. */
export function Icon({ icon: Glyph, size = 16, className }: IconProps) {
  return (
    <Glyph
      size={size}
      strokeWidth={1.8}
      absoluteStrokeWidth={false}
      aria-hidden="true"
      focusable="false"
      className={className}
    />
  );
}
