"use client";

import { ErrorBanner, Loading, Skeleton } from "@mp/ui";
import { useSummary } from "../../../../lib/api/hooks";
import { MOCK_MODE } from "../../../../lib/config";
import { useAuth } from "../../../../lib/auth/AuthProvider";
import { PageHeader } from "../../../../lib/components/PageHeader";
import { ActivityCard, Promises } from "./Aside";
import { ConnectedDataCard, SharingCard, YourDataCard } from "./DataCards";
import { HouseholdCard } from "./HouseholdCard";
import { MembersCard } from "./MembersCard";
import styles from "./household.module.css";

/** Members & privacy: household, members, connected data, sharing, your data. */
export function HouseholdScreen() {
  const summary = useSummary();
  const { me } = useAuth();
  const partner = summary.data?.members.find((m) => m.userId !== me?.id)?.firstName ?? "your partner";

  const header = (
    <PageHeader
      overline="Household settings"
      title="Members & privacy"
      subtitle="Who’s in the household, what MoneyPilot can read, and what each of you can see."
    />
  );
  if (summary.isError) {
    return (
      <>
        {header}
        <ErrorBanner title="We couldn’t load your household." onRetry={() => void summary.refetch()}>
          Nothing was changed.
        </ErrorBanner>
      </>
    );
  }
  if (!summary.data) {
    return (
      <>
        {header}
        <Loading label="Loading your household">
          <Skeleton shape="block" height="260px" />
          <Skeleton shape="block" height="200px" />
        </Loading>
      </>
    );
  }
  return (
    <>
      {header}
      <div className={styles.body}>
        <div className={styles.main}>
          <HouseholdCard />
          <MembersCard />
          <ConnectedDataCard />
          <SharingCard partnerName={partner} />
          <YourDataCard partnerName={partner} />
        </div>
        <aside className={styles.side} aria-label="Promises and activity">
          <Promises />
          <ActivityCard />
        </aside>
      </div>
      {MOCK_MODE && <p className={styles.footer}>{`Sample data · Viewing as ${me?.firstName ?? "you"}`}</p>}
    </>
  );
}
