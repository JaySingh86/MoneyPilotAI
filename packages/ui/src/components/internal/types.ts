import type { PlainDateLike } from "@mp/format";

// Shared prop types for the UI kit.

/**
 * Owner colors come from the member's role, never their name (DESIGN_SPEC §1 rule 5).
 * `partnerA` = household creator (teal), `partnerB` = invited partner (plum), `both` = brand navy.
 */
export type OwnerRole = "partnerA" | "partnerB" | "both";

/** A person-backed role. `both` has no avatar of its own; stack two avatars instead. */
export type PartnerRole = Exclude<OwnerRole, "both">;

/** Web or mobile sizing of a component (DESIGN_SPEC §4 gives both). */
export type Density = "web" | "mobile";

/** A household-local calendar date (Temporal.PlainDate satisfies it). */
export type CalendarDate = PlainDateLike & { toString(): string };
