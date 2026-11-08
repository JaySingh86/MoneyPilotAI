"use client";

import { Button, Card, EmptyState, ErrorBanner, Loading, Skeleton, StatusBanner } from "@mp/ui";
import { useState } from "react";
import { useAppliedChanges, useToday, useUndo } from "../../../lib/api/imports-hooks";
import { useSummary } from "../../../lib/api/hooks";
import { problemMessage } from "../../../lib/api/messages";
import { appliedRow } from "./review-map";
import styles from "./imports.module.css";

/** "Applied automatically": changes that matched something already confirmed, each with Undo for 30 days. */
export function AppliedCard({ partnerName }: { partnerName: string }) {
  const changes = useAppliedChanges();
  const undo = useUndo();
  const today = useToday();
  const zone = useSummary().data?.household.timezone ?? "America/New_York";
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const rows = changes.data ?? [];
  return (
    <Card
      title="Applied automatically"
      subtitle="These matched something you’d already confirmed, so no review was needed. Undo any of them."
    >
      <div className={styles.stack}>
        {notice && <StatusBanner>{notice}</StatusBanner>}
        {failure && <ErrorBanner title="We couldn’t undo that.">{failure}</ErrorBanner>}
        {changes.isError && (
          <ErrorBanner title="We couldn’t load this list." onRetry={() => void changes.refetch()}>
            Nothing was changed.
          </ErrorBanner>
        )}
        {changes.isPending && (
          <Loading label="Loading applied changes">
            <Skeleton height="40px" />
            <Skeleton height="40px" />
          </Loading>
        )}
        {changes.data && rows.length === 0 && (
          <EmptyState>Nothing has been applied automatically yet. Matches will be listed here.</EmptyState>
        )}
        <ul className={styles.appliedList}>
          {rows.map((change) => {
            const row = appliedRow(change, today, zone);
            return (
              <li key={change.id} className={styles.appliedRow}>
                <span className={styles.appliedText}>
                  <strong className={styles.appliedTitle}>{row.title}</strong>
                  <span className={styles.appliedDetail}>{row.detail}</span>
                </span>
                {change.undoable && (
                  <Button
                    variant="text"
                    size="compact"
                    disabled={undo.isPending}
                    aria-label={`Undo ${row.title}`}
                    onClick={() => {
                      setFailure(null);
                      setNotice(null);
                      undo.mutate(change.id, {
                        onSuccess: () =>
                          setNotice(`${change.entityName ?? "The change"} is back to how it was.`),
                        onError: (error) =>
                          setFailure(problemMessage(error, "Nothing was changed. Try again.", partnerName)),
                      });
                    }}
                  >
                    Undo
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
