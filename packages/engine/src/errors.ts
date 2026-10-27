export type EngineErrorCode =
  | "invalid_date"
  | "invalid_cents"
  | "invalid_schedule"
  | "invalid_rrule"
  | "invalid_input"
  | "invalid_timezone"
  | "holiday_table_out_of_range"
  | "no_primary_income_occurrence";

/** Thrown for input the engine cannot plan with. Never contains amounts or names (hard rule 8). */
export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "EngineError";
    this.code = code;
  }
}
