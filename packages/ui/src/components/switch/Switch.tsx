// Switch, DESIGN_SPEC §4: a real button with role="switch" and aria-checked.
import { useId } from "react";
import type { ReactNode } from "react";
import { cx } from "../internal/cx";
import styles from "./switch.module.css";

interface SwitchBaseProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export type SwitchProps = SwitchBaseProps &
  ({ label: string; labelledBy?: never } | { labelledBy: string; label?: never; describedBy?: string });

/** The bare switch: track 52×32, knob 26 with a 3 px inset. */
export function Switch(props: SwitchProps) {
  const { checked, onChange, disabled, className } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={props.label}
      aria-labelledby={props.labelledBy}
      aria-describedby={"describedBy" in props ? props.describedBy : undefined}
      disabled={disabled}
      className={cx(styles.switch, checked && styles.on, className)}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.knob} aria-hidden="true" />
    </button>
  );
}

export interface SwitchRowProps extends SwitchBaseProps {
  /** Title (500). Names the switch. */
  title: string;
  /** 12 px muted sub-line. */
  description?: ReactNode;
}

/** A settings row at least 56 tall: title and sub-line, switch on the right. */
export function SwitchRow({ title, description, ...rest }: SwitchRowProps) {
  const titleId = useId();
  const descId = useId();
  return (
    <div className={styles.row}>
      <div className={styles.text}>
        <span id={titleId} className={styles.title}>
          {title}
        </span>
        {description && (
          <span id={descId} className={styles.description}>
            {description}
          </span>
        )}
      </div>
      <Switch {...rest} labelledBy={titleId} describedBy={description ? descId : undefined} />
    </div>
  );
}
