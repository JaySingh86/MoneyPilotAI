// Buttons, DESIGN_SPEC §4. There is never a "Pay", "Transfer" or "Send money" button (rule 2).
import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../internal/cx";
import { Icon } from "../internal/Icon";
import styles from "./button.module.css";

/**
 * - `web`: height 40. `compact`: the 36 px buttons in attention cards, with a 44 px hit area.
 * - `mobile`: height 46 inline. `mobileBar`: height 50, full width, for the bottom action bar.
 */
export type ButtonSize = "web" | "compact" | "mobile" | "mobileBar";

type NativeButton = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;

interface CommonProps extends NativeButton {
  size?: ButtonSize;
  /** A 16 px leading icon (gap 8). */
  icon?: LucideIcon;
}

export type ButtonProps = CommonProps &
  (
    | {
        variant?: "primary" | "text";
        children: ReactNode;
      }
    | {
        variant: "secondary";
        /** Page-header secondary buttons use `border.default` instead of `border.strong`. */
        inHeader?: boolean;
        children: ReactNode;
      }
    | {
        /**
         * Secondary size with a 1 px text.primary border. Never red or amber. It always opens a
         * confirm dialog, so the label must end in "…" ("Delete household…"); the type enforces it.
         */
        variant: "destructive";
        label: `${string}…`;
        children?: never;
      }
  );

export function Button(props: ButtonProps) {
  const { variant = "primary", size = "web", icon, className, type = "button", children, ...rest } = props;
  const inHeader = props.variant === "secondary" ? props.inHeader : undefined;
  const label = props.variant === "destructive" ? props.label : undefined;
  const native: NativeButton & { inHeader?: boolean; label?: string } = rest;
  delete native.inHeader;
  delete native.label;
  return (
    <button
      type={type}
      className={cx(styles.button, styles[variant], styles[size], inHeader && styles.inHeader, className)}
      {...native}
    >
      {icon && <Icon icon={icon} size={16} />}
      {label ?? children}
    </button>
  );
}

export interface IconButtonProps extends Omit<NativeButton, "aria-label"> {
  icon: LucideIcon;
  /** Required: icon-only buttons are named by their aria-label. */
  label: string;
  /** `web`: 44 × 40. `mobile`: 44 × 44 circle. */
  shape?: "web" | "mobile";
  /** An 8 px attention.mark dot with a 2 px white ring. Say what it means in `label`. */
  notification?: boolean;
}

export function IconButton({
  icon,
  label,
  shape = "web",
  notification = false,
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      className={cx(styles.iconButton, styles[`icon-${shape}`], className)}
      {...rest}
    >
      <Icon icon={icon} size={18} />
      {notification && <span className={styles.dot} aria-hidden="true" data-notification-dot="" />}
    </button>
  );
}
