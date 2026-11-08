"use client";

import { Amount, Button, ErrorBanner, SelectField, Skeleton, StatusBanner, VisuallyHidden } from "@mp/ui";
import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import type { ColumnMapping, Import } from "../../../lib/api/imports-types";
import type { CsvFlow } from "./csv-flow";
import styles from "./csv-panel.module.css";

const FIRST_ROWS = 4;
const NONE = "";

/** One select per column the file may have; the person says which is which (WP-16 `needs_mapping`). */
function MappingForm({
  imported,
  busy,
  onSave,
}: {
  imported: Import;
  busy: boolean;
  onSave: (m: ColumnMapping) => void;
}) {
  const columns = imported.columns ?? [];
  const suggested = imported.suggestedMapping;
  const [date, setDate] = useState(suggested?.date ?? NONE);
  const [description, setDescription] = useState(suggested?.description ?? NONE);
  const [kind, setKind] = useState<"amount" | "split">(
    suggested?.debit || suggested?.credit ? "split" : "amount",
  );
  const [amount, setAmount] = useState(suggested?.amount ?? NONE);
  const [debit, setDebit] = useState(suggested?.debit ?? NONE);
  const [credit, setCredit] = useState(suggested?.credit ?? NONE);
  const [sign, setSign] = useState<ColumnMapping["amountSign"]>(suggested?.amountSign ?? "outflow_negative");
  const [problem, setProblem] = useState<string | null>(null);
  const options = (blank: string) => [
    { value: NONE, label: blank },
    ...columns.map((c) => ({ value: c, label: c })),
  ];

  const save = () => {
    if (date === NONE || description === NONE) {
      setProblem("Choose the date column and the description column.");
      return;
    }
    if (kind === "amount" ? amount === NONE : debit === NONE && credit === NONE) {
      setProblem(kind === "amount" ? "Choose the amount column." : "Choose the debit or credit column.");
      return;
    }
    setProblem(null);
    onSave(
      kind === "amount"
        ? { date, description, amount, amountSign: sign }
        : {
            date,
            description,
            ...(debit !== NONE ? { debit } : {}),
            ...(credit !== NONE ? { credit } : {}),
            amountSign: sign,
          },
    );
  };

  return (
    <section className={styles.mapping} aria-label="Match the columns">
      <h3 className={styles.foundTitle}>Which column is which?</h3>
      <p className={styles.hint}>
        We couldn’t tell from the header row. Choose once and we’ll remember it for files like this one.
      </p>
      <SelectField
        label="Date"
        value={date}
        options={options("Choose a column")}
        onChange={(e) => setDate(e.target.value)}
      />
      <SelectField
        label="Description"
        value={description}
        options={options("Choose a column")}
        onChange={(e) => setDescription(e.target.value)}
      />
      <SelectField
        label="Amounts are in"
        value={kind}
        options={[
          { value: "amount", label: "One amount column" },
          { value: "split", label: "Separate debit and credit columns" },
        ]}
        onChange={(e) => setKind(e.target.value as "amount" | "split")}
      />
      {kind === "amount" ? (
        <>
          <SelectField
            label="Amount"
            value={amount}
            options={options("Choose a column")}
            onChange={(e) => setAmount(e.target.value)}
          />
          <SelectField
            label="Money going out is"
            value={sign}
            options={[
              { value: "outflow_negative", label: "Negative (−45.00)" },
              { value: "outflow_positive", label: "Positive (45.00)" },
            ]}
            onChange={(e) => setSign(e.target.value as ColumnMapping["amountSign"])}
          />
        </>
      ) : (
        <>
          <SelectField
            label="Debit (money out)"
            value={debit}
            options={options("None")}
            onChange={(e) => setDebit(e.target.value)}
          />
          <SelectField
            label="Credit (money in)"
            value={credit}
            options={options("None")}
            onChange={(e) => setCredit(e.target.value)}
          />
        </>
      )}
      {problem && <ErrorBanner title="Check the columns.">{problem}</ErrorBanner>}
      <div>
        <Button variant="secondary" disabled={busy} onClick={save}>
          Use these columns
        </Button>
      </div>
    </section>
  );
}

/**
 * The CSV step (DESIGN_SPEC §5.2): pick a file, match its columns if we need to, then check the repeating bills
 * and paychecks we found. `showFound` is false in the Email & imports dialog, where the found items go straight
 * to the review queue on the page behind it.
 */
export function CsvPanel({ flow, showFound = true }: { flow: CsvFlow; showFound?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [showAll, setShowAll] = useState(false);

  if (flow.stage === "mapping" && flow.imported) {
    return (
      <>
        <MappingForm imported={flow.imported} busy={flow.busy} onSave={flow.saveMapping} />
        {flow.error && <ErrorBanner title="That didn’t work.">{flow.error}</ErrorBanner>}
      </>
    );
  }

  const imported = flow.imported;
  const rows = showAll ? flow.rows : flow.rows.slice(0, FIRST_ROWS);
  const hidden = flow.rows.length - rows.length;
  return (
    <div className={styles.pick}>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        className={styles.fileInput}
        aria-label="Bank CSV file"
        tabIndex={-1}
        onChange={(event) => {
          flow.chooseFile(event.target.files?.[0] ?? null);
          event.target.value = "";
        }}
      />
      <Button variant="secondary" icon={Upload} disabled={flow.busy} onClick={() => input.current?.click()}>
        {imported ? "Choose another file" : "Choose a CSV file"}
      </Button>
      <p className={styles.hint}>
        Export a month or more from your bank. We find repeating bills and paychecks. You confirm each one,
        and the file is not kept after we read it.
      </p>
      {flow.stage === "working" && (
        <div role="status" aria-busy="true">
          <VisuallyHidden>Reading your file</VisuallyHidden>
          <Skeleton shape="block" height="96px" />
        </div>
      )}
      {flow.error && <ErrorBanner title="That didn’t work.">{flow.error}</ErrorBanner>}
      {imported && (
        <StatusBanner>
          {imported.detectedCount
            ? `Read ${imported.filename}. Found ${imported.detectedCount} repeating ${imported.detectedCount === 1 ? "item" : "items"}${
                imported.queuedCount !== null && imported.queuedCount < imported.detectedCount
                  ? `, ${imported.queuedCount} new to you`
                  : ""
              }.`
            : `Read ${imported.filename}. We didn’t find any repeating bills or paychecks in it.`}
        </StatusBanner>
      )}
      {showFound && flow.rows.length > 0 && (
        <section className={styles.found} aria-label="Found in your bank CSV">
          <div className={styles.foundHead}>
            <h3 className={styles.foundTitle}>
              {imported ? `Found in ${imported.filename}` : "Found in your bank CSV"}
            </h3>
            <span className={styles.foundCount}>{`${flow.rows.length} items`}</span>
          </div>
          <ul className={styles.list}>
            {rows.map((row) => (
              <li key={row.id}>
                <label className={styles.row}>
                  <input
                    type="checkbox"
                    className={styles.check}
                    checked={flow.checked.has(row.id)}
                    onChange={() => flow.toggle(row.id)}
                  />
                  <span className={styles.rowText}>
                    <span className={styles.rowName}>{row.name}</span>
                    <span className={styles.rowMeta}>{row.label}</span>
                  </span>
                  {row.amountCents !== null && (
                    <Amount cents={row.amountCents} mode={row.income ? "signed" : "detail"} strong />
                  )}
                </label>
              </li>
            ))}
          </ul>
          {hidden > 0 && (
            <Button variant="text" size="compact" onClick={() => setShowAll(true)}>
              {`Review ${hidden} more`}
            </Button>
          )}
        </section>
      )}
    </div>
  );
}
