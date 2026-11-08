"use client";

import {
  Button,
  ErrorBanner,
  RadioCardGroup,
  SelectField,
  StatusBanner,
  StatusChip,
  TextField,
} from "@mp/ui";
import { Check, Lock, Mail, Pencil, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useActiveHousehold, useSummary } from "../../../lib/api/hooks";
import { useConnections, useForwarding, useStartConnection } from "../../../lib/api/imports-hooks";
import { problemMessage } from "../../../lib/api/messages";
import {
  useCreateBill,
  useCreateHousehold,
  useInvite,
  useResendInvite,
} from "../../../lib/api/settings-hooks";
import type { ManualBill } from "../../../lib/api/settings-hooks";
import { useAuth } from "../../../lib/auth/AuthProvider";
import { CONNECT_REFUSED, goToProvider } from "../../../lib/safe-urls";

import { parseDollars } from "../../../lib/format/input";
import { CsvPanel } from "../imports/CsvPanel";
import { parseConnectResult } from "../imports/connect-result";
import type { ConnectResult } from "../imports/connect-result";
import { useCsvFlow } from "../imports/csv-flow";
import styles from "./setup.module.css";

type Method = "email" | "csv" | "manual";

/** Step 2 of 4: name the household. Shown only when the signed-in user has none yet. */
function CreateHousehold({ onCreated }: { onCreated: () => void }) {
  const create = useCreateHousehold();
  const { refresh } = useAuth();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "" || name.trim().length > 80) {
      setProblem("Use 1 to 80 characters, like “Rivera household”.");
      return;
    }
    setProblem(null);
    create.mutate({ name: name.trim() }, { onSuccess: () => void refresh().then(onCreated) });
  };
  return (
    <div className={styles.page}>
      <Progress step={2} />
      <h1 className={styles.title}>Name your household</h1>
      <p className={styles.subtitle}>You can invite your partner next. Each of you gets your own login.</p>
      <form className={styles.panel} onSubmit={submit} noValidate>
        <TextField
          label="Household name"
          value={name}
          error={
            problem ??
            (create.isError ? problemMessage(create.error, "We couldn’t create it. Try again.") : null)
          }
          onChange={(e) => setName(e.target.value)}
        />
        <div>
          <Button type="submit" disabled={create.isPending}>
            Create household
          </Button>
        </div>
      </form>
    </div>
  );
}

function Progress({ step }: { step: number }) {
  return (
    <div className={styles.head}>
      <div className={styles.stepRow}>
        <span className={styles.step}>{`Step ${step} of 4`}</span>
        <Link href="/overview" className={styles.skip}>
          Skip for now
        </Link>
      </div>
      <div className={styles.bars} aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={n <= step ? styles.barOn : styles.bar} />
        ))}
      </div>
    </div>
  );
}

function Done({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={styles.doneRow}>
      <span className={styles.tick} aria-hidden="true">
        <Check size={12} strokeWidth={3} />
      </span>
      <span className={styles.doneText}>{children}</span>
      {action}
    </div>
  );
}

function InviteLine({ partnerName }: { partnerName: string | null }) {
  const summary = useSummary();
  const invite = useInvite();
  const resend = useResendInvite();
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const data = summary.data;
  if (!data) return null;
  if (data.openInvite) {
    const open = data.openInvite;
    return (
      <Done
        action={
          <Button
            variant="text"
            size="compact"
            disabled={resend.isPending}
            onClick={() => resend.mutate(open.id)}
          >
            Resend
          </Button>
        }
      >
        {`${open.firstName ?? open.email} invited · waiting to join`}
        {resend.isError && (
          <span className={styles.inlineError}>{problemMessage(resend.error, "Try again.")}</span>
        )}
      </Done>
    );
  }
  if (data.members.length > 1) {
    return <Done>{`${partnerName} joined`}</Done>;
  }
  return (
    <form
      className={styles.inviteForm}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
          setProblem("Enter your partner’s email address.");
          return;
        }
        setProblem(null);
        invite.mutate({ email: email.trim(), firstName: firstName.trim().slice(0, 50) || undefined });
      }}
    >
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
        value={email}
        autoComplete="off"
        error={problem ?? (invite.isError ? problemMessage(invite.error, "The invite didn’t go out.") : null)}
        onChange={(e) => setEmail(e.target.value)}
      />
      <div>
        <Button type="submit" variant="secondary" size="compact" disabled={invite.isPending}>
          Send invite
        </Button>
      </div>
    </form>
  );
}

const REPEATS = [
  { value: "monthly", label: "Monthly" },
  { value: "every_2_weeks", label: "Every 2 weeks" },
  { value: "every_6_months", label: "Every 6 months" },
  { value: "yearly", label: "Yearly" },
] as const;

/** Lets the bottom bar ask the panel to add what is typed before moving on. Resolves false if it needs fixing. */
type Flush = MutableRefObject<(() => Promise<boolean>) | null>;

function ManualPanel({ flushRef }: { flushRef: Flush }) {
  const { me } = useAuth();
  const createBill = useCreateBill();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [repeats, setRepeats] = useState<ManualBill["repeats"]>("monthly");
  const [firstDue, setFirstDue] = useState("");
  const [count, setCount] = useState(0);
  const [problems, setProblems] = useState<{ name?: string; amount?: string; due?: string }>({});

  const pending = name.trim() !== "" || amount.trim() !== "" || firstDue !== "";

  /** Validates what is typed and adds it. Resolves true when the bill was added. */
  const addBill = async (): Promise<boolean> => {
    const errors: typeof problems = {};
    const cents = parseDollars(amount);
    if (name.trim() === "") errors.name = "Give it a name, like Rent.";
    if (cents === null || cents <= 0) errors.amount = "Enter dollars, like $2,150.00.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDue)) errors.due = "Pick the next due date.";
    setProblems(errors);
    if (Object.keys(errors).length > 0 || cents === null || !me) return false;
    try {
      await createBill.mutateAsync({
        name: name.trim(),
        amountCents: cents,
        repeats,
        firstDue,
        ownerUserId: me.id,
      });
    } catch {
      return false;
    }
    setName("");
    setAmount("");
    setFirstDue("");
    setCount((n) => n + 1);
    return true;
  };
  const add = () => void addBill();
  // Moving on with a half-typed bill would drop it silently: add a complete one, or show what is missing (§5.3).
  flushRef.current = async () => (pending ? addBill() : true);

  return (
    <section className={styles.panel} aria-label="Add a bill">
      <h2 className={styles.panelTitle}>Add a bill</h2>
      <TextField
        label="Name"
        placeholder="e.g. Rent"
        value={name}
        error={problems.name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className={styles.pair}>
        <TextField
          label="Amount"
          money
          placeholder="$0.00"
          value={amount}
          error={problems.amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <SelectField
          label="Repeats"
          value={repeats}
          options={REPEATS}
          onChange={(e) => setRepeats(e.target.value as ManualBill["repeats"])}
        />
      </div>
      <TextField
        label="Next due"
        type="date"
        value={firstDue}
        error={problems.due}
        onChange={(e) => setFirstDue(e.target.value)}
      />
      {createBill.isError && (
        <ErrorBanner title="We couldn’t add that bill.">
          {problemMessage(createBill.error, "Nothing was changed. Try again.")}
        </ErrorBanner>
      )}
      {count > 0 && <StatusBanner>{`${count} ${count === 1 ? "bill" : "bills"} added.`}</StatusBanner>}
      <div>
        <Button variant="secondary" disabled={createBill.isPending} onClick={add}>
          Add and enter another
        </Button>
      </div>
    </section>
  );
}

function EmailPanel({
  partnerName,
  onError,
  groupRef,
}: {
  partnerName: string;
  onError: (m: string) => void;
  groupRef: MutableRefObject<HTMLDivElement | null>;
}) {
  const start = useStartConnection();
  const forwarding = useForwarding();
  const connect = (provider: "gmail" | "outlook") =>
    start.mutate(
      { provider, returnTo: "/setup" },
      {
        onSuccess: ({ authUrl }) => {
          try {
            goToProvider(authUrl);
          } catch {
            onError(CONNECT_REFUSED);
          }
        },
        onError: (e) => onError(problemMessage(e, "We couldn’t start the connection. Try again.")),
      },
    );
  return (
    <section className={styles.panel} aria-label="Connect your email">
      <div ref={groupRef} role="group" aria-label="Choose your email provider" className={styles.providers}>
        <Button variant="secondary" size="mobile" disabled={start.isPending} onClick={() => connect("gmail")}>
          Continue with Google
        </Button>
        <Button
          variant="secondary"
          size="mobile"
          disabled={start.isPending}
          onClick={() => connect("outlook")}
        >
          Continue with Microsoft
        </Button>
      </div>
      {forwarding.data && (
        <p className={styles.small}>
          Other email? Forward bills to <strong>{forwarding.data.address}</strong>
        </p>
      )}
      <ul className={styles.bullets}>
        <li>Only bills, renewals, receipts and statements, never personal mail</li>
        <li>We keep what we extract, not your emails</li>
        <li>{`${partnerName} sees the bills we find, never your inbox`}</li>
      </ul>
    </section>
  );
}

/** Household setup, step 3 of 4 (canvas "Mobile · Household setup"): choose how to add bills and income. */
export function SetupScreen() {
  const household = useActiveHousehold();
  const { me } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const summary = useSummary();
  const connections = useConnections();
  const csv = useCsvFlow();
  const [method, setMethod] = useState<Method>("email");
  const [result, setResult] = useState<ConnectResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const flushManual: Flush = useRef(null);
  const providerGroup = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const parsed = parseConnectResult(window.location.search);
    if (!parsed) return;
    setResult(parsed);
    window.history.replaceState(null, "", window.location.pathname);
    if (parsed.kind === "connected") void queryClient.invalidateQueries();
  }, [queryClient]);

  if (!household) return <CreateHousehold onCreated={() => router.refresh()} />;

  const partner = summary.data?.members.find((m) => m.userId !== me?.id)?.firstName ?? null;
  // A paused or broken inbox is not a finished step: only a working connection moves setup on.
  const connected = connections.data?.some((c) => c.status === "connected") ?? false;

  let cta: { label: string; disabled: boolean; hint?: string; run: () => void };
  if (method === "email") {
    cta = {
      label: connected ? "Continue to your overview" : "Connect and scan my inbox",
      disabled: false,
      // The bar does not pick a provider for you: it takes you to the choice (Google or Microsoft).
      run: () => {
        if (connected) router.push("/overview");
        else providerGroup.current?.querySelector("button")?.focus();
      },
    };
  } else if (method === "csv") {
    const n = csv.selectedCount;
    cta = {
      label: `Confirm ${n} ${n === 1 ? "item" : "items"} and build my month`,
      disabled: n === 0 || csv.busy,
      hint: n === 0 ? "Choose a file, then check the items to keep." : undefined,
      run: () => void csv.confirm().then((ok) => ok && router.push("/overview")),
    };
  } else {
    cta = {
      label: "Continue to your overview",
      disabled: false,
      run: () =>
        void (flushManual.current?.() ?? Promise.resolve(true)).then((ok) => ok && router.push("/overview")),
    };
  }

  return (
    <div className={styles.page}>
      <Progress step={3} />
      <h1 className={styles.title}>Add what comes in and goes out</h1>
      <p className={styles.subtitle}>MoneyPilot builds your first month from this. No bank login needed.</p>

      <div className={styles.card}>
        <Done>
          {"Household created · "}
          <strong>{household.name}</strong>
        </Done>
        <InviteLine partnerName={partner} />
      </div>

      {result?.kind === "connected" && <StatusBanner>{result.message}</StatusBanner>}
      {result?.kind === "error" && (
        <ErrorBanner title="We couldn’t connect that account.">{result.message}</ErrorBanner>
      )}
      {failure && <ErrorBanner title="That didn’t go through.">{failure}</ErrorBanner>}

      <RadioCardGroup<Method | "bank">
        label="How to add bills and income"
        value={method}
        onChange={(value) => value !== "bank" && setMethod(value)}
        options={[
          {
            value: "email",
            title: "Connect your email",
            icon: Mail,
            badge: <StatusChip variant="ok">Recommended</StatusChip>,
            description: "We find bills, insurance renewals and subscriptions for you. Read-only.",
          },
          {
            value: "csv",
            title: "Import a bank CSV",
            icon: Upload,
            description: "We spot repeating bills and paychecks. You confirm each one.",
          },
          {
            value: "manual",
            title: "Enter manually",
            icon: Pencil,
            description: "Start with your 5 biggest bills. Takes about 3 minutes.",
          },
          {
            value: "bank",
            title: "Connect a bank",
            icon: Lock,
            disabled: true,
            description: "Coming later. Tell us if you’d use it.",
          },
        ]}
      />

      {method === "email" && (
        <EmailPanel partnerName={partner ?? "Your partner"} onError={setFailure} groupRef={providerGroup} />
      )}
      {method === "csv" && (
        <section className={styles.panel} aria-label="Import a bank CSV">
          <CsvPanel flow={csv} />
        </section>
      )}
      {method === "manual" && <ManualPanel flushRef={flushManual} />}

      <p className={styles.privacy}>
        <Lock size={16} aria-hidden="true" />
        <span>
          Each partner has their own login. Export or delete your household’s data anytime. We never sell it.
        </span>
      </p>

      <div className={styles.ctaBar}>
        {cta.hint && <p className={styles.ctaHint}>{cta.hint}</p>}
        <Button size="mobileBar" className={styles.barButton} disabled={cta.disabled} onClick={cta.run}>
          {cta.label}
        </Button>
      </div>
    </div>
  );
}
