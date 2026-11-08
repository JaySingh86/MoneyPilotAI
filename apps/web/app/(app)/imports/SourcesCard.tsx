"use client";

import { Avatar, Button, Card, ErrorBanner, Loading, Skeleton, StatusChip, SwitchRow } from "@mp/ui";
import { useState } from "react";
import { useAuth } from "../../../lib/auth/AuthProvider";
import { CONNECT_REFUSED, goToProvider } from "../../../lib/safe-urls";

import {
  useConnectionAction,
  useConnections,
  useForwarding,
  useLatestCsv,
  useRemindMember,
  useSenderRules,
  useSetSenderRule,
  useStartConnection,
  useSummaryTimeZone,
} from "../../../lib/api/imports-hooks";
import type { EmailConnection } from "../../../lib/api/imports-types";
import { problemMessage } from "../../../lib/api/messages";
import { ConfirmDialog } from "../../../lib/components/ConfirmDialog";
import { shortDateNoYear } from "../../../lib/format/dates";
import { agoLabel, localDate } from "../../../lib/format/input";
import { useOwners } from "../../../lib/owners";
import type { Member } from "../../../lib/owners";
import { CsvPanel } from "./CsvPanel";
import { useCsvFlow } from "./csv-flow";
import styles from "./imports.module.css";

const PROVIDER = { gmail: "Gmail", outlook: "Outlook" } as const;

/** A connection that stopped working is amber ("something went wrong"), not a healthy or paused source. */
export function ConnectionChip({ status }: { status: EmailConnection["status"] }) {
  if (status === "error") return <StatusChip variant="attention">Needs reconnecting</StatusChip>;
  if (status === "paused") return <StatusChip variant="estimate">Paused</StatusChip>;
  return <StatusChip variant="info">On</StatusChip>;
}

function MemberRow({
  member,
  connection,
  isMe,
}: {
  member: Member;
  connection: EmailConnection | undefined;
  isMe: boolean;
}) {
  const action = useConnectionAction();
  const start = useStartConnection();
  const remind = useRemindMember();
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const connect = (provider: "gmail" | "outlook") => {
    setFailure(null);
    start.mutate(
      { provider, returnTo: "/imports" },
      {
        // The browser goes to the provider's consent screen; the API's callback sends it back to /imports.
        onSuccess: ({ authUrl }) => {
          try {
            goToProvider(authUrl);
          } catch {
            setFailure(CONNECT_REFUSED);
          }
        },
        onError: (error) => setFailure(problemMessage(error, "We couldn’t start the connection. Try again.")),
      },
    );
  };

  return (
    <div className={styles.source}>
      <div className={styles.sourceHead}>
        <Avatar name={member.name} role={member.role} size={28} decorative />
        <span className={styles.sourceText}>
          <span className={styles.sourceTitle}>
            {connection
              ? `${PROVIDER[connection.provider]} · ${connection.maskedAddress}`
              : isMe
                ? "Your email"
                : `${member.name}’s email`}
          </span>
          <span className={styles.sourceMeta}>
            {connection
              ? connection.status === "error"
                ? `We can’t read this inbox right now. What we already found stays in your plan.${isMe ? "" : ` Only ${member.name} can reconnect it.`}`
                : connection.status === "paused"
                  ? "Paused. We aren’t reading new emails."
                  : `Read-only · checked ${connection.lastCheckedAt ? agoLabel(connection.lastCheckedAt, Date.now()) : "not yet"}`
              : isMe
                ? "Not connected."
                : `Not connected. Only ${member.name} can connect it.`}
          </span>
        </span>
        {connection && <ConnectionChip status={connection.status} />}
      </div>
      {connection && (
        <p className={styles.sourceStats}>
          {`Looked back ${connection.backfillMonths} months to catch yearly renewals · ${connection.matchedCount} emails matched, ${connection.usedCount} used`}
        </p>
      )}
      <div className={styles.sourceActions}>
        {connection && isMe && (
          <>
            {connection.status === "error" ? (
              <Button
                variant="secondary"
                size="compact"
                disabled={start.isPending}
                onClick={() => connect(connection.provider)}
              >
                Reconnect
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="compact"
                disabled={action.isPending}
                onClick={() =>
                  action.mutate({
                    id: connection.id,
                    action: connection.status === "paused" ? "resume" : "pause",
                  })
                }
              >
                {connection.status === "paused" ? "Resume" : "Pause"}
              </Button>
            )}
            <Button variant="secondary" size="compact" onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          </>
        )}
        {!connection && isMe && (
          <>
            <Button
              variant="secondary"
              size="compact"
              disabled={start.isPending}
              onClick={() => connect("gmail")}
            >
              Connect Gmail
            </Button>
            <Button
              variant="secondary"
              size="compact"
              disabled={start.isPending}
              onClick={() => connect("outlook")}
            >
              Connect Outlook
            </Button>
          </>
        )}
        {!connection && !isMe && (
          <Button
            variant="secondary"
            size="compact"
            disabled={remind.isPending || remind.isSuccess}
            onClick={() => remind.mutate({ userId: member.id, about: "connect_email" })}
          >
            {remind.isSuccess ? "Reminder sent" : `Remind ${member.name} to connect`}
          </Button>
        )}
      </div>
      {(failure || remind.isError) && (
        <ErrorBanner title="That didn’t go through.">
          {failure ?? "We couldn’t send the reminder. Try again."}
        </ErrorBanner>
      )}
      {confirming && connection && (
        <ConfirmDialog
          title={`Disconnect ${PROVIDER[connection.provider]}?`}
          confirmLabel="Disconnect"
          busy={action.isPending}
          error={action.isError ? problemMessage(action.error, "Nothing was changed. Try again.") : null}
          onCancel={() => setConfirming(false)}
          onConfirm={() =>
            action.mutate(
              { id: connection.id, action: "disconnect" },
              { onSuccess: () => setConfirming(false) },
            )
          }
        >
          <p>We stop reading right away. What we already found stays in your plan.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function Forwarding() {
  const forwarding = useForwarding();
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.source}>
      <p className={styles.sourceTitle}>Forwarding address</p>
      <p className={styles.sourceMeta}>
        For Yahoo, iCloud or any other email. Forward bills by hand, or set a filter to do it automatically.
      </p>
      {forwarding.data && (
        <div className={styles.codeRow}>
          <code className={styles.code}>{forwarding.data.address}</code>
          <Button
            variant="secondary"
            size="compact"
            onClick={() => {
              void navigator.clipboard?.writeText(forwarding.data?.address ?? "").then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
      {forwarding.isError && (
        <ErrorBanner title="We couldn’t load the address." onRetry={() => void forwarding.refetch()} />
      )}
    </div>
  );
}

function BankCsv() {
  const latest = useLatestCsv();
  const zone = useSummaryTimeZone();
  const [open, setOpen] = useState(false);
  const flow = useCsvFlow();
  const close = () => {
    flow.reset();
    setOpen(false);
  };
  const csv = latest.data;
  return (
    <div className={styles.csvRow}>
      <span className={styles.sourceText}>
        <span className={styles.sourceTitle}>Bank CSV</span>
        <span className={styles.sourceMeta}>
          {csv
            ? `${csv.filename} · imported ${shortDateNoYear(localDate(csv.importedAt, zone))}`
            : "No file imported yet."}
        </span>
      </span>
      <Button variant="secondary" size="compact" onClick={() => setOpen(true)}>
        Upload new
      </Button>
      {open && (
        <ConfirmDialog title="Upload a bank CSV" onCancel={close}>
          <CsvPanel flow={flow} showFound={false} />
          {flow.stage === "done" && (
            <p>Anything we found is in “Review what we found”. Nothing changes until you confirm it.</p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

export function SourcesCard() {
  const { me } = useAuth();
  const owners = useOwners();
  const connections = useConnections();
  return (
    <Card title="Connected sources">
      <div className={styles.stack}>
        {connections.isPending && (
          <Loading label="Loading connected sources">
            <Skeleton height="64px" />
          </Loading>
        )}
        {connections.isError && (
          <ErrorBanner title="We couldn’t load your connections." onRetry={() => void connections.refetch()}>
            Nothing was changed.
          </ErrorBanner>
        )}
        {connections.data &&
          owners?.members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              connection={connections.data.find((c) => c.ownerUserId === member.id)}
              isMe={member.id === me?.id}
            />
          ))}
        <Forwarding />
        <BankCsv />
      </div>
    </Card>
  );
}

function SenderRulesDialog({ onClose }: { onClose: () => void }) {
  const rules = useSenderRules(true);
  const setRule = useSetSenderRule();
  return (
    <ConfirmDialog title="Watched senders" onCancel={onClose}>
      <p>MoneyPilot reads emails from these senders. Turn one off and we ignore it.</p>
      {rules.isPending && <Skeleton shape="block" height="120px" />}
      {rules.isError && (
        <ErrorBanner title="We couldn’t load the list." onRetry={() => void rules.refetch()} />
      )}
      <div className={styles.rules}>
        {rules.data?.map((rule) => (
          <SwitchRow
            key={rule.id}
            title={rule.domain}
            checked={rule.rule === "watch"}
            disabled={setRule.isPending}
            onChange={(on) => setRule.mutate({ domain: rule.domain, rule: on ? "watch" : "ignore" })}
          />
        ))}
      </div>
    </ConfirmDialog>
  );
}

/** "What MoneyPilot reads": brand.strong colors, five promises, and the watched senders list. */
export function ReadsCard() {
  const rules = useSenderRules(true);
  const [open, setOpen] = useState(false);
  const watched = rules.data?.filter((r) => r.rule === "watch").length;
  return (
    <section className={styles.reads} aria-labelledby="reads-title">
      <h2 id="reads-title" className={styles.readsTitle}>
        What MoneyPilot reads
      </h2>
      <ul className={styles.readsList}>
        <li>
          Only emails that look like bills, renewals, receipts or statements, matched by sender and keywords.
        </li>
        <li>We keep the details we extract and a link to the email. We don’t store the email itself.</li>
        <li>Read-only. We can’t send, delete or change any email.</li>
        <li>Your partner sees the bills we find, never your inbox.</li>
        <li>Disconnect any time and we stop reading right away. You choose whether to keep what we found.</li>
      </ul>
      <button type="button" className={styles.readsLink} onClick={() => setOpen(true)}>
        {watched === undefined ? "Manage watched senders" : `Manage watched senders (${watched})`}
      </button>
      {open && <SenderRulesDialog onClose={() => setOpen(false)} />}
    </section>
  );
}
