// Cash runway chart (DESIGN_SPEC §4.1). Every value comes from the caller (the engine via the
// API): balances, paydays, the lowest day and the cushion. This file only draws them.
import type { PlainDateLike } from "@mp/format";
import { date, money } from "@mp/format";
import { useId } from "react";
import type { CSSProperties } from "react";
import { cx } from "../internal/cx";
import type { CalendarDate } from "../internal/types";
import shared from "../internal/shared.module.css";
import styles from "./runway-chart.module.css";

const DOLLARS_1000 = 100000;

export interface RunwayEvent {
  /** Short name drawn under the bar: "Rent", "Daycare & TV". */
  label: string;
  /** The day's signed net change in cents (outflows negative). */
  amountCents: number;
  /** The amount includes an estimate (shown with "~"). */
  estimate?: boolean;
}

export interface RunwayDay {
  date: CalendarDate;
  /** Projected end-of-day balance in cents (§6 rule 2). */
  balanceCents: number;
  /** An income date. Drawn in chart.payday. */
  payday?: boolean;
  event?: RunwayEvent;
}

export interface RunwayChartProps {
  /** One entry per day, today through the next primary payday, inclusive. */
  days: readonly RunwayDay[];
  /** The engine's single lowest day (§6 rule 3), ISO `YYYY-MM-DD`. */
  lowestDate: string;
  cushionCents: number;
  /** Household-local today; dates in its year omit the year. */
  today: Pick<PlainDateLike, "year">;
  /** Accessible name of the data table. */
  label?: string;
  /** Hide the legend when the card header already shows it. */
  showLegend?: boolean;
  /** Base for element ids; defaults to a React id. */
  id?: string;
}

export interface RunwayScale {
  maxCents: number;
  minCents: number;
}

/**
 * The y-axis: 0 to the max balance rounded up to the next $1,000. With a negative balance, the
 * space below $0 is the lowest balance rounded down to the next −$1,000, on the same scale.
 */
export function runwayScale(days: ReadonlyArray<Pick<RunwayDay, "balanceCents">>): RunwayScale {
  let max = 0;
  let min = 0;
  for (const d of days) {
    max = Math.max(max, d.balanceCents);
    min = Math.min(min, d.balanceCents);
  }
  const maxCents = Math.max(DOLLARS_1000, Math.ceil(max / DOLLARS_1000) * DOLLARS_1000);
  const minCents = min < 0 ? -Math.ceil(-min / DOLLARS_1000) * DOLLARS_1000 : 0;
  return { maxCents, minCents };
}

/**
 * A share of the plot, as a unitless number (4 decimals, stable for snapshots). The CSS turns it
 * into a length: `calc(var(--plot-h) * var(--h))`, where --plot-h is 230 minus headroom and
 * the room reserved for negative labels.
 */
function ratio(part: number, whole: number): string {
  if (whole === 0) return "0";
  return String(Number((part / whole).toFixed(4)));
}

/** A percentage for the mini runway's inline geometry. */
function pct(part: number, whole: number): string {
  if (whole === 0) return "0%";
  return `${Number(((part / whole) * 100).toFixed(4))}%`;
}

type CssVars = Record<`--${string}`, string>;
function cssVars(vars: CssVars): CSSProperties {
  return vars as CSSProperties;
}

type BarKind = "balance" | "payday" | "lowest" | "negative";

function barKind(day: RunwayDay, isLowest: boolean): BarKind {
  if (isLowest) return "lowest";
  if (day.balanceCents < 0) return "negative";
  return day.payday ? "payday" : "balance";
}

/** The date label: month and day on the first bar and on the 1st, otherwise the day number. */
function dateLabel(day: RunwayDay, index: number, today: Pick<PlainDateLike, "year">): string {
  return index === 0 || day.date.day === 1 ? date(day.date, { relativeTo: today }) : String(day.date.day);
}

function eventLabel(day: RunwayDay, index: number): string {
  if (day.event)
    return `${day.event.label} ${money(day.event.amountCents, { mode: "chart", estimate: day.event.estimate })}`;
  return index === 0 ? "Today" : "—";
}

export function RunwayChart({
  days,
  lowestDate,
  cushionCents,
  today,
  label = "Projected end-of-day balance to payday",
  showLegend = true,
  id,
}: RunwayChartProps) {
  const { maxCents, minCents } = runwayScale(days);
  const range = maxCents - minCents;
  const hasNegative = minCents < 0;
  const autoId = useId();
  const captionId = `${id ?? autoId}-caption`;
  const cushionLabel = `${money(cushionCents, { mode: "headline" })} cushion`;

  return (
    <div className={styles.chart}>
      {showLegend && (
        <ul className={styles.legend} aria-label="Legend">
          <li>
            <span className={cx(styles.swatch, styles.swatchBalance)} aria-hidden="true" />
            Balance
          </li>
          <li>
            <span className={cx(styles.swatch, styles.swatchPayday)} aria-hidden="true" />
            Payday
          </li>
          <li>
            <span className={cx(styles.swatch, styles.swatchLowest)} aria-hidden="true" />
            Lowest point
          </li>
          <li>
            <span className={styles.swatchCushion} aria-hidden="true" />
            {cushionLabel}
          </li>
        </ul>
      )}

      {/* Focusable so keyboard users can scroll it below 620 px. */}
      <div
        className={styles.scroll}
        tabIndex={0}
        role="group"
        aria-label="Runway chart, scrolls sideways"
        aria-describedby={captionId}
      >
        <div className={styles.inner} aria-hidden="true">
          <div
            className={cx(styles.plot, hasNegative && styles.hasNegative)}
            style={cssVars({
              "--axis": ratio(-minCents, range),
              "--cushion": ratio(cushionCents - minCents, range),
            })}
          >
            <div className={styles.cushion} data-runway-cushion="" />
            <div
              className={cx(styles.axis, hasNegative && styles.axisZero)}
              data-runway-axis=""
              data-negative={String(hasNegative)}
            />
            {days.map((day, index) => {
              const iso = day.date.toString();
              const isLowest = iso === lowestDate;
              const kind = barKind(day, isLowest);
              const negative = day.balanceCents < 0;
              const value = money(day.balanceCents, { mode: "headline" });
              const tooltip = isLowest ? <span className={styles.tooltip}>{`Lowest · ${value}`}</span> : null;
              const valueLabel = <span className={cx(styles.value, styles[`value-${kind}`])}>{value}</span>;
              return (
                <div
                  key={iso}
                  className={styles.column}
                  data-runway-bar=""
                  data-edge={index === 0 ? "first" : index === days.length - 1 ? "last" : undefined}
                  data-date={iso}
                  data-kind={kind}
                  data-value={value}
                  data-negative={String(negative)}
                >
                  <div
                    className={styles.positive}
                    data-region="positive"
                    style={cssVars({ "--region": ratio(maxCents, range) })}
                  >
                    {!negative && (
                      <span className={styles.valueWrap}>
                        {tooltip && <span className={styles.tooltipAbove}>{tooltip}</span>}
                        {valueLabel}
                      </span>
                    )}
                    {!negative && (
                      <span
                        className={cx(styles.bar, styles[`bar-${kind}`])}
                        data-bar=""
                        style={cssVars({ "--h": ratio(day.balanceCents, range) })}
                      />
                    )}
                  </div>
                  {hasNegative && (
                    <div
                      className={styles.negative}
                      data-region="negative"
                      style={cssVars({ "--region": ratio(-minCents, range) })}
                    >
                      {negative && (
                        <span
                          className={cx(styles.bar, styles.barDown, styles[`bar-${kind}`])}
                          data-bar=""
                          style={cssVars({ "--h": ratio(-day.balanceCents, range) })}
                        />
                      )}
                      {negative && valueLabel}
                      {negative && tooltip}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className={styles.labels}>
            {days.map((day, i) => (
              <div key={day.date.toString()} className={styles.label} data-runway-label="">
                <span className={styles.date}>{dateLabel(day, i, today)}</span>
                <span className={styles.event}>{eventLabel(day, i)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* A table ignores width and overflow, so the hidden wrapper clips it; otherwise it widens the page. */}
      <div className={shared.visuallyHidden}>
        <table>
          <caption id={captionId}>{label}</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Projected balance</th>
              <th scope="col">Scheduled</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => {
              const iso = day.date.toString();
              const note = iso === lowestDate ? "Lowest" : day.payday ? "Payday" : "";
              const scheduled = day.event
                ? `${day.event.label} ${day.event.estimate ? "~" : ""}${money(day.event.amountCents, { mode: "signed" })}`
                : "Nothing scheduled";
              return (
                <tr key={iso}>
                  <th scope="row">{date(day.date, { relativeTo: today, weekday: true })}</th>
                  <td>{money(day.balanceCents, { mode: "headline" })}</td>
                  <td>{scheduled}</td>
                  <td>{note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export interface RunwayMiniProps {
  days: ReadonlyArray<Pick<RunwayDay, "date" | "balanceCents" | "payday">>;
  lowestDate: string;
}

/**
 * The mobile hero's mini runway (§4.1): decorative, on brand.strong. Negative bars hang below a
 * brand.onStrongMuted zero line (§5.2 shortfall state). The hero text carries the meaning.
 */
export function RunwayMini({ days, lowestDate }: RunwayMiniProps) {
  const { maxCents, minCents } = runwayScale(days);
  const range = maxCents - minCents;
  const hasNegative = minCents < 0;
  return (
    <div className={styles.mini} aria-hidden="true">
      {hasNegative && <div className={styles.miniZero} style={{ bottom: pct(-minCents, range) }} />}
      {days.map((day) => {
        const iso = day.date.toString();
        const negative = day.balanceCents < 0;
        const kind = iso === lowestDate || negative ? "lowest" : day.payday ? "payday" : "balance";
        return (
          <div key={iso} className={styles.miniColumn}>
            <div className={styles.miniPositive} style={{ height: pct(maxCents, range) }}>
              {!negative && (
                <span
                  className={cx(styles.miniBar, styles[`mini-${kind}`])}
                  data-mini-bar=""
                  data-negative="false"
                  style={{ height: pct(day.balanceCents, maxCents) }}
                />
              )}
            </div>
            {hasNegative && (
              <div className={styles.miniNegative} style={{ height: pct(-minCents, range) }}>
                {negative && (
                  <span
                    className={cx(styles.miniBar, styles.miniBarDown, styles[`mini-${kind}`])}
                    data-mini-bar=""
                    data-negative="true"
                    style={{ height: pct(-day.balanceCents, -minCents) }}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
