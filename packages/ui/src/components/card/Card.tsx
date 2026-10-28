// Cards, DESIGN_SPEC §4: standard, hero (with the shortfall variant) and attention.
import { money, shortfall } from "@mp/format";
import type { HeadlineRounding } from "@mp/format";
import { TriangleAlert } from "lucide-react";
import { useEffect, useId } from "react";
import type { ReactNode } from "react";
import { cx } from "../internal/cx";
import { Icon } from "../internal/Icon";
import type { Density } from "../internal/types";
import styles from "./card.module.css";

type HeadingLevel = 2 | 3 | 4;

function Heading({
  level,
  id,
  className,
  children,
}: {
  level: HeadingLevel;
  id: string;
  className?: string;
  children: ReactNode;
}) {
  const Tag = `h${level}` as const;
  return (
    <Tag id={id} className={className}>
      {children}
    </Tag>
  );
}

export interface CardProps {
  /** `heading-2` on web, `heading-2m` on mobile. Names the card's region. */
  title?: string;
  /** A `small` muted line 2 px under the title. */
  subtitle?: ReactNode;
  /** Header actions or a count chip, on the right. */
  actions?: ReactNode;
  headingLevel?: HeadingLevel;
  density?: Density;
  children?: ReactNode;
  className?: string;
}

/** Standard card: surface, 1 px border.default, radius 3xl / padding 22 on web, 2xl / 14 on mobile. */
export function Card({
  title,
  subtitle,
  actions,
  headingLevel = 2,
  density = "web",
  children,
  className,
}: CardProps) {
  const id = useId();
  return (
    <section
      aria-labelledby={title ? id : undefined}
      className={cx(styles.card, density === "mobile" && styles.mobile, className)}
    >
      {(title || actions) && (
        <div className={styles.header}>
          {title && (
            <div className={styles.titles}>
              <Heading level={headingLevel} id={id} className={styles.title}>
                {title}
              </Heading>
              {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
            </div>
          )}
          {actions && <div className={styles.actions}>{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

interface HeroCommon {
  /** Safe to spend (or the hero's figure) in cents, from the engine. */
  amountCents: number;
  /** The breakdown row, drawn on a brand.strongDivider top rule. Links in it sit at the end. */
  breakdown?: ReactNode;
  /** Extra content such as the mobile mini runway. */
  children?: ReactNode;
  headingLevel?: HeadingLevel;
  density?: Density;
  className?: string;
}

export type HeroCardProps = HeroCommon &
  (
    | {
        variant?: "default";
        /** "Safe to spend until Fri, Nov 6". */
        label: string;
        /** Spendable money floors (default); averages and summaries use `nearest` (§7). */
        rounding?: HeadlineRounding;
        /**
         * Top-right text, 12 px onStrongMuted: the per-day line "≈ $100 a day for 10 days" (the
         * engine's `perDayDisplay` plus the day count) or "On track". The amount must not be
         * negative; use the shortfall variant below $0.
         */
        status?: string;
      }
    | {
        /** Safe to spend below 0 (§5.3): "Short before {payday}", "$X short", a decision chip. */
        variant: "shortfall";
        /** "Fri, Nov 6". */
        paydayLabel: string;
        /** Beside the amount: the dates below the cushion and below $0. */
        caption?: ReactNode;
      }
  );

/** The hero card: brand.strong, white text. One per screen. */
export function HeroCard(props: HeroCardProps) {
  const { amountCents, breakdown, children, headingLevel = 2, density = "web", className } = props;
  const id = useId();
  const isShortfall = props.variant === "shortfall";
  const caption = props.variant === "shortfall" ? props.caption : undefined;
  const misused = !isShortfall && amountCents < 0;
  useEffect(() => {
    if (misused && process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console -- dev-only guard against a wrong variant; stripped in production
      console.warn('HeroCard: a negative amount needs variant="shortfall" (DESIGN_SPEC §4, §5.3).');
    }
  }, [misused]);
  const label = isShortfall ? `Short before ${props.paydayLabel}` : props.label;
  const amount = isShortfall
    ? shortfall(amountCents)
    : money(amountCents, { mode: "headline", rounding: props.rounding ?? "floor" });
  const status = isShortfall ? null : props.status;

  return (
    <section
      aria-labelledby={id}
      className={cx(styles.hero, density === "mobile" && styles.heroMobile, className)}
      data-variant={isShortfall ? "shortfall" : "default"}
    >
      <div className={styles.heroHeader}>
        <Heading level={headingLevel} id={id} className={styles.heroLabel}>
          {label}
        </Heading>
        {isShortfall && <span className={styles.decisionChip}>Needs a decision</span>}
        {status && <span className={styles.heroStatus}>{status}</span>}
      </div>
      <div className={styles.heroAmountRow}>
        <span className={styles.heroAmount}>{amount}</span>
        {caption && <span className={styles.heroCaption}>{caption}</span>}
      </div>
      {children}
      {breakdown && <div className={styles.heroBreakdown}>{breakdown}</div>}
    </section>
  );
}

export interface AttentionCardProps {
  /** "Needs a decision · Jordan". Amber means a decision and nothing else (§1 rule 4). */
  label: string;
  title: string;
  /** The `small` body copy. */
  children?: ReactNode;
  /** 36 px buttons (`Button size="compact"`). */
  actions?: ReactNode;
  headingLevel?: HeadingLevel;
  className?: string;
}

/** Attention card: attention.surface, 1 px attention.border, radius xl, padding 14. */
export function AttentionCard({
  label,
  title,
  children,
  actions,
  headingLevel = 3,
  className,
}: AttentionCardProps) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cx(styles.attention, className)}>
      <p className={styles.attentionLabel}>
        <Icon icon={TriangleAlert} size={16} />
        {label}
      </p>
      <Heading level={headingLevel} id={id} className={styles.attentionTitle}>
        {title}
      </Heading>
      {children && <div className={styles.attentionBody}>{children}</div>}
      {actions && <div className={styles.attentionActions}>{actions}</div>}
    </section>
  );
}
