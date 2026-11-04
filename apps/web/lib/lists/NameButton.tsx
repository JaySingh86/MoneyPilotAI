import type { ReactNode } from "react";
import styles from "./lists.module.css";

/** A table row's name: a button that selects the row for the detail aside (`aria-pressed`). */
export function NameButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={styles.nameButton} aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  );
}
