"use client";

import { ErrorBanner, Loading, Skeleton } from "@mp/ui";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { AppShell } from "../../lib/components/AppShell";
import { FirstNameForm } from "../../lib/components/FirstNameForm";
import { useAuth } from "../../lib/auth/AuthProvider";
import styles from "./app.module.css";

/** Everything under (app) needs a signed-in, bootstrapped user. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { status, refresh } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "signed_out") router.replace("/sign-in");
  }, [status, router]);

  if (status === "loading" || status === "signed_out") {
    return (
      <div className={styles.center}>
        <Loading label="Loading MoneyPilot">
          <Skeleton width="60%" />
          <Skeleton shape="block" />
        </Loading>
      </div>
    );
  }
  if (status === "needs_name") {
    return (
      <div className={styles.center}>
        <FirstNameForm />
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className={styles.center}>
        <ErrorBanner title="We couldn’t finish signing you in." onRetry={() => void refresh()}>
          Your plan is safe. Check your connection and try again.
        </ErrorBanner>
      </div>
    );
  }
  return <AppShell>{children}</AppShell>;
}
