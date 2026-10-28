// Input, select and checkbox, DESIGN_SPEC §4. Errors never discard what the user typed (§5.3).
import { useId } from "react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { cx } from "../internal/cx";
import styles from "./field.module.css";

interface FieldChrome {
  /** Label above the control at 12/600, 6 px gap. */
  label: string;
  /** Helper text under the control. */
  hint?: ReactNode;
  /** Error message under the control. The border turns attention.text. */
  error?: ReactNode;
  className?: string;
}

function describedBy(hintId: string, errorId: string, hint: unknown, error: unknown): string | undefined {
  const ids = [error ? errorId : null, hint ? hintId : null].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

function FieldFrame({
  id,
  label,
  hint,
  error,
  hintId,
  errorId,
  className,
  children,
}: FieldChrome & { id: string; hintId: string; errorId: string; children: ReactNode }) {
  return (
    <div className={cx(styles.field, className)}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      {children}
      {error && (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

export interface TextFieldProps
  extends FieldChrome, Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  /** Money fields get `inputmode="decimal"`. */
  money?: boolean;
}

export function TextField({
  label,
  hint,
  error,
  money = false,
  className,
  id,
  type = "text",
  ...input
}: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  return (
    <FieldFrame
      id={inputId}
      label={label}
      hint={hint}
      error={error}
      hintId={hintId}
      errorId={errorId}
      className={className}
    >
      <input
        id={inputId}
        type={type}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hintId, errorId, hint, error)}
        className={cx(styles.control, money && styles.money, error && styles.invalid)}
        {...input}
        inputMode={money ? "decimal" : input.inputMode}
      />
    </FieldFrame>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps
  extends FieldChrome, Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> {
  options: readonly SelectOption[];
}

export function SelectField({ label, hint, error, options, className, id, ...select }: SelectFieldProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const hintId = `${selectId}-hint`;
  const errorId = `${selectId}-error`;
  return (
    <FieldFrame
      id={selectId}
      label={label}
      hint={hint}
      error={error}
      hintId={hintId}
      errorId={errorId}
      className={className}
    >
      <select
        id={selectId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hintId, errorId, hint, error)}
        className={cx(styles.control, styles.select, error && styles.invalid)}
        {...select}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldFrame>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className"> {
  /** The label is the task title. */
  label: ReactNode;
  /** Strike through and mute the label when checked (done tasks). */
  strikeWhenChecked?: boolean;
  className?: string;
}

/** Native checkbox, 20 px, accent brand.default. */
export function Checkbox({ label, strikeWhenChecked = false, className, id, ...input }: CheckboxProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <span className={cx(styles.checkboxRow, className)}>
      <input id={inputId} type="checkbox" className={styles.checkbox} {...input} />
      <label
        htmlFor={inputId}
        className={cx(styles.checkboxLabel, strikeWhenChecked && input.checked && styles.done)}
      >
        {label}
      </label>
    </span>
  );
}
