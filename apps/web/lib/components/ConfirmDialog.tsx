"use client";

import { Button, TextField } from "@mp/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import styles from "./confirm-dialog.module.css";

export interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  /**
   * The confirm button: "Leave household", "Delete household". Not red or amber (DESIGN_SPEC §4).
   * Leave it out for an information-only dialog with a single "Close".
   */
  confirmLabel?: string;
  /** Delete needs the household name typed in; leave needs one confirm. */
  typeToConfirm?: { label: string; expected: string };
  busy?: boolean;
  /** Shown above the buttons, role="alert". */
  error?: string | null;
  onConfirm?: () => void;
  onCancel: () => void;
}

/** A modal confirm dialog on a native <dialog>: focus is trapped, Escape cancels, focus returns to the opener. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  typeToConfirm,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const [typed, setTyped] = useState("");
  const matches = !typeToConfirm || typed.trim() === typeToConfirm.expected;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => opener.current?.focus();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (matches && !busy) onConfirm?.();
  };

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <form className={styles.form} onSubmit={submit}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <div className={styles.body}>{children}</div>
        {typeToConfirm && (
          <TextField
            label={typeToConfirm.label}
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {confirmLabel ? "Cancel" : "Close"}
          </Button>
          {confirmLabel && (
            <Button variant="primary" type="submit" disabled={!matches || busy}>
              {confirmLabel}
            </Button>
          )}
        </div>
      </form>
    </dialog>
  );
}
