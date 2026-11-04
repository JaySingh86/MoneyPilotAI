"use client";

import { money } from "@mp/format";
import { IconButton, MathBreakdown } from "@mp/ui";
import type { MathRow } from "@mp/ui";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { MathLine, PlanResponse } from "../../../lib/api/planning-types";
import { shortDate } from "../../../lib/format/dates";
import { fillTemplate } from "../../../lib/format/templates";
import type { DrawerFocus } from "./Decisions";
import styles from "./math-drawer.module.css";

/** Engine math lines → rows (§4 math breakdown). Subtract rows show with a minus sign. */
export function mathRows(plan: PlanResponse): MathRow[] {
  const rows: MathRow[] = [];
  for (const line of plan.math as MathLine[]) {
    if (line.cents === null) continue;
    switch (line.role) {
      case "subtract":
        rows.push({ label: line.label, cents: -line.cents });
        break;
      case "total":
        rows.push({ label: line.label, cents: line.cents, mode: "headline", kind: "total" });
        break;
      case "gap":
        rows.push({ label: line.label, cents: -line.cents, mode: "headline", kind: "gap" });
        break;
      case "value":
        rows.push({
          label:
            line.date && line.id === "lowest_point"
              ? `${line.label} on ${shortDate(line.date, plan.asOf)}`
              : line.label,
          cents: line.cents,
        });
    }
  }
  return rows;
}

/** "See the math": the engine's steps, and for a "Plan for it" card the what-if it computed. */
export function MathDrawer({
  plan,
  focus,
  onClose,
}: {
  plan: PlanResponse;
  focus: DrawerFocus;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);

  /** Ends the modal state first, so focus can go back to what opened the drawer. */
  const close = () => {
    const dialog = ref.current;
    if (dialog?.open && typeof dialog.close === "function") dialog.close();
    opener.current?.focus();
    onClose();
  };

  const perDay = plan.perDayCents;
  const decision = focus.kind === "what-if" ? focus.decision : null;
  const altDate = decision?.params.altDate;
  const altSafe = decision?.params.altSafeToSpendCents;

  return (
    <dialog
      ref={ref}
      className={styles.drawer}
      aria-labelledby="math-title"
      onClose={close}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className={styles.header}>
        <h2 id="math-title" className={styles.title}>
          {decision ? "Plan for it" : "See the math"}
        </h2>
        <IconButton icon={X} label="Close" onClick={close} autoFocus />
      </div>

      {decision && typeof altDate === "string" && typeof altSafe === "number" && (
        <section className={styles.section} aria-label="What if">
          <h3 className={styles.sectionTitle}>
            {fillTemplate(decision.templateText, decision.params, plan.asOf)}
          </h3>
          <dl className={styles.compare}>
            <div>
              <dt>Today’s plan</dt>
              <dd>{money(plan.safeToSpendCents, { mode: "headline" })}</dd>
            </div>
            <div>
              <dt>{`Paying on ${shortDate(altDate, plan.asOf)} instead`}</dt>
              <dd>{money(altSafe, { mode: "headline" })}</dd>
            </div>
          </dl>
          <p className={styles.note}>
            Safe to spend is shown for each plan. Only if your provider allows it.
          </p>
        </section>
      )}

      <MathBreakdown rows={mathRows(plan)} />
      {perDay !== null && (
        <p className={styles.note}>
          {`Safe to spend is spread over ${plan.window.daysToPayday} days to payday and rounded down to the nearest $5: about ${money(perDay, { mode: "headline" })} a day.`}
        </p>
      )}
      <p className={styles.note}>
        Calculated by MoneyPilot’s planning rules from your bills, income and the latest balance. Nothing here
        moves money.
      </p>
    </dialog>
  );
}
