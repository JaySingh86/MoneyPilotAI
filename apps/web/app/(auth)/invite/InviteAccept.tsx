"use client";

import { Button, Card, ErrorBanner, Loading, Skeleton } from "@mp/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, sendJson } from "../../../lib/api/client";
import { useAuth } from "../../../lib/auth/AuthProvider";
import { FirstNameForm } from "../../../lib/components/FirstNameForm";
import { SignInFlow } from "../sign-in/SignInFlow";
import styles from "../auth.module.css";
import {
  forgetInviteToken,
  inviteProblem,
  readInviteToken,
  recallInviteToken,
  rememberInviteToken,
} from "./invite";
import type { InviteProblem } from "./invite";

type Mode = "choose" | "sign_in" | "sign_up";

/**
 * The page the invite email links to. Signed out: say what this is, offer "Create account" and "Sign in" (the
 * sign-in steps, not a copy of them), and come back here. Signed in: accept the invite, then go to the Overview,
 * or to setup when the household has no payday yet.
 */
export function InviteAccept() {
  const { status, getToken, refresh, signOut } = useAuth();
  const router = useRouter();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("choose");
  const [problem, setProblem] = useState<InviteProblem | null>(null);
  const accepting = useRef(false);

  useEffect(() => {
    // Read the token once, keep it for this tab only, and take it out of the address bar (history, screenshots,
    // a copied URL). `sessionStorage` lets it survive the Google redirect, which returns to /sign-in.
    const fromLink = readInviteToken(window.location.search);
    if (fromLink) {
      rememberInviteToken(fromLink);
      const rest = new URLSearchParams(window.location.search);
      rest.delete("token");
      const query = rest.toString();
      window.history.replaceState(null, "", `/invite${query ? `?${query}` : ""}`);
    }
    setToken(fromLink ?? recallInviteToken());
  }, []);

  const accept = useCallback(
    async (secret: string) => {
      if (accepting.current) return;
      accepting.current = true;
      try {
        const joined = await sendJson<{ householdId: string }>("POST", "/v1/invites/accept", getToken, {
          token: secret,
        });
        forgetInviteToken();
        await refresh();
        const summary = joined
          ? await getJson<{ household: { primaryIncomeItemId: string | null } }>(
              `/v1/households/${joined.householdId}/summary`,
              getToken,
            ).catch(() => null)
          : null;
        router.replace(summary && summary.household.primaryIncomeItemId === null ? "/setup" : "/overview");
      } catch (error) {
        const refused = inviteProblem(error);
        if (refused.final) forgetInviteToken();
        setProblem(refused);
        accepting.current = false;
      }
    },
    [getToken, refresh, router],
  );

  useEffect(() => {
    if (status === "signed_in" && token) void accept(token);
  }, [status, token, accept]);

  if (status === "needs_name") return <FirstNameForm />;

  if (token === undefined || status === "loading" || (status === "signed_in" && !problem && token)) {
    return (
      <div className={styles.card}>
        <Loading label="Joining the household">
          <Skeleton width="60%" />
          <Skeleton shape="block" />
        </Loading>
      </div>
    );
  }

  if (token === null) {
    return (
      <div className={styles.card}>
        <Card title="This invitation link isn’t complete">
          <div className={styles.form}>
            <p className={styles.lead}>
              Open the link from your invitation email again, or ask your partner to send a new one.
            </p>
            <Link href="/sign-in" className={styles.linkText}>
              Go to sign in
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  if (problem) {
    return (
      <div className={styles.card}>
        <Card title={problem.title}>
          <div className={styles.form}>
            <ErrorBanner title={problem.title}>{problem.message}</ErrorBanner>
            {problem.next === "overview" && (
              <Link href="/overview" className={styles.linkText}>
                Go to your overview
              </Link>
            )}
            {problem.next === "sign_out" && (
              <Button variant="secondary" className={styles.full} onClick={() => void signOut()}>
                Sign out and use another address
              </Button>
            )}
          </div>
        </Card>
      </div>
    );
  }

  if (mode !== "choose") {
    return (
      <>
        <SignInFlow key={mode} initialStep={mode} onSignedIn={() => undefined} />
        <Button variant="text" size="compact" onClick={() => setMode("choose")}>
          Back to the invitation
        </Button>
      </>
    );
  }

  return (
    <div className={styles.card}>
      <Card
        title="You’ve been invited to a household"
        subtitle="Plan bills and decisions together on MoneyPilot."
      >
        <div className={styles.form}>
          <p className={styles.lead}>
            Your partner invited you to share a household plan. Use the email address the invitation was sent
            to. Each of you gets your own login.
          </p>
          <Button className={styles.full} onClick={() => setMode("sign_up")}>
            Create account
          </Button>
          <Button variant="secondary" className={styles.full} onClick={() => setMode("sign_in")}>
            Sign in
          </Button>
        </div>
      </Card>
    </div>
  );
}
