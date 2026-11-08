// WP-23 mock data: the Email & imports board (4 items to review, 3 applied changes), the connected
// sources, CSV import detections, and the Members & privacy board, all shaped as the contracts (WP-14
// review/applied/sender-rules, WP-05 households) or as the assumed endpoints in lib/api/imports-types.ts.
// Dev and tests only. In-memory: reset with {@link resetWp23}.
import { riveraFixture, riveraInput } from "@mp/engine/testing";
import type {
  ActivityEntry,
  AppliedChange,
  AutomationStats,
  Import,
  EmailConnection,
  ExtractedFields,
  ForwardingInfo,
  ReviewItem,
  SenderRule,
  SharingPreferences,
} from "../lib/api/imports-types";
import { HOUSEHOLD_ID, JORDAN_ID, SAM_ID } from "./identity";
import type { HouseholdSummary } from "./identity";

const engineInput = riveraInput();
/** The engine's golden numbers (fixture `expected`): what the real plan returns on a decision. */
export const SAFE_TO_SPEND_NOW = riveraFixture.expected.safeToSpendCents;
export const SAFE_AFTER_ELECTRICITY = riveraFixture.expected.safeToSpendAfterElectricityActual15137Cents;

const uuid = (kind: string, n: number): string => `6d8e${kind}-0000-4000-8000-${String(n).padStart(12, "0")}`;

const NO_FIELDS: ExtractedFields = {
  docType: "irrelevant",
  providerName: null,
  category: null,
  insuranceType: null,
  amountDueCents: null,
  previousAmountCents: null,
  dueDate: null,
  renewalDate: null,
  cancelByDate: null,
  decisionByDate: null,
  frequency: null,
  autoRenews: null,
  accountLast4: null,
  providerDomain: null,
};

function reviewItem(
  n: number,
  base: Pick<ReviewItem, "matchType" | "message" | "effect"> & {
    fields: Partial<ExtractedFields>;
    /** The id of the item an `update` matches: the fixture's own ids, as `GET /items` serves them. */
    matchItemId?: string;
  },
): ReviewItem {
  return {
    id: uuid("0001", n),
    source: "email",
    state: "queued",
    matchType: base.matchType,
    matchItemId: base.matchItemId ?? null,
    message: base.message,
    fields: { ...NO_FIELDS, ...base.fields },
    evidence: [],
    evidenceStale: false,
    effect: base.effect,
    decidedBy: null,
    decidedAt: null,
    appliedChangeId: null,
    createdAt: base.message?.receivedAt ?? "2026-10-24T14:02:00Z",
  };
}

/** The four items the canvas shows, in its order. */
function seedQueue(): ReviewItem[] {
  return [
    reviewItem(1, {
      matchType: "update",
      matchItemId: "r-renters",
      message: {
        fromDomain: "northgate-insurance.example",
        subject: "Your renewal offer for policy •••4821",
        receivedAt: "2026-10-24T14:02:00Z",
      },
      fields: {
        docType: "renewal_notice",
        providerName: "Northgate Home Insurance",
        category: "insurance",
        insuranceType: "renters",
        amountDueCents: 16800,
        previousAmountCents: 14900,
        renewalDate: "2027-01-09",
        frequency: "yearly",
        accountLast4: "4821",
      },
      effect: {
        summary: "Updates Renters insurance and flags a price increase. Sam gets a shop-around reminder.",
        planDelta: null,
      },
    }),
    reviewItem(2, {
      matchType: "update",
      matchItemId: "b-power",
      message: {
        fromDomain: "citypowerlight.example",
        subject: "Your October statement is ready",
        receivedAt: "2026-10-26T13:10:00Z",
      },
      fields: {
        docType: "statement",
        providerName: "City Power & Light",
        category: "utilities",
        amountDueCents: 15137,
        dueDate: "2026-11-03",
        frequency: "monthly",
        accountLast4: "0937",
      },
      effect: {
        summary: "Replaces the estimate with the actual amount.",
        planDelta: null,
      },
    }),
    reviewItem(3, {
      matchType: "decision",
      message: {
        fromDomain: "benefits-portal.example",
        subject: "Make your 2027 benefit elections by Nov 13",
        receivedAt: "2026-10-22T15:30:00Z",
      },
      fields: {
        docType: "enrollment_deadline",
        providerName: "Health plan benefits",
        category: "insurance",
        insuranceType: "health",
        amountDueCents: 24800,
        decisionByDate: "2026-11-13",
        frequency: "monthly",
      },
      effect: {
        summary: "Adds a decision task. If no plan is picked, the current one rolls over.",
        planDelta: null,
      },
    }),
    reviewItem(4, {
      matchType: "new",
      message: {
        fromDomain: "antivirus-billing.example",
        subject: "Your subscription renews on Dec 1",
        receivedAt: "2026-10-25T16:45:00Z",
      },
      fields: {
        docType: "renewal_notice",
        providerName: "Antivirus",
        category: "subscription",
        amountDueCents: 4999,
        renewalDate: "2026-12-01",
        frequency: "yearly",
        autoRenews: true,
      },
      effect: {
        summary: "Adds a yearly renewal with a reminder, so there is time to cancel.",
        planDelta: null,
      },
    }),
  ];
}

function appliedChange(
  n: number,
  name: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  appliedAt: string,
  undoUntil: string,
): AppliedChange {
  return {
    id: uuid("0003", n),
    origin: "email",
    entityType: "recurring_item",
    entityId: uuid("0002", 20 + n),
    entityName: name,
    before,
    after,
    appliedBy: null,
    appliedAt,
    undoUntil,
    undoneAt: null,
    undoneBy: null,
    undoable: true,
  };
}

function seedApplied(): AppliedChange[] {
  return [
    appliedChange(
      1,
      "Internet",
      { amountCents: 7000, dueDate: "2026-11-05" },
      { amountCents: 7000, dueDate: "2026-11-05" },
      "2026-10-21T13:00:00Z",
      "2026-11-20T13:00:00Z",
    ),
    appliedChange(
      2,
      "Car insurance renewal",
      { amountCents: 68400 },
      { amountCents: 68400, dueDate: "2026-11-04" },
      "2026-10-20T13:00:00Z",
      "2026-11-19T13:00:00Z",
    ),
    appliedChange(
      3,
      "Streaming bundle",
      { amountCents: 1999 },
      { amountCents: 2299 },
      "2026-09-28T13:00:00Z",
      "2026-10-28T13:00:00Z",
    ),
  ];
}

const WATCHED = [
  "citypowerlight.example",
  "northgate-insurance.example",
  "benefits-portal.example",
  "antivirus-billing.example",
  "streamingbundle.example",
  "lakeviewwater.example",
  "metrointernet.example",
  "tahoe-resorts.example",
  "autoloan-servicing.example",
  "daycare-billing.example",
  "phoneplan.example",
  "cloudstorage.example",
  "musicfamily.example",
  "fitnessapp.example",
  "newsdaily.example",
  "kidslearning.example",
  "warehouseclub.example",
  "shoppingmember.example",
  "dmv-registration.example",
  "lifeinsurance.example",
  "motocover.example",
  "creditcard-statements.example",
  "rentportal.example",
];

function seedRules(): SenderRule[] {
  return WATCHED.map((domain, i) => ({
    id: uuid("0004", i + 1),
    domain,
    rule: "watch" as const,
    categoryHint: null,
    createdBy: null,
  }));
}

function seedConnections(): EmailConnection[] {
  return [
    {
      id: uuid("0005", 1),
      provider: "gmail",
      ownerUserId: SAM_ID,
      maskedAddress: "sam•••@gmail.com",
      status: "connected",
      lastCheckedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      backfillMonths: 13,
      matchedCount: 214,
      usedCount: 23,
    },
  ];
}

type Frequency = NonNullable<ExtractedFields["frequency"]>;

/** What a bank CSV turns into: review items with `source = csv` (Q-174), as the WP-16 worker writes them. */
const DETECTIONS: [name: string, income: boolean, cents: number, frequency: Frequency, due: string][] = [
  ["Rent", false, 215000, "monthly", "2026-11-01"],
  ["Payroll deposit", true, 315000, "monthly", "2026-11-06"],
  ["Daycare", false, 124000, "monthly", "2026-11-02"],
  ["Car insurance", false, 68400, "every_6_months", "2026-11-04"],
  ["Car payment", false, 38900, "monthly", "2026-11-29"],
  ["Phone plan", false, 9500, "monthly", "2026-11-02"],
  ["Water & trash", false, 9600, "monthly", "2026-11-12"],
  ["Internet", false, 7000, "monthly", "2026-11-05"],
  ["Streaming bundle", false, 2299, "monthly", "2026-11-08"],
  ["Music family plan", false, 1699, "monthly", "2026-11-14"],
  ["Fitness app", false, 1499, "monthly", "2026-11-18"],
  ["News", false, 800, "monthly", "2026-11-20"],
  ["Cloud storage", false, 299, "monthly", "2026-11-22"],
];

/** The review items a processed CSV adds to the queue. */
export function csvReviewItems(): ReviewItem[] {
  return DETECTIONS.map(([name, income, cents, frequency, due], i) => ({
    ...reviewItem(100 + i, {
      matchType: "new",
      message: null,
      fields: {
        docType: "bill",
        providerName: name,
        category: income ? "income" : "other",
        amountDueCents: cents,
        dueDate: due,
        frequency,
      },
      effect: { summary: "Adds a repeating item to your plan.", planDelta: null },
    }),
    source: "csv" as const,
    createdAt: "2026-10-27T13:00:00Z",
  }));
}

export interface Wp23State {
  queue: ReviewItem[];
  decided: ReviewItem[];
  applied: AppliedChange[];
  rules: SenderRule[];
  connections: EmailConnection[];
  imports: Map<string, Import>;
  sharing: SharingPreferences;
  remindersSent: Set<string>;
  household: { name: string; cushionCents: number; primaryIncomeItemId: string | null };
  deletionScheduledFor: string | null;
  /** `?setup=invited` shows the household with a pending invite and no partner yet. */
  invite: {
    id: string;
    email: string;
    firstName: string | null;
    expiresAt: string;
    createdAt: string;
  } | null;
  /** Members' 2-step verification, as the summary reports it. `?mfa=off` starts Sam without it. */
  mfa: { sam: boolean; jordan: boolean };
  invitesToday: number;
  /** False in the `?setup=invited` scenario: the partner has not accepted yet. */
  partnerJoined: boolean;
  forwardingToken: string;
  exportRequested: boolean;
  /** Set when an invite was accepted. */
  joinedByInvite: boolean;
  /** Set on a leave: the household is gone for this user. */
  left: boolean;
  /** `?mfa=required`: leave, export and delete answer 403 `mfa_required` (step-up, BACKEND_PLAN §8.2). */
  requireStepUp: boolean;
}

export const INVITE_LIMIT_PER_DAY = 5;

function initial(): Wp23State {
  return {
    queue: seedQueue(),
    decided: [],
    applied: seedApplied(),
    rules: seedRules(),
    connections: seedConnections(),
    imports: new Map(),
    sharing: { billsFromEmail: true, tasks: true, connectedAddress: false },
    remindersSent: new Set(),
    household: {
      name: "Rivera household",
      cushionCents: riveraFixture.household.cushionCents,
      // The fixture's primary income, as the shared items mock (WP-18) serves it.
      primaryIncomeItemId: engineInput.primaryIncomeItemId,
    },
    deletionScheduledFor: null,
    invite: null,
    mfa: { sam: true, jordan: false },
    invitesToday: 0,
    partnerJoined: true,
    forwardingToken: "rivera-7k2",
    exportRequested: false,
    left: false,
    joinedByInvite: false,
    requireStepUp: false,
  };
}

export const wp23: Wp23State = initial();

/** Restores the seed. Tests call it before each case; the browser calls it once at start. */
export function resetWp23(search: string = ""): void {
  Object.assign(wp23, initial());
  const params = new URLSearchParams(search);
  wp23.requireStepUp = params.get("mfa") === "required";
  if (params.get("mfa") === "off") wp23.mfa.sam = false;
  if (params.get("setup") === "invited") {
    wp23.invite = {
      id: uuid("0009", 1),
      email: "jordan@rivera-household.example",
      firstName: "Jordan",
      expiresAt: "2026-11-03T14:00:00Z",
      createdAt: "2026-10-27T14:00:00Z",
    };
    wp23.invitesToday = 1;
    wp23.partnerJoined = false;
  }
}

export function emptyInbox(): void {
  wp23.queue = [];
  wp23.applied = [];
}

export function reviewQueueCount(scenario: string): number {
  return scenario === "empty" ? 0 : wp23.queue.length;
}

export function automationStats(): AutomationStats {
  return { percent: 92, automatedCount: 23, handCount: 2 };
}

export function forwarding(): ForwardingInfo {
  return { address: `${wp23.forwardingToken}@in.moneypilot.app`, receivedCount: 1 };
}

export const ACTIVITY: ActivityEntry[] = [
  {
    id: uuid("000a", 1),
    action: "Email scan: 214 matched, 23 used",
    actorName: "MoneyPilot",
    at: "2026-10-27T12:58:00Z",
  },
  {
    id: uuid("000a", 2),
    action: "Jordan joined the household",
    actorName: "Jordan",
    at: "2026-10-27T01:40:00Z",
  },
  { id: uuid("000a", 3), action: "Imported checking-oct.csv", actorName: "Sam", at: "2026-10-27T01:15:00Z" },
  {
    id: uuid("000a", 4),
    action: "Connected Gmail (read-only)",
    actorName: "Sam",
    at: "2026-10-27T01:12:00Z",
  },
  { id: uuid("000a", 5), action: "Created the household", actorName: "Sam", at: "2026-10-27T01:05:00Z" },
];

/** Applies this mock's edits on top of WP-17's base summary (name, cushion, invite, members, deletion). */
export function withWp23Overrides(base: HouseholdSummary): HouseholdSummary {
  const members = wp23.partnerJoined
    ? base.members.map((m) =>
        m.userId === JORDAN_ID
          ? { ...m, joinedAt: "2026-10-27T01:40:00Z", mfaEnabled: wp23.mfa.jordan }
          : { ...m, mfaEnabled: wp23.mfa.sam },
      )
    : base.members.filter((m) => m.userId !== JORDAN_ID).map((m) => ({ ...m, mfaEnabled: wp23.mfa.sam }));
  return {
    ...base,
    household: {
      ...base.household,
      id: HOUSEHOLD_ID,
      name: wp23.household.name,
      cushionCents: wp23.household.cushionCents,
      primaryIncomeItemId: wp23.household.primaryIncomeItemId,
      deletionScheduledFor: wp23.deletionScheduledFor,
    },
    members,
    openInvite: wp23.invite,
    connections: { emailConnections: wp23.connections.length },
  };
}

export function noFields(): ExtractedFields {
  return { ...NO_FIELDS };
}
