"use client";

import { Button, Card, TextField } from "@mp/ui";
import { useState } from "react";
import type { FormEvent } from "react";
import { useAuth } from "../auth/AuthProvider";
import { FIRST_NAME_MAX } from "../auth/bootstrap";
import styles from "./first-name-form.module.css";

/** Shown once, when the sign-in token has no first name and `POST /me/bootstrap` asks for it. */
export function FirstNameForm() {
  const { submitFirstName } = useAuth();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") {
      setError("Tell us your first name.");
      return;
    }
    setBusy(true);
    setError(null);
    await submitFirstName(name);
    setBusy(false);
  }

  return (
    <Card title="One more thing" subtitle="Your partner will see this name next to the bills you own.">
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <TextField
          label="First name"
          autoComplete="given-name"
          value={name}
          maxLength={FIRST_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          error={error}
        />
        <Button type="submit" disabled={busy}>
          Continue
        </Button>
      </form>
    </Card>
  );
}
