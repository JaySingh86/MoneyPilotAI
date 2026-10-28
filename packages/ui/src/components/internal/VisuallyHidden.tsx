import type { ReactNode } from "react";
import shared from "./shared.module.css";

/** Content announced by screen readers but not drawn. */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className={shared.visuallyHidden}>{children}</span>;
}
