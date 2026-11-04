"use client";

import { Button, Card, ErrorBanner, StatusBanner, TextField } from "@mp/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useAuth } from "../../../lib/auth/AuthProvider";
import { FIRST_NAME_MAX } from "../../../lib/auth/bootstrap";
import { authMessage } from "../../../lib/auth/types";
import type { SignInStep } from "../../../lib/auth/types";
import { COGNITO } from "../../../lib/config";
import { FirstNameForm } from "../../../lib/components/FirstNameForm";
import styles from "../auth.module.css";

type Step = "sign_in" | "totp" | "sign_up" | "confirm_sign_up" | "forgot" | "reset";

const TITLES: Record<Step, { title: string; subtitle?: string }> = {
  sign_in: { title: "Sign in", subtitle: "Pick up where your household left off." },
  totp: { title: "Check your authenticator app", subtitle: "Enter the 6-digit code it shows." },
  sign_up: { title: "Create your account", subtitle: "You can invite your partner after this." },
  confirm_sign_up: { title: "Confirm your email", subtitle: "We sent a 6-digit code to your inbox." },
  forgot: { title: "Reset your password", subtitle: "We’ll email you a code." },
  reset: { title: "Choose a new password", subtitle: "Enter the code we emailed you." },
};

export function SignInFlow() {
  const { adapter, status, refresh } = useAuth();
  const router = useRouter();
  const [step, setStep] = useState<Step>("sign_in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (status === "signed_in") router.replace("/overview");
  }, [status, router]);

  if (status === "needs_name") return <FirstNameForm />;

  function go(next: Step, message: string | null = null) {
    setStep(next);
    setCode("");
    setError(null);
    setNotice(message);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (failure) {
      setError(authMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function finish(result: SignInStep) {
    switch (result.step) {
      case "done":
        await refresh();
        return;
      case "totp":
        go("totp");
        return;
      case "confirm_sign_up":
        go("confirm_sign_up", "Enter the code we emailed you to confirm your address.");
        return;
      case "unsupported":
        setError(result.detail);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      switch (step) {
        case "sign_in":
          return finish(await adapter.signIn(email.trim(), password));
        case "totp":
          return finish(await adapter.confirmTotp(code.trim()));
        case "sign_up":
          return finish(await adapter.signUp({ email: email.trim(), password, firstName: firstName.trim() }));
        case "confirm_sign_up":
          await adapter.confirmSignUp(email.trim(), code.trim());
          return go("sign_in", "Your email is confirmed. Sign in to continue.");
        case "forgot":
          await adapter.requestPasswordReset(email.trim());
          return go("reset", "If that address has an account, a code is on its way.");
        case "reset":
          await adapter.confirmPasswordReset(email.trim(), code.trim(), password);
          return go("sign_in", "Your password is changed. Sign in with the new one.");
      }
    });
  }

  const showEmail = step === "sign_in" || step === "sign_up" || step === "forgot" || step === "reset";
  const showPassword = step === "sign_in" || step === "sign_up" || step === "reset";
  const showCode = step === "totp" || step === "confirm_sign_up" || step === "reset";
  // `process.env.NODE_ENV` is inlined by Next: in a production bundle the mock-only branches below are
  // constant `false` and are dropped, strings included (see lib/config.ts and the production-build test).
  const mockAuth = process.env.NODE_ENV !== "production" && adapter.kind === "mock";
  const googleAvailable = mockAuth || COGNITO?.oauthDomain != null;
  const { title, subtitle } = TITLES[step];
  const submitLabel: Record<Step, string> = {
    sign_in: "Sign in",
    totp: "Verify",
    sign_up: "Create account",
    confirm_sign_up: "Confirm email",
    forgot: "Send code",
    reset: "Change password",
  };

  const link = (label: string, to: Step): ReactNode => (
    <Button variant="text" size="compact" onClick={() => go(to)}>
      {label}
    </Button>
  );

  return (
    <div className={styles.card}>
      <Card title={title} subtitle={subtitle}>
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          {notice && <StatusBanner>{notice}</StatusBanner>}
          {error && <ErrorBanner title={error} />}
          {step === "sign_up" && (
            <TextField
              label="First name"
              autoComplete="given-name"
              value={firstName}
              maxLength={FIRST_NAME_MAX}
              onChange={(e) => setFirstName(e.target.value)}
              required
            />
          )}
          {showEmail && (
            <TextField
              label="Email"
              type="email"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          )}
          {showPassword && (
            <TextField
              label={step === "reset" ? "New password" : "Password"}
              type="password"
              autoComplete={step === "sign_in" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
          {showCode && (
            <TextField
              label={step === "totp" ? "Authenticator code" : "Emailed code"}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          )}
          <Button type="submit" className={styles.full} disabled={busy}>
            {submitLabel[step]}
          </Button>
          {step === "sign_in" && (
            <>
              {googleAvailable && (
                <>
                  <p className={styles.divider}>or</p>
                  <Button
                    variant="secondary"
                    className={styles.full}
                    onClick={() => void run(() => adapter.signInWithGoogle())}
                  >
                    Continue with Google
                  </Button>
                </>
              )}
              <div className={styles.links}>
                {link("Forgot your password?", "forgot")}
                {link("Create an account", "sign_up")}
              </div>
            </>
          )}
          {step !== "sign_in" && <div className={styles.links}>{link("Back to sign in", "sign_in")}</div>}
          {process.env.NODE_ENV !== "production" && adapter.kind === "mock" && (
            <p className={styles.note}>
              Mock sign-in for local development: any password works. “mfa” asks for a code (123456).
            </p>
          )}
        </form>
      </Card>
    </div>
  );
}
