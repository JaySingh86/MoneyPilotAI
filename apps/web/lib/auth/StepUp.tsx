"use client";

// Step-up MFA (ADR-018). A few actions (leave, export, delete, connect email) answer 403 `mfa_required` until the
// person has proven a fresh TOTP code. `useStepUp()` wraps such a call: on that answer it opens a dialog, checks
// the code with the auth adapter, and retries the call once.
import { TextField } from "@mp/ui";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiError } from "../api/client";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useAuth } from "./AuthProvider";
import { authMessage } from "./types";

export type WithStepUp = <T>(run: () => Promise<T>) => Promise<T>;

const runDirectly: WithStepUp = (run) => run();
const StepUpContext = createContext<WithStepUp>(runDirectly);

/** Wrap a request: `withStepUp(() => sendJson(...))`. Outside a provider it just runs the request. */
export function useStepUp(): WithStepUp {
  return useContext(StepUpContext);
}

export function isMfaRequired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === "mfa_required";
}

interface Waiter {
  resolve: () => void;
  reject: () => void;
}

function CodeDialog({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { adapter } = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    setError(null);
    adapter
      .stepUp(code.trim())
      .then(onDone)
      .catch((e: unknown) => {
        setError(authMessage(e));
        setBusy(false);
      });
  };
  return (
    <ConfirmDialog
      title="Confirm it’s you"
      confirmLabel="Confirm"
      busy={busy}
      error={error}
      onConfirm={submit}
      onCancel={onCancel}
    >
      <p>This change needs a fresh 2-step verification code. Open your authenticator app and enter it.</p>
      <TextField
        label="6-digit code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
    </ConfirmDialog>
  );
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Every call that needs a code while the dialog is open waits on the same dialog.
  const waiters = useRef<Waiter[]>([]);

  const ask = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        waiters.current.push({ resolve, reject });
        setOpen(true);
      }),
    [],
  );
  const settle = (ok: boolean) => {
    const current = waiters.current;
    waiters.current = [];
    setOpen(false);
    for (const waiter of current) {
      if (ok) waiter.resolve();
      else waiter.reject();
    }
  };

  const withStepUp = useMemo<WithStepUp>(
    () => async (run) => {
      try {
        return await run();
      } catch (error) {
        if (!isMfaRequired(error)) throw error;
        // Cancelling surfaces the original problem, so the caller shows its usual message.
        await ask().catch(() => {
          throw error;
        });
        return run();
      }
    },
    [ask],
  );

  return (
    <StepUpContext value={withStepUp}>
      {children}
      {open && <CodeDialog onDone={() => settle(true)} onCancel={() => settle(false)} />}
    </StepUpContext>
  );
}
