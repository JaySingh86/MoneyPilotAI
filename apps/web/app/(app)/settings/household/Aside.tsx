"use client";

import { Button, Card, EmptyState, ErrorBanner, Loading, Skeleton, StatusBanner } from "@mp/ui";
import { useSummaryTimeZone } from "../../../../lib/api/imports-hooks";
import { useActivity, useRequestExport } from "../../../../lib/api/settings-hooks";
import { timestampLabel } from "../../../../lib/format/input";
import styles from "./household.module.css";

export function Promises() {
  return (
    <section className={styles.promises} aria-labelledby="promises-title">
      <h2 id="promises-title" className={styles.promisesTitle}>
        Our promises
      </h2>
      <ul className={styles.promisesList}>
        <li>We never sell or share your household’s data.</li>
        <li>MoneyPilot never moves money or pays bills.</li>
        <li>Email access is read-only, and we don’t store the emails.</li>
        <li>Data is encrypted in transit and at rest.</li>
        <li>Export or delete everything at any time.</li>
      </ul>
    </section>
  );
}

/** The latest five entries of the activity log. */
export function ActivityCard() {
  const activity = useActivity();
  const zone = useSummaryTimeZone();
  const full = useRequestExport();
  return (
    <Card title="Activity log">
      <div className={styles.rows}>
        {activity.isPending && (
          <Loading label="Loading the activity log">
            <Skeleton height="120px" shape="block" />
          </Loading>
        )}
        {activity.isError && (
          <ErrorBanner title="We couldn’t load the log." onRetry={() => void activity.refetch()}>
            Nothing was changed.
          </ErrorBanner>
        )}
        {activity.data?.length === 0 && (
          <EmptyState>Nothing yet. Changes to your household show up here.</EmptyState>
        )}
        {activity.data?.map((entry) => (
          <div key={entry.id} className={styles.activityRow}>
            <span className={styles.activityAction}>{entry.action}</span>
            <span
              className={styles.memberMeta}
            >{`${entry.actorName} · ${timestampLabel(entry.at, zone)}`}</span>
          </div>
        ))}
      </div>
      <div>
        <Button variant="text" size="compact" disabled={full.isPending} onClick={() => full.mutate()}>
          Download full log
        </Button>
      </div>
      {full.isSuccess && <StatusBanner>The full log is in your export. We’ll email you a link.</StatusBanner>}
      {full.isError && (
        <ErrorBanner title="We couldn’t start the download.">Nothing was changed. Try again.</ErrorBanner>
      )}
    </Card>
  );
}
