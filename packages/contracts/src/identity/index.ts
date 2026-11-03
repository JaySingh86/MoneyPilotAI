// Identity contracts (BACKEND_PLAN §6, §8.2): bootstrap, the signed-in user, their profile.
// The email, `email_verified` and MFA flag come from the verified access token, never from a body
// (ADR-017), so no request schema here has an email field and the bodies are `.strict()`.
import { z } from "zod";
import { Timestamp, Uuid } from "../common";

/** IANA time zone name, e.g. `America/New_York`. */
export const TimeZone = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Expected an IANA time zone such as America/New_York")
  .meta({ description: "IANA time zone name" });

const PersonName = z.string().trim().min(1).max(80);

/** The household member's colour role (design: partner A / partner B). */
export const ColorRole = z.enum(["partnerA", "partnerB"]);
export type ColorRole = z.infer<typeof ColorRole>;

export const Membership = z
  .object({
    householdId: Uuid,
    householdName: z.string(),
    colorRole: ColorRole,
    isCreator: z.boolean(),
    joinedAt: Timestamp,
  })
  .meta({ id: "Membership" });
export type Membership = z.infer<typeof Membership>;

export const Me = z
  .object({
    id: Uuid,
    email: z.string().describe("Verified email from the sign-in provider"),
    firstName: z.string(),
    lastName: z.string().nullable(),
    timezone: z.string(),
    mfaEnabled: z.boolean(),
    createdAt: Timestamp,
    memberships: z.array(Membership).describe("Active household memberships"),
  })
  .meta({ id: "Me" });
export type Me = z.infer<typeof Me>;

/**
 * `POST /v1/me/bootstrap`. `firstName` is required the first time (the sign-in token carries no name we
 * trust); later calls may send `{}` and only sync email and MFA from the token.
 */
export const BootstrapBody = z
  .object({
    firstName: PersonName.optional(),
    lastName: PersonName.nullable().optional(),
    timezone: TimeZone.optional(),
  })
  .strict()
  .meta({ id: "BootstrapBody" });
export type BootstrapBody = z.infer<typeof BootstrapBody>;

export const PatchMeBody = z
  .object({
    firstName: PersonName.optional(),
    lastName: PersonName.nullable().optional(),
    timezone: TimeZone.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "Send at least one field")
  .meta({ id: "PatchMeBody" });
export type PatchMeBody = z.infer<typeof PatchMeBody>;
