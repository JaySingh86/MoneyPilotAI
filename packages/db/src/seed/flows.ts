// Household lifecycle steps written against the RLS policies, as mp_api through withHouseholdTx.
// The seed loader and the RLS harness both use them, so every seeded row proves the app-role path.
// WP-05 owns the real API services; these are the minimal SQL steps those services must perform.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ApiDb } from "../tx";

/** What bootstrap knows about a user before the users row exists (from the verified auth token). */
export interface UserProfile {
  authSubject: string;
  email: string;
  firstName: string;
  lastName?: string | null;
  timezone?: string;
}

export interface SeedUser extends UserProfile {
  /** users.id, assigned by the database. */
  id: string;
}

export interface SeedHousehold {
  id: string;
  name: string;
  timezone: string;
  forwardingToken: string;
  cushionCents?: number;
}

/**
 * Bootstrap: insert the caller's own users row (only allowed for the verified auth subject) or find the
 * existing one. The database assigns the id; the API cannot choose it.
 */
export async function ensureUser(db: ApiDb, profile: UserProfile): Promise<SeedUser> {
  return db.withHouseholdTx({ userId: null, authSubject: profile.authSubject }, async (tx) => {
    await tx.execute(sql`insert into users (auth_subject, email, first_name, last_name, timezone)
      values (${profile.authSubject}, ${profile.email}, ${profile.firstName}, ${profile.lastName ?? null},
              ${profile.timezone ?? "America/New_York"})
      on conflict (auth_subject) do nothing`);
    const res = await tx.execute<{ id: string }>(
      sql`select id from users where auth_subject = ${profile.authSubject}`,
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error("bootstrap could not read back the users row");
    return { ...profile, id };
  });
}

/**
 * Creates the household and the creator's partnerA membership in one transaction (BACKEND_PLAN §6).
 * The id is supplied by the caller: the creator cannot read the row back until the membership exists.
 * Returns false if the creator already belongs to a household with this id.
 */
export async function createHousehold(
  db: ApiDb,
  creator: SeedUser,
  household: SeedHousehold,
): Promise<boolean> {
  return db.withHouseholdTx({ userId: creator.id, householdId: household.id }, async (tx) => {
    const existing = await tx.execute(sql`select 1 from households where id = ${household.id}`);
    if (existing.rows.length > 0) return false;
    await tx.execute(sql`insert into households (id, name, timezone, forwarding_token, created_by, cushion_cents)
      values (${household.id}, ${household.name}, ${household.timezone}, ${household.forwardingToken}, ${creator.id},
              ${household.cushionCents ?? 50000})`);
    await tx.execute(sql`insert into household_members (household_id, user_id, color_role, is_creator)
      values (${household.id}, ${creator.id}, 'partnerA', true)`);
    await tx.execute(sql`insert into audit_events (household_id, actor_user_id, actor_type, action, entity_type, entity_id)
      values (${household.id}, ${creator.id}, 'user', 'household.created', 'household', ${household.id})`);
    return true;
  });
}

export interface CreatedInvite {
  id: string;
  /** Only ever in the email link; the DB stores its sha256. */
  token: string;
}

export function hashInviteToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export async function inviteMember(
  db: ApiDb,
  inviter: SeedUser,
  householdId: string,
  email: string,
  expiresInDays = 7,
): Promise<CreatedInvite> {
  const invite = { id: randomUUID(), token: randomBytes(32).toString("base64url") };
  await db.withHouseholdTx({ userId: inviter.id, householdId }, async (tx) => {
    await tx.execute(sql`insert into invites (id, household_id, email, token_hash, invited_by, expires_at)
      values (${invite.id}, ${householdId}, ${email}, ${hashInviteToken(invite.token)}, ${inviter.id},
              now() + make_interval(days => ${expiresInDays}))`);
    await tx.execute(sql`insert into audit_events (household_id, actor_user_id, actor_type, action, entity_type, entity_id)
      values (${householdId}, ${inviter.id}, 'user', 'invite.created', 'invite', ${invite.id})`);
  });
  return invite;
}

/**
 * Accept by the emailed token: app_accept_invite checks the invite and, atomically, joins the invitee as
 * partnerB, marks the invite accepted and writes the audit event. Returns the household id.
 */
export async function acceptInvite(db: ApiDb, invitee: SeedUser, token: string): Promise<string> {
  return db.withHouseholdTx({ userId: invitee.id }, async (tx) => {
    const res = await tx.execute<{ household_id: string }>(
      sql`select app_accept_invite(${hashInviteToken(token)}) as household_id`,
    );
    const householdId = res.rows[0]?.household_id;
    if (!householdId) throw new Error("app_accept_invite returned no household");
    return householdId;
  });
}
