"use client";

import { TextField } from "@mp/ui";
import { useEffect, useRef, useState } from "react";
import { useSetUpTotp } from "../../../../lib/api/settings-hooks";
import { authMessage } from "../../../../lib/auth/types";
import type { TotpSetup } from "../../../../lib/auth/types";
import { ConfirmDialog } from "../../../../lib/components/ConfirmDialog";
import styles from "./household.module.css";

/** "Turn on 2-step verification" (Q-176): shows the setup key for an authenticator app, then checks the first code. */
export function TwoStepDialog({ onClose }: { onClose: () => void }) {
  const totp = useSetUpTotp();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    totp
      .start()
      .then(setSetup)
      .catch((e: unknown) => setError(authMessage(e)));
    // `totp.start` is stable for the life of the dialog; it must run exactly once.
  }, []);

  const confirm = () => {
    if (!setup) return;
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    setError(null);
    setup
      .confirm(code.trim())
      .then(() => {
        totp.done();
        onClose();
      })
      .catch((e: unknown) => {
        setError(authMessage(e));
        setBusy(false);
      });
  };

  return (
    <ConfirmDialog
      title="Turn on 2-step verification"
      confirmLabel={setup ? "Turn on" : undefined}
      busy={busy}
      error={error}
      onConfirm={confirm}
      onCancel={onClose}
    >
      <p>
        Add MoneyPilot to an authenticator app, then enter the 6-digit code it shows. You’ll use a code for
        sensitive changes like leaving or deleting the household.
      </p>
      {setup && (
        <>
          <p>
            Setup key <code className={styles.setupKey}>{setup.sharedSecret}</code>
          </p>
          <TextField
            label="6-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </>
      )}
    </ConfirmDialog>
  );
}
