// "Due before payday" rows for stories and tests, mirroring the canvas Overview table for the
// fixture's planning window (Oct 27 → Nov 6). Golden: 8 bills, $4,792.99
// (expected.billsBeforePayday). The total in stories comes from the fixture, not from a sum.
import { Temporal } from "@js-temporal/polyfill";
import type { PartnerRole } from "../internal/types";
import type { StatusChipVariant } from "../status-chip/StatusChip";

export interface BillRow {
  id: string;
  due: Temporal.PlainDate;
  name: string;
  frequency: string;
  owner: { name: string; role: PartnerRole };
  status: { variant: StatusChipVariant; label: string };
  amountCents: number;
  estimate?: boolean;
}

const sam = { name: "Sam", role: "partnerA" } as const;
const jordan = { name: "Jordan", role: "partnerB" } as const;
const d = (iso: string) => Temporal.PlainDate.from(iso);
const reminder = { variant: "ok", label: "Reminder set" } as const;

// prettier-ignore
export const BILLS_BEFORE_PAYDAY: readonly BillRow[] = [
  { id: "b-car", due: d("2026-10-29"), name: "Car payment", frequency: "Monthly", owner: sam, status: reminder, amountCents: 38900 },
  { id: "b-phone", due: d("2026-10-31"), name: "Phone plan", frequency: "Monthly", owner: jordan, status: reminder, amountCents: 9500 },
  { id: "b-rent", due: d("2026-11-01"), name: "Rent", frequency: "Monthly", owner: jordan, status: reminder, amountCents: 215000 },
  { id: "b-daycare", due: d("2026-11-02"), name: "Daycare", frequency: "Monthly", owner: sam, status: reminder, amountCents: 124000 },
  { id: "b-stream", due: d("2026-11-02"), name: "Streaming bundle", frequency: "Monthly · subscription", owner: sam, status: { variant: "attention", label: "Price up $3" }, amountCents: 2299 },
  { id: "b-power", due: d("2026-11-03"), name: "Electricity", frequency: "Monthly · varies", owner: sam, status: { variant: "estimate", label: "Estimate ±$30" }, amountCents: 14200, estimate: true },
  { id: "b-carins", due: d("2026-11-04"), name: "Car insurance renewal", frequency: "Every 6 months", owner: jordan, status: { variant: "attention", label: "Not usual month" }, amountCents: 68400 },
  { id: "b-internet", due: d("2026-11-05"), name: "Internet", frequency: "Monthly", owner: jordan, status: reminder, amountCents: 7000 },
];
