"use client";

import {
  Button,
  CalendarCell,
  ErrorBanner,
  IconButton,
  Loading,
  OwnerDot,
  SegmentedControl,
  Skeleton,
} from "@mp/ui";
import type { EventChipProps } from "@mp/ui";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useCalendar, usePlan } from "../../../lib/api/hooks";
import type { CalendarDayDto, CalendarEntryDto, CalendarResponse } from "../../../lib/api/planning-types";
import { addMonths, monthTitle, parseDate, yearMonthOf } from "../../../lib/format/dates";
import { useOwners } from "../../../lib/owners";
import type { Owners } from "../../../lib/owners";
import { DayPanel, Glance } from "./DayPanel";
import styles from "./calendar.module.css";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function chip(entry: CalendarEntryDto, owners: Owners): EventChipProps {
  return {
    kind: entry.kind === "goal_transfer" ? "planned" : entry.kind,
    owner: owners.role(entry.owner),
    name: entry.name,
    amountCents: entry.amountCents,
  };
}

/** Sunday-first weeks covering the month, padded with days of the neighbouring months. */
function weeksOf(calendar: CalendarResponse): Array<Array<{ iso: string; day: CalendarDayDto | null }>> {
  const byDate = new Map(calendar.days.map((d) => [d.date, d]));
  const first = parseDate(calendar.days[0]?.date ?? `${calendar.month}-01`);
  const last = parseDate(calendar.days[calendar.days.length - 1]?.date ?? `${calendar.month}-28`);
  // Temporal: Monday = 1 … Sunday = 7; the grid starts on Sunday.
  const start = first.subtract({ days: first.dayOfWeek % 7 });
  const end = last.add({ days: 6 - (last.dayOfWeek % 7) });
  const weeks: Array<Array<{ iso: string; day: CalendarDayDto | null }>> = [];
  for (let d = start; d.toString() <= end.toString(); d = d.add({ days: 1 })) {
    const iso = d.toString();
    if (d.dayOfWeek % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1]?.push({ iso, day: byDate.get(iso) ?? null });
  }
  return weeks;
}

export function CalendarScreen() {
  const plan = usePlan();
  const owners = useOwners();
  const router = useRouter();
  const [owner, setOwner] = useState<string>("all");
  const [viewMonth, setViewMonth] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);

  // Default selection (§5.1): the day of the top "Decide this week" item, otherwise today.
  const defaultDay = plan.data ? (plan.data.decisions[0]?.date ?? plan.data.asOf) : null;
  const month = viewMonth ?? (defaultDay ? yearMonthOf(defaultDay) : null);
  const calendar = useCalendar(month, owner === "all" ? undefined : owner);
  // "{Month} at a glance" is the household's month whatever the owner filter shows.
  const whole = useCalendar(month, undefined);
  const selected =
    picked ?? (defaultDay && yearMonthOf(defaultDay) === month ? defaultDay : month ? `${month}-01` : null);

  const weeks = useMemo(() => (calendar.data ? weeksOf(calendar.data) : []), [calendar.data]);

  // On a narrow screen the grid scrolls inside its card: keep the selected day in view.
  useEffect(() => {
    const card = cardRef.current;
    const cell = selected ? gridRef.current?.querySelector(`[data-date="${selected}"]`) : null;
    if (!card || !cell) return;
    const c = card.getBoundingClientRect();
    const r = cell.getBoundingClientRect();
    if (r.left < c.left || r.right > c.right) card.scrollLeft += r.left - c.left - (c.width - r.width) / 2;
  }, [selected, calendar.data?.month]);

  const failed = plan.isError || calendar.isError || whole.isError;
  const retry = () => {
    void plan.refetch();
    void calendar.refetch();
    void whole.refetch();
  };

  if (failed && !(calendar.data && whole.data && owners)) {
    return (
      <>
        <h1 className={styles.monthTitle}>Calendar</h1>
        <ErrorBanner title="We couldn’t load the calendar." onRetry={retry}>
          Nothing was changed. Nothing is shown until it loads.
        </ErrorBanner>
      </>
    );
  }
  if (!calendar.data || !whole.data || !owners || !month || !selected) {
    return (
      <>
        <h1 className={styles.monthTitle}>Calendar</h1>
        <Loading label="Loading the calendar">
          <Skeleton shape="block" height="480px" />
        </Loading>
      </>
    );
  }

  const data = calendar.data;
  const days = new Map(data.days.map((d) => [d.date, d]));
  const selectedDay = days.get(selected) ?? null;

  function go(delta: number) {
    const next = addMonths(month ?? data.month, delta);
    setViewMonth(next);
    setPicked(null);
  }

  /** Arrow keys move between days; Home/End jump within the week; PageUp/PageDown change month. */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const iso = target.getAttribute("data-date");
    if (!iso) return;
    const date = parseDate(iso);
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
      Home: -(date.dayOfWeek % 7),
      End: 6 - (date.dayOfWeek % 7),
    };
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      go(event.key === "PageUp" ? -1 : 1);
      return;
    }
    const delta = moves[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const next = date.add({ days: delta }).toString();
    if (days.has(next)) gridRef.current?.querySelector<HTMLElement>(`[data-date="${next}"]`)?.focus();
  }

  return (
    <>
      {failed && (
        <ErrorBanner title="We couldn’t refresh the calendar." onRetry={retry}>
          The days below are the last ones we loaded.
        </ErrorBanner>
      )}
      <div className={styles.header}>
        <div className={styles.monthNav}>
          <IconButton shape="mobile" icon={ChevronLeft} label="Previous month" onClick={() => go(-1)} />
          <h1 className={styles.monthTitle} aria-live="polite">
            {monthTitle(data.month)}
          </h1>
          <IconButton shape="mobile" icon={ChevronRight} label="Next month" onClick={() => go(1)} />
        </div>
        <div className={styles.headerActions}>
          <SegmentedControl
            label="Show bills owned by"
            value={owner}
            onChange={setOwner}
            onCanvas
            options={[
              { value: "all", label: "Both" },
              ...owners.members.map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
          <Button icon={Plus} onClick={() => router.push("/bills")}>
            Add to calendar
          </Button>
        </div>
      </div>

      <ul className={styles.legend} aria-label="Legend">
        <li>
          <span className={`${styles.key} ${styles.keyIncome}`} aria-hidden="true" />
          Income
        </li>
        <li>
          <span className={`${styles.key} ${styles.keyBill}`} aria-hidden="true" />
          Bill
        </li>
        <li>
          <span className={`${styles.key} ${styles.keyEstimate}`} aria-hidden="true" />
          Estimate
        </li>
        <li>
          <span className={`${styles.key} ${styles.keyDecision}`} aria-hidden="true" />
          Needs a decision
        </li>
        {owners.members.map((m) => (
          <li key={m.id}>
            <OwnerDot role={m.role} />
            {m.name}
          </li>
        ))}
        <li>
          <OwnerDot role="both" />
          Both
        </li>
      </ul>

      <div className={styles.body}>
        <section ref={cardRef} className={styles.gridCard} aria-label={`${monthTitle(data.month)} calendar`}>
          <div className={styles.grid}>
            <div className={styles.weekdays} aria-hidden="true">
              {WEEKDAYS.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>
            {/* One tab stop (the selected day); arrow keys move between days. */}
            <div className={styles.weeks} ref={gridRef} role="group" aria-label="Days" onKeyDown={onKeyDown}>
              {weeks.map((week) => (
                <div key={week[0]?.iso} className={styles.week}>
                  {week.map(({ iso, day }) => (
                    <CalendarCell
                      key={iso}
                      date={parseDate(iso)}
                      data-date={iso}
                      tabIndex={iso === selected ? 0 : -1}
                      outsideMonth={day === null}
                      payday={day?.isPayday ?? false}
                      selected={iso === selected}
                      chipLayout="line"
                      events={day ? day.entries.map((e) => chip(e, owners)) : []}
                      onSelect={() => setPicked(iso)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <p className={styles.hint}>Use the arrow keys to move between days, and Enter to select one.</p>
        </section>

        <div className={styles.side}>
          <DayPanel day={selectedDay} owners={owners} offsets={data.reminderOffsetsDays} />
          <Glance calendar={whole.data} />
        </div>
      </div>

      <p className={styles.footer}>
        {plan.data?.dataSource.isSample ? "Sample data · " : ""}Select any day to see who owns it and why it’s
        flagged
      </p>
    </>
  );
}
