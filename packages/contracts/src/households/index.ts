// Household contracts (BACKEND_PLAN §6, §8.2): households, the summary, partner invites, leave.
import { z } from "zod";
import { Entitlements } from "../billing";
import { Cents, HouseholdParams, Timestamp, Uuid, Version } from "../common";
import { ColorRole, TimeZone } from "../identity";

export const HouseholdName = z.string().trim().min(1).max(80);

export const Household = z
  .object({
    id: Uuid,
    name: z.string(),
    timezone: z.string(),
    currency: z.string().length(3),
    cushionCents: Cents,
    primaryIncomeItemId: Uuid.nullable(),
    plan: z.enum(["free", "family_plus"]),
    forwardingToken: z.string().describe("Local part of the household's forwarding address"),
    deletionScheduledFor: Timestamp.nullable(),
    version: Version,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Household" });
export type Household = z.infer<typeof Household>;

export const CreateHouseholdBody = z
  .object({
    name: HouseholdName,
    timezone: TimeZone.optional().describe("Defaults to the signed-in user's time zone"),
    cushionCents: Cents.min(0).optional(),
  })
  .strict()
  .meta({ id: "CreateHouseholdBody" });
export type CreateHouseholdBody = z.infer<typeof CreateHouseholdBody>;

/** `primaryIncomeItemId` must be a live income item of this household (checked by the API, Q-086). */
export const PatchHouseholdBody = z
  .object({
    name: HouseholdName.optional(),
    timezone: TimeZone.optional(),
    cushionCents: Cents.min(0).optional(),
    primaryIncomeItemId: Uuid.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "Send at least one field")
  .meta({ id: "PatchHouseholdBody" });
export type PatchHouseholdBody = z.infer<typeof PatchHouseholdBody>;

export const HouseholdMember = z
  .object({
    userId: Uuid,
    firstName: z.string(),
    lastName: z.string().nullable(),
    colorRole: ColorRole,
    isCreator: z.boolean(),
    joinedAt: Timestamp,
    mfaEnabled: z
      .boolean()
      .describe("Whether the member has 2-step verification on (Members & privacy, Q-177)"),
  })
  .meta({ id: "HouseholdMember" });
export type HouseholdMember = z.infer<typeof HouseholdMember>;

export const InviteeFirstName = z.string().trim().min(1).max(50);

export const Invite = z
  .object({
    id: Uuid,
    email: z.string(),
    firstName: z.string().nullable().describe("The invitee's first name, if the inviter gave one"),
    expiresAt: Timestamp,
    createdAt: Timestamp,
  })
  .meta({ id: "Invite" });
export type Invite = z.infer<typeof Invite>;

export const CreateInviteBody = z
  .object({ email: z.email().max(254), firstName: InviteeFirstName.optional() })
  .strict()
  .meta({ id: "CreateInviteBody" });
export type CreateInviteBody = z.infer<typeof CreateInviteBody>;

export const InviteParams = HouseholdParams.extend({ id: Uuid });

/** 32 random bytes, base64url without padding (43 characters). Only its sha256 is stored. */
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const AcceptInviteBody = z
  .object({ token: z.string().regex(INVITE_TOKEN_PATTERN, "Not a valid invite token") })
  .strict()
  .meta({ id: "AcceptInviteBody" });
export type AcceptInviteBody = z.infer<typeof AcceptInviteBody>;

export const AcceptInviteResponse = z.object({ householdId: Uuid }).meta({ id: "AcceptInviteResponse" });
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponse>;

/** Nav badges are stubbed at zero until the modules that own them land (review queue, tasks, proposals). */
export const HouseholdSummary = z
  .object({
    household: Household,
    members: z.array(HouseholdMember),
    openInvite: Invite.nullable(),
    badges: z.object({
      reviewQueue: z.number().int().min(0),
      tasksDue: z.number().int().min(0),
      proposalsPending: z.number().int().min(0),
    }),
    entitlements: Entitlements,
    connections: z.object({ emailConnections: z.number().int().min(0) }),
  })
  .meta({ id: "HouseholdSummary" });
export type HouseholdSummary = z.infer<typeof HouseholdSummary>;

/** Both adults on every plan in the MVP (BACKEND_PLAN §6); kept as a constant until billing lands. */
export const MAX_ADULTS = 2;
