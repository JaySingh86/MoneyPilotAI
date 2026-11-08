"use client";

import { Button, Card, ErrorBanner, Loading, Skeleton, StatusBanner, StatusChip, SwitchRow } from "@mp/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSummary } from "../../../../lib/api/hooks";
import {
  useConnectionAction,
  useConnections,
  useForwarding,
  useLatestCsv,
  useRotateForwarding,
  useSummaryTimeZone,
} from "../../../../lib/api/imports-hooks";
import { problemMessage } from "../../../../lib/api/messages";
import {
  useDeletion,
  useLeave,
  useRequestExport,
  useSetSharing,
  useSharing,
} from "../../../../lib/api/settings-hooks";
import { useAuth } from "../../../../lib/auth/AuthProvider";
import { ConfirmDialog } from "../../../../lib/components/ConfirmDialog";
import { shortDate, shortDateNoYear } from "../../../../lib/format/dates";
import { agoLabel, localDate } from "../../../../lib/format/input";
import styles from "./household.module.css";

function SourceRow({
  title,
  meta,
  chip,
  action,
}: {
  title: string;
  meta: string;
  chip?: { variant: "ok" | "info" | "estimate" | "attention"; label: string };
  action?: React.ReactNode;
}) {
  return (
    <div className={styles.dataRow}>
      <span className={styles.memberText}>
        <span className={styles.memberName}>{title}</span>
        <span className={styles.memberMeta}>{meta}</span>
      </span>
      {chip && <StatusChip variant={chip.variant}>{chip.label}</StatusChip>}
      {action}
    </div>
  );
}

/** Connected data: one row per source. Only the mailbox owner gets Disconnect (§6 rule 14). */
export function ConnectedDataCard() {
  const summary = useSummary();
  const { me } = useAuth();
  const connections = useConnections();
  const forwarding = useForwarding();
  const rotate = useRotateForwarding();
  const csv = useLatestCsv();
  const action = useConnectionAction();
  const zone = useSummaryTimeZone();
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);

  return (
    <Card title="Connected data">
      <div className={styles.rows}>
        {(summary.isPending || connections.isPending) && (
          <Loading label="Loading connected data">
            <Skeleton shape="block" height="120px" />
          </Loading>
        )}
        {connections.isError && (
          <ErrorBanner title="We couldn’t load your connections." onRetry={() => void connections.refetch()}>
            Nothing was changed.
          </ErrorBanner>
        )}
        {connections.data &&
          summary.data?.members.map((member) => {
            const connection = connections.data?.find((c) => c.ownerUserId === member.userId);
            const mine = member.userId === me?.id;
            if (!connection) {
              return (
                <SourceRow
                  key={member.userId}
                  title={mine ? "Your email" : `${member.firstName}’s email`}
                  meta={
                    mine
                      ? "Not connected. Connect it from Email & imports."
                      : `Only ${member.firstName} can connect it, from ${member.firstName}’s own login`
                  }
                  chip={{ variant: "estimate", label: "Not connected" }}
                  action={
                    mine ? (
                      <Link href="/imports" className={styles.link}>
                        Connect
                      </Link>
                    ) : undefined
                  }
                />
              );
            }
            const name = connection.provider === "gmail" ? "Gmail" : "Outlook";
            const broken = connection.status === "error";
            return (
              <SourceRow
                key={connection.id}
                title={`${mine ? "" : `${member.firstName}’s `}${name} · ${connection.maskedAddress}`.trim()}
                meta={
                  broken
                    ? `We can’t read this inbox right now. What we already found stays in your plan.${
                        mine ? "" : ` Only ${member.firstName} can reconnect it.`
                      }`
                    : `Read-only · bills, renewals and receipts only · checked ${
                        connection.lastCheckedAt ? agoLabel(connection.lastCheckedAt, Date.now()) : "not yet"
                      }`
                }
                chip={
                  broken
                    ? { variant: "attention", label: "Needs reconnecting" }
                    : { variant: "info", label: connection.status === "paused" ? "Paused" : "Connected" }
                }
                action={
                  mine ? (
                    <>
                      {broken && (
                        <Link href="/imports" className={styles.link}>
                          Reconnect
                        </Link>
                      )}
                      <Button
                        variant="secondary"
                        size="compact"
                        onClick={() => setDisconnecting(connection.id)}
                      >
                        Disconnect
                      </Button>
                    </>
                  ) : undefined
                }
              />
            );
          })}
        <SourceRow
          title="Forwarding address"
          meta={
            forwarding.data
              ? `${forwarding.data.address} · ${forwarding.data.receivedCount} ${forwarding.data.receivedCount === 1 ? "email" : "emails"} received`
              : forwarding.isError
                ? "We couldn’t load the address. Try again."
                : "Loading the address…"
          }
          action={
            forwarding.isError ? (
              <Button variant="secondary" size="compact" onClick={() => void forwarding.refetch()}>
                Try again
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="compact"
                disabled={!forwarding.data}
                onClick={() => setRotating(true)}
              >
                Get a new address
              </Button>
            )
          }
        />
        <SourceRow
          title="Bank CSV imports"
          meta={
            csv.data
              ? `${csv.data.filename} · ${shortDateNoYear(localDate(csv.data.importedAt, zone))}`
              : "No file imported yet"
          }
          action={
            <Link href="/imports" className={styles.link}>
              Manage
            </Link>
          }
        />
        <SourceRow title="Bank connection" meta="Not available yet. Nothing is connected." />
      </div>
      {disconnecting && (
        <ConfirmDialog
          title="Disconnect your email?"
          confirmLabel="Disconnect"
          busy={action.isPending}
          error={action.isError ? problemMessage(action.error, "Nothing was changed. Try again.") : null}
          onCancel={() => setDisconnecting(null)}
          onConfirm={() =>
            action.mutate(
              { id: disconnecting, action: "disconnect" },
              { onSuccess: () => setDisconnecting(null) },
            )
          }
        >
          <p>We stop reading right away. What we already found stays in your plan.</p>
        </ConfirmDialog>
      )}
      {rotating && (
        <ConfirmDialog
          title="Get a new forwarding address?"
          confirmLabel="Get new address"
          busy={rotate.isPending}
          error={rotate.isError ? problemMessage(rotate.error, "Nothing was changed. Try again.") : null}
          onCancel={() => setRotating(false)}
          onConfirm={() => rotate.mutate(undefined, { onSuccess: () => setRotating(false) })}
        >
          <p>The old address keeps working for 24 hours. Update any forwarding filters you set up.</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

/** "What {partner} can see from your data": switches. The partner never sees the inbox. */
export function SharingCard({ partnerName }: { partnerName: string }) {
  const sharing = useSharing();
  const setSharing = useSetSharing();
  const value = sharing.data;
  const title = `What ${partnerName} can see from your data`;
  if (!value) {
    return (
      <Card title={title}>
        {sharing.isError ? (
          <ErrorBanner title="We couldn’t load these settings." onRetry={() => void sharing.refetch()}>
            Nothing was changed.
          </ErrorBanner>
        ) : (
          <Loading label="Loading sharing settings">
            <Skeleton shape="block" height="160px" />
          </Loading>
        )}
      </Card>
    );
  }
  const toggle = (key: keyof typeof value) => (on: boolean) => setSharing.mutate({ ...value, [key]: on });
  return (
    <Card title={title}>
      <div className={styles.rows}>
        <SwitchRow
          title="Bills and renewals found in my email"
          description="Needed for shared planning. If off, they’re visible only to you."
          checked={value.billsFromEmail}
          onChange={toggle("billsFromEmail")}
        />
        <SwitchRow
          title="Tasks and reminders assigned to me"
          description={`${partnerName} sees what you own and when it’s due`}
          checked={value.tasks}
          onChange={toggle("tasks")}
        />
        <SwitchRow
          title="My connected email address"
          description={`Shown masked in ${partnerName}’s settings when on`}
          checked={value.connectedAddress}
          onChange={toggle("connectedAddress")}
        />
      </div>
      <p
        className={styles.note}
      >{`${partnerName} never sees your inbox or the emails themselves, only the bills and renewals found in them.`}</p>
      {setSharing.isError && (
        <ErrorBanner title="We couldn’t save that.">Nothing was changed. Try again.</ErrorBanner>
      )}
    </Card>
  );
}

type Dialog = "leave" | "delete" | null;

/** Your data: export, leave, delete. Leave and delete always open a confirm dialog. */
export function YourDataCard({ partnerName }: { partnerName: string }) {
  const summary = useSummary();
  const router = useRouter();
  const { refresh } = useAuth();
  const exportData = useRequestExport();
  const leave = useLeave();
  const { schedule, cancel } = useDeletion();
  const [dialog, setDialog] = useState<Dialog>(null);
  const household = summary.data?.household;
  const scheduled = household?.deletionScheduledFor ?? null;
  const zone = useSummaryTimeZone();
  if (!household) return null;

  return (
    <Card title="Your data">
      <div className={styles.rows}>
        {scheduled && (
          <StatusBanner
            action={
              <Button
                variant="text"
                size="compact"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel deletion
              </Button>
            }
          >
            {`Deletion is scheduled for ${shortDate(localDate(scheduled, zone), localDate(scheduled, zone))}. Either of you can cancel before then.`}
          </StatusBanner>
        )}
        {exportData.isSuccess && (
          <StatusBanner>Export started. We’ll email you a link that works for 24 hours.</StatusBanner>
        )}
        {exportData.isError && (
          <ErrorBanner title="We couldn’t start the export.">
            {problemMessage(exportData.error, "Nothing was changed. Try again.")}
          </ErrorBanner>
        )}
        <div className={styles.dataRow}>
          <span className={styles.memberText}>
            <span className={styles.memberName}>Export everything</span>
            <span className={styles.memberMeta}>
              Bills, renewals, goals, tasks and the activity log as CSV and JSON.
            </span>
          </span>
          <Button variant="secondary" disabled={exportData.isPending} onClick={() => exportData.mutate()}>
            Export data
          </Button>
        </div>
        <div className={styles.dataRow}>
          <span className={styles.memberText}>
            <span className={styles.memberName}>Leave the household</span>
            <span
              className={styles.memberMeta}
            >{`Your email connection is removed. Bills you own move to ${partnerName}.`}</span>
          </span>
          <Button variant="destructive" label="Leave…" onClick={() => setDialog("leave")} />
        </div>
        <div className={styles.dataRow}>
          <span className={styles.memberText}>
            <span className={styles.memberName}>Delete the household</span>
            <span className={styles.memberMeta}>
              {`Deletes all data for both of you after 7 days. ${partnerName} is notified, and you’ll type the household name to confirm.`}
            </span>
          </span>
          <Button variant="destructive" label="Delete household…" onClick={() => setDialog("delete")} />
        </div>
      </div>
      {dialog === "leave" && (
        <ConfirmDialog
          title="Leave the household?"
          confirmLabel="Leave household"
          busy={leave.isPending}
          error={
            leave.isError ? problemMessage(leave.error, "You’re still in the household. Try again.") : null
          }
          onCancel={() => setDialog(null)}
          onConfirm={() =>
            leave.mutate(undefined, {
              onSuccess: () => {
                setDialog(null);
                void refresh().then(() => router.replace("/setup"));
              },
            })
          }
        >
          <p>{`Your email connection is removed and the bills you own move to ${partnerName}. You can start a new household or accept another invite afterwards.`}</p>
        </ConfirmDialog>
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title="Delete the household?"
          confirmLabel="Delete household"
          typeToConfirm={{ label: `Type “${household.name}” to confirm`, expected: household.name }}
          busy={schedule.isPending}
          error={schedule.isError ? problemMessage(schedule.error, "Nothing was deleted. Try again.") : null}
          onCancel={() => setDialog(null)}
          onConfirm={() => schedule.mutate(undefined, { onSuccess: () => setDialog(null) })}
        >
          <p>{`Everything for both of you is deleted after 7 days, and ${partnerName} is notified. Either of you can cancel before then.`}</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}
