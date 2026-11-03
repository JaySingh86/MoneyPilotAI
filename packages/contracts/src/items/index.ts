// Items, schedules, renewals, occurrences, planned expenses and balances (WP-06; BACKEND_PLAN §5.2, §7.1,
// §7.5, §8.2). The UI never sees RRULE: it sends and receives the `Schedule` union, which the server
// converts with the engine's schedule utilities.
import { z } from "zod";
import { Cents, IsoDate, Timestamp, Uuid, Version } from "../common";

/** Upper bound on any money field a client sends: $1 billion (G1 L-2). */
export const MAX_MONEY_CENTS = 100_000_000_000;
const Money = Cents.min(0).max(MAX_MONEY_CENTS);

/** A lowercase hostname such as `northgate-insurance.example`. Matched against sender domains; never fetched. */
export const ProviderDomain = z
  .string()
  .max(120)
  .regex(
    /^(?=.{1,120}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/,
    "Use a lowercase hostname such as example.com",
  );

const Weekday = z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

const bounds = { dtstart: IsoDate, until: IsoDate.nullish() };

/** The friendly schedule union (BACKEND_PLAN §7.1). `dtstart` anchors weekly/yearly cadences. */
export const Schedule = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("monthly_day"), day: z.number().int().min(1).max(31), ...bounds }),
    z.object({ type: z.literal("monthly_last_day"), ...bounds }),
    z.object({ type: z.literal("monthly_last_weekday"), weekday: Weekday, ...bounds }),
    z.object({ type: z.literal("every_n_weeks"), n: z.number().int().min(1).max(520), ...bounds }),
    z.object({ type: z.literal("every_n_months"), n: z.number().int().min(2).max(520), ...bounds }),
    z.object({ type: z.literal("yearly"), ...bounds }),
  ])
  .meta({ id: "Schedule" });
export type Schedule = z.infer<typeof Schedule>;

export const ITEM_DIRECTIONS = ["outflow", "inflow"] as const;
export const ITEM_KINDS = [
  "bill",
  "subscription",
  "insurance",
  "membership",
  "registration",
  "loan",
  "income",
  "other",
] as const;
export const ITEM_CATEGORIES = [
  "housing",
  "utilities",
  "childcare",
  "transport",
  "debt",
  "subscription",
  "insurance",
  "membership",
  "vehicle_home",
  "income",
  "other",
] as const;
export const ItemSource = z.enum(["manual", "csv", "email", "bank"]);
export const Owner = z.enum(["member", "both", "split"]);

export const RenewalDetails = z
  .object({
    autoRenews: z.enum(["yes", "no", "rolls_over"]),
    coverageStart: IsoDate.nullable(),
    coverageEnd: IsoDate.nullable(),
    cancelBy: IsoDate.nullable(),
    decisionBy: IsoDate.nullable(),
    shopAroundOn: IsoDate.nullable(),
    previousAmountCents: Money.nullable(),
    priceChangedOn: IsoDate.nullable(),
  })
  .meta({ id: "RenewalDetails" });
export type RenewalDetails = z.infer<typeof RenewalDetails>;

/** Body of `PUT …/items/:id/renewal`. Omitted fields default to null (auto_renews to yes). */
export const PutRenewalDetails = RenewalDetails.partial().meta({ id: "PutRenewalDetails" });

export const Item = z
  .object({
    id: Uuid,
    householdId: Uuid,
    direction: z.enum(ITEM_DIRECTIONS),
    kind: z.enum(ITEM_KINDS),
    category: z.enum(ITEM_CATEGORIES),
    name: z.string().min(1).max(80),
    providerName: z.string().max(120).nullable(),
    providerDomain: z.string().nullable(),
    amountType: z.enum(["fixed", "estimated", "statement"]),
    /** Fixed amount, or the last statement balance; null for estimated items (see item history). */
    amountCents: Money.nullable(),
    schedule: Schedule,
    weekendRule: z.enum(["none", "prev_business_day", "next_business_day"]),
    ownerType: Owner,
    ownerUserId: Uuid.nullable(),
    status: z.enum(["active", "paused", "ended", "pending_review"]),
    source: ItemSource,
    accountLast4: z.string().nullable(),
    paidFrom: z.enum(["account", "payroll"]),
    markedPossiblyUnused: z.boolean(),
    subcategory: z.string().max(40).nullable(),
    movable: z.boolean().nullable(),
    onBillsPage: z.boolean(),
    notes: z.string().max(2000).nullable(),
    renewal: RenewalDetails.nullable(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Item" });
export type Item = z.infer<typeof Item>;

// Fields without defaults: a PATCH must never reset an omitted field. Create adds the defaults below.
const itemFields = z.object({
  direction: z.enum(ITEM_DIRECTIONS),
  kind: z.enum(ITEM_KINDS),
  category: z.enum(ITEM_CATEGORIES),
  name: z.string().min(1).max(80),
  providerName: z.string().max(120).nullish(),
  providerDomain: ProviderDomain.nullish(),
  amountType: z.enum(["fixed", "estimated", "statement"]),
  amountCents: Money.nullish(),
  schedule: Schedule,
  weekendRule: z.enum(["none", "prev_business_day", "next_business_day"]),
  ownerType: Owner,
  ownerUserId: Uuid.nullish(),
  status: z.enum(["active", "paused", "ended", "pending_review"]),
  accountLast4: z
    .string()
    .regex(/^[0-9A-Za-z]{2,4}$/, "Last 4 characters only")
    .nullish(),
  paidFrom: z.enum(["account", "payroll"]),
  markedPossiblyUnused: z.boolean(),
  subcategory: z.string().max(40).nullish(),
  movable: z.boolean().nullish(),
  onBillsPage: z.boolean(),
  notes: z.string().max(2000).nullish(),
});

const itemDefaults = {
  weekendRule: itemFields.shape.weekendRule.default("none"),
  status: itemFields.shape.status.default("active"),
  paidFrom: itemFields.shape.paidFrom.default("account"),
  markedPossiblyUnused: z.boolean().default(false),
  onBillsPage: z.boolean().default(true),
};

export const CreateItem = itemFields
  .extend(itemDefaults)
  .strict() // a client cannot name a source: items it creates are always `manual` (G1 M-2)
  .refine((v) => (v.ownerType === "member") === (v.ownerUserId != null), {
    message: "A member owner needs ownerUserId; both and split must not have one",
    path: ["ownerUserId"],
  })
  .refine((v) => v.amountCents != null, {
    message: "Every amount type needs amountCents (the estimate or the last statement for variable bills)",
    path: ["amountCents"],
  })
  .meta({ id: "CreateItem" });
export type CreateItem = z.infer<typeof CreateItem>;

/** `PATCH …/items/:id` with `If-Match`. Send only what changed; `schedule` replaces the whole schedule. */
export const PatchItem = itemFields
  .omit({ direction: true })
  .strict()
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Send at least one field")
  .meta({ id: "PatchItem" });
export type PatchItem = z.infer<typeof PatchItem>;

export const ItemListQuery = z.object({
  direction: z.enum(ITEM_DIRECTIONS).optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  category: z.enum(ITEM_CATEGORIES).optional(),
  /** A member's user id (their items plus Both and Split), or `both` / `split`. */
  owner: z.union([Uuid, z.enum(["both", "split"])]).optional(),
  amountType: z.enum(["fixed", "estimated", "statement"]).optional(),
  /** Bills & recurring lists `onBillsPage=true`; Subscriptions & renewals list all items with renewals. */
  onBillsPage: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  /** `averages` adds the monthly averages of Bills & recurring (rule 17, WP-12) to the page. */
  include: z.enum(["averages"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: Uuid.optional(),
});

export const ItemParams = z.object({ hid: Uuid, id: Uuid });

export const AmountHistoryEntry = z
  .object({
    id: Uuid,
    occurredOn: IsoDate,
    amountCents: Cents.min(0),
    source: ItemSource,
  })
  .meta({ id: "AmountHistoryEntry" });
export const AmountHistory = z.object({ data: z.array(AmountHistoryEntry) }).meta({ id: "AmountHistory" });

// ===== Occurrences =====
export const OCCURRENCE_STATUSES = ["scheduled", "paid", "received", "skipped"] as const;

export const Occurrence = z
  .object({
    id: Uuid,
    householdId: Uuid,
    itemId: Uuid,
    scheduledOn: IsoDate,
    dueOn: IsoDate,
    actualAmountCents: Cents.min(0).nullable(),
    status: z.enum(OCCURRENCE_STATUSES),
    paidOn: IsoDate.nullable(),
    markedBy: Uuid.nullable(),
    movedBy: Uuid.nullable(),
    version: Version,
  })
  .meta({ id: "Occurrence" });
export type Occurrence = z.infer<typeof Occurrence>;

export const MAX_OCCURRENCE_RANGE_DAYS = 420;

export const OccurrenceListQuery = z.object({
  from: IsoDate,
  to: IsoDate,
  itemId: Uuid.optional(),
});

export const OccurrenceList = z.object({ data: z.array(Occurrence) }).meta({ id: "OccurrenceList" });

/**
 * `PATCH …/occurrences/:id` with `If-Match`: mark paid (outflows) or received (inflows), skip, undo
 * (`scheduled`), set the actual amount, or move the due date (`dueOn`; `scheduledOn` never changes).
 */
export const PatchOccurrence = z
  .object({
    status: z.enum(OCCURRENCE_STATUSES),
    /** Defaults to today in the household's timezone when marking paid or received. */
    paidOn: IsoDate,
    actualAmountCents: Money.nullable(),
    dueOn: IsoDate,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Send at least one field")
  .meta({ id: "PatchOccurrence" });
export type PatchOccurrence = z.infer<typeof PatchOccurrence>;

export const OccurrenceParams = z.object({ hid: Uuid, id: Uuid });

// ===== Planned expenses =====
export const PlannedExpense = z
  .object({
    id: Uuid,
    householdId: Uuid,
    name: z.string().min(1).max(80),
    amountCents: Cents.min(1),
    dueOn: IsoDate,
    ownerType: Owner,
    ownerUserId: Uuid.nullable(),
    goalId: Uuid.nullable(),
    status: z.enum(["planned", "done", "cancelled"]),
    version: Version,
    createdAt: Timestamp,
  })
  .meta({ id: "PlannedExpense" });
export type PlannedExpense = z.infer<typeof PlannedExpense>;

const plannedFields = z.object({
  name: z.string().min(1).max(80),
  amountCents: Cents.min(1).max(MAX_MONEY_CENTS),
  dueOn: IsoDate,
  ownerType: Owner,
  ownerUserId: Uuid.nullish(),
  goalId: Uuid.nullish(),
  status: z.enum(["planned", "done", "cancelled"]),
});
export const CreatePlannedExpense = plannedFields
  .extend({ status: plannedFields.shape.status.default("planned") })
  .refine((v) => (v.ownerType === "member") === (v.ownerUserId != null), {
    message: "A member owner needs ownerUserId; both and split must not have one",
    path: ["ownerUserId"],
  })
  .meta({ id: "CreatePlannedExpense" });
export const PatchPlannedExpense = plannedFields
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Send at least one field")
  .meta({ id: "PatchPlannedExpense" });
export const PlannedExpenseList = z
  .object({ data: z.array(PlannedExpense) })
  .meta({ id: "PlannedExpenseList" });
export const PlannedExpenseListQuery = z.object({
  status: z.enum(["planned", "done", "cancelled"]).optional(),
});

// ===== Balances =====
export const Balance = z
  .object({
    id: Uuid,
    label: z.string(),
    amountCents: Cents,
    asOf: IsoDate,
    source: z.enum(["manual", "csv", "bank"]),
    createdAt: Timestamp,
  })
  .meta({ id: "Balance" });
export type Balance = z.infer<typeof Balance>;

/** `POST …/balances`: the user enters today's balance by hand (a new row; history is kept). */
export const CreateBalance = z
  .object({
    label: z.string().min(1).max(40).default("Checking"),
    amountCents: Cents.min(-MAX_MONEY_CENTS).max(MAX_MONEY_CENTS),
    asOf: IsoDate,
  })
  .meta({ id: "CreateBalance" });
