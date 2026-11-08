"use client";

import { ErrorBanner, StatusBanner } from "@mp/ui";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MOCK_MODE } from "../../../lib/config";
import { useAuth } from "../../../lib/auth/AuthProvider";
import { useAutomationStats } from "../../../lib/api/imports-hooks";
import { PageHeader } from "../../../lib/components/PageHeader";
import { useOwners } from "../../../lib/owners";
import { AppliedCard } from "./AppliedCard";
import { ReviewCard } from "./ReviewCard";
import { ReadsCard, SourcesCard } from "./SourcesCard";
import { parseConnectResult } from "./connect-result";
import type { ConnectResult } from "./connect-result";
import styles from "./imports.module.css";

function Stat() {
  const stats = useAutomationStats();
  if (!stats.data) return null;
  const { percent, automatedCount, handCount } = stats.data;
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>{`${percent}%`}</span>
      <span className={styles.statText}>
        <span>found automatically this month</span>
        <span
          className={styles.statMeta}
        >{`${automatedCount} from email & CSV · ${handCount} typed by hand`}</span>
      </span>
    </div>
  );
}

/**
 * Email & imports. After the provider's consent screen the API's callback sends the browser back here
 * with `?connected=gmail` or `?connect_error=access_denied`; this handles both (BACKEND_PLAN §8.2).
 */
export function ImportsScreen() {
  const owners = useOwners();
  const queryClient = useQueryClient();
  const [result, setResult] = useState<ConnectResult | null>(null);

  useEffect(() => {
    const parsed = parseConnectResult(window.location.search);
    if (!parsed) return;
    setResult(parsed);
    window.history.replaceState(null, "", window.location.pathname);
    if (parsed.kind === "connected") void queryClient.invalidateQueries();
  }, [queryClient]);

  const { me } = useAuth();
  const partner = owners?.members.find((m) => m.id !== me?.id)?.name ?? "your partner";
  return (
    <>
      <PageHeader
        overline="Email & imports"
        title="Let your inbox fill in the bills"
        subtitle="MoneyPilot reads bills, renewal notices and receipts. You confirm, and the plan updates."
        actions={<Stat />}
      />
      {result?.kind === "connected" && <StatusBanner>{result.message}</StatusBanner>}
      {result?.kind === "error" && (
        <ErrorBanner title="We couldn’t connect that account.">{result.message}</ErrorBanner>
      )}
      <div className={styles.body}>
        <div className={styles.main}>
          <ReviewCard />
          <AppliedCard partnerName={partner} />
        </div>
        <div className={styles.side}>
          <SourcesCard />
          <ReadsCard />
        </div>
      </div>
      {MOCK_MODE && (
        <p className={styles.footer}>
          Sample data · Company names are fictional · Confirm or Ignore to try the queue
        </p>
      )}
    </>
  );
}
