import { Compass } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./auth.module.css";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className={styles.page}>
      <div className={styles.brand}>
        <span className={styles.logo} aria-hidden="true">
          <Compass size={20} strokeWidth={2} />
        </span>
        <h1 className={styles.wordmark}>MoneyPilot</h1>
      </div>
      {children}
    </main>
  );
}
