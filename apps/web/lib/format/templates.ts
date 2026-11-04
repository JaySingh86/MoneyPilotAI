// Fills the engine's decision templates ("{name}, {amountCents} on {dueOn}"). Every number and date in
// the sentence is a parameter computed by the engine (hard rule 4); this only formats them through
// @mp/format. The key's name says how: `…Cents` is money, `…On` / `…Date` is a date.
import { money } from "@mp/format";
import { shortDate } from "./dates";

export type TemplateParams = Record<string, string | number | null>;

/** Money you can spend rounds down (§7); everything else in a summary sentence rounds to the nearest dollar. */
function formatCents(key: string, cents: number): string {
  const rounding = /^(alt)?safeToSpend/i.test(key) ? "floor" : "nearest";
  return money(cents, { mode: "headline", rounding });
}

function formatParam(key: string, value: string | number | null, today: string): string {
  if (value === null) return "";
  if (typeof value === "number") return key.endsWith("Cents") ? formatCents(key, value) : String(value);
  if (/(On|Date)$/.test(key) && /^\d{4}-\d{2}-\d{2}$/.test(value)) return shortDate(value, today);
  return value;
}

export function fillTemplate(template: string, params: TemplateParams, today: string): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? formatParam(key, params[key] ?? null, today) : whole,
  );
}
