"use client";

import { Avatar, Button, Card, ErrorBanner, Loading, Skeleton, StatusChip, TextField } from "@mp/ui";
import { useState } from "react";
import type { FormEvent } from "react";
import { useSummary } from "../../../../lib/api/hooks";
import { useConnections, useRemindMember, useSummaryTimeZone } from "../../../../lib/api/imports-hooks";
import { problemMessage } from "../../../../lib/api/messages";
import { useInvite, useResendInvite } from "../../../../lib/api/settings-hooks";
import { useAuth } from "../../../../lib/auth/AuthProvider";
import { shortDateNoYear } from "../../../../lib/format/dates";
import { localDate } from "../../../../lib/format/input";
import { TwoStepDialog } from "./TwoStepDialog";
import styles from "./household.module.css";

function InviteRow({ email, firstName, id }: { email: string; firstName: string | null; id: string }) {
  const resend = useResendInvite();
  return (
    <div className={styles.memberRow}>
      <span className={styles.memberText}>
        <span className={styles.memberName}>{`${firstName ?? email} invited`}</span>
        <span className={styles.memberMeta}>Waiting to join. The invite link works for 7 days.</span>
      </span>
      <Button
        variant="secondary"
        size="compact"
        disabled={resend.isPending}
        onClick={() => resend.mutate(id)}
      >
        Resend
      </Button>
      {resend.isError && (
        <div className={styles.rowFull}>
          <ErrorBanner title="The invite didn’t go out.">
            {problemMessage(resend.error, "Try again.")}
          </ErrorBanner>
        </div>
      )}
    </div>
  );
}

function InviteForm() {
  const invite = useInvite();
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setProblem("Enter your partner’s email address.");
      return;
    }
    setProblem(null);
    invite.mutate({ email: email.trim(), firstName: firstName.trim().slice(0, 50) || undefined });
  };
  return (
    <form className={styles.inviteForm} onSubmit={submit} noValidate>
      <TextField
        label="Their first name (optional)"
        autoComplete="off"
        maxLength={50}
        value={firstName}
        onChange={(e) => setFirstName(e.target.value)}
      />
      <TextField
        label="Invite your partner"
        type="email"
        autoComplete="off"
        value={email}
        error={
          problem ??
          (invite.isError ? problemMessage(invite.error, "The invite didn’t go out. Try again.") : null)
        }
        hint="They get their own login and see the same plan."
        onChange={(e) => setEmail(e.target.value)}
      />
      <div>
        <Button type="submit" variant="secondary" disabled={invite.isPending}>
          Send invite
        </Button>
      </div>
    </form>
  );
}

/** Members: avatar, name, role line, access chip, and the 2-step reminder. */
export function MembersCard() {
  const summary = useSummary();
  const connections = useConnections();
  const zone = useSummaryTimeZone();
  const { me } = useAuth();
  const remind = useRemindMember();
  const [reminded, setReminded] = useState<ReadonlySet<string>>(new Set());
  const [enrolling, setEnrolling] = useState(false);
  const data = summary.data;
  if (!data) {
    return (
      <Card title="Members">
        {summary.isError ? (
          <ErrorBanner title="We couldn’t load your members." onRetry={() => void summary.refetch()}>
            Nothing was changed.
          </ErrorBanner>
        ) : (
          <Loading label="Loading members">
            <Skeleton shape="block" height="120px" />
          </Loading>
        )}
      </Card>
    );
  }

  return (
    <Card title="Members" actions={<span className={styles.hintInline}>Equal access · separate logins</span>}>
      <div className={styles.rows}>
        {data.members.map((member) => {
          const you = member.userId === me?.id;
          const connection = connections.data?.find((c) => c.ownerUserId === member.userId);
          const parts = [
            member.isCreator
              ? "Created the household"
              : `Joined ${shortDateNoYear(localDate(member.joinedAt, zone))}`,
            connection
              ? `${connection.provider === "gmail" ? "Gmail" : "Outlook"} connected`
              : "email not connected",
            member.mfaEnabled ? "2-step verification on" : null,
          ].filter((p): p is string => p !== null);
          return (
            <div key={member.userId} className={styles.memberRow}>
              <Avatar name={member.firstName} role={member.colorRole} size={40} decorative />
              <span className={styles.memberText}>
                <span className={styles.memberName}>
                  {`${member.firstName}${member.lastName ? ` ${member.lastName}` : ""}`}
                  {you && <span className={styles.you}> (you)</span>}
                </span>
                <span className={styles.memberMeta}>{parts.join(" · ")}</span>
              </span>
              {!member.mfaEnabled ? (
                <>
                  <StatusChip variant="info">2-step verification off</StatusChip>
                  {you && (
                    <Button variant="secondary" size="compact" onClick={() => setEnrolling(true)}>
                      Turn on 2-step verification
                    </Button>
                  )}
                  {!you &&
                    (reminded.has(member.userId) ? (
                      <StatusChip variant="ok">Reminder sent</StatusChip>
                    ) : (
                      <Button
                        variant="secondary"
                        size="compact"
                        disabled={remind.isPending}
                        onClick={() =>
                          remind.mutate(
                            { userId: member.userId, about: "two_step" },
                            { onSuccess: () => setReminded(new Set([...reminded, member.userId])) },
                          )
                        }
                      >
                        {`Remind ${member.firstName}`}
                      </Button>
                    ))}
                </>
              ) : (
                <StatusChip variant="ok">Full access</StatusChip>
              )}
            </div>
          );
        })}
        {data.openInvite && (
          <InviteRow
            email={data.openInvite.email}
            firstName={data.openInvite.firstName}
            id={data.openInvite.id}
          />
        )}
      </div>
      {!data.openInvite && data.members.length < data.entitlements.maxAdults && <InviteForm />}
      <p className={styles.note}>
        Family Plus covers two adults. Each person signs in separately, and either of you can leave at any
        time.
      </p>
      {remind.isError && (
        <ErrorBanner title="We couldn’t send the reminder.">Nothing was changed. Try again.</ErrorBanner>
      )}
      {enrolling && <TwoStepDialog onClose={() => setEnrolling(false)} />}
    </Card>
  );
}
