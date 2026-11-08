// Who the mock API says you are: Sam, creator of the fixture's Rivera household, with Jordan as the
// invited partner. Ids are fixed UUIDs so the contracts' shapes hold (Me, HouseholdSummary).
import type { components } from "@mp/contracts/client";

export type Me = components["schemas"]["Me"];
export type HouseholdSummary = components["schemas"]["HouseholdSummary"];

export const HOUSEHOLD_ID = "5f0c2b9e-3c1d-4a77-9a3e-0000000000a1";
export const SAM_ID = "5f0c2b9e-3c1d-4a77-9a3e-0000000000b1";
export const JORDAN_ID = "5f0c2b9e-3c1d-4a77-9a3e-0000000000b2";

/** The fixture's own member ids, mapped to the mock API's UUIDs. */
export const OWNER_IDS: Readonly<Record<string, string>> = {
  "m-sam": SAM_ID,
  "m-jordan": JORDAN_ID,
  both: "both",
  split: "split",
};

export const MOCK_USER = {
  email: "sam@rivera-household.example",
  firstName: "Sam",
} as const;

const CREATED_AT = "2026-10-20T14:00:00Z";

export const ME: Me = {
  id: SAM_ID,
  email: MOCK_USER.email,
  firstName: "Sam",
  lastName: null,
  timezone: "America/New_York",
  mfaEnabled: false,
  createdAt: CREATED_AT,
  memberships: [
    {
      householdId: HOUSEHOLD_ID,
      householdName: "Rivera household",
      colorRole: "partnerA",
      isCreator: true,
      joinedAt: CREATED_AT,
    },
  ],
};

/** `tasksDue` and `reviewQueue` are the fixture's expected badges (3 tasks due this week, 4 to review). */
export function summary(tasksDue: number, reviewQueue: number, cushionCents: number): HouseholdSummary {
  return {
    household: {
      id: HOUSEHOLD_ID,
      name: "Rivera household",
      timezone: "America/New_York",
      currency: "USD",
      cushionCents,
      primaryIncomeItemId: "inc-sam",
      plan: "family_plus",
      forwardingToken: "rivera-7k2",
      deletionScheduledFor: null,
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    members: [
      {
        userId: SAM_ID,
        firstName: "Sam",
        lastName: null,
        colorRole: "partnerA",
        isCreator: true,
        joinedAt: CREATED_AT,
        mfaEnabled: true,
      },
      {
        userId: JORDAN_ID,
        firstName: "Jordan",
        lastName: null,
        colorRole: "partnerB",
        isCreator: false,
        joinedAt: CREATED_AT,
        mfaEnabled: false,
      },
    ],
    openInvite: null,
    badges: { reviewQueue, tasksDue, proposalsPending: 0 },
    // The Rivera household is on Family Plus: every feature is writable (WP-25 entitlements).
    entitlements: {
      plan: "family_plus",
      maxAdults: 2,
      features: {
        partnerSharing: { read: true, write: true },
        goals: { read: true, write: true },
        reminders: { read: true, write: true },
        emailConnections: { read: true, write: true },
        renewalAlerts: { read: true, write: true },
        unlimitedItems: { read: true, write: true },
      },
      limits: { items: null },
    },
    connections: { emailConnections: 1 },
  };
}
