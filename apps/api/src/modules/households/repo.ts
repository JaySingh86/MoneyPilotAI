// SQL for households, members and invites. Every function takes the request's transaction
// (withHouseholdTx), so RLS applies: a non-member simply sees no rows. Raw SQL on purpose, because mp_api
// has column-level grants. Invites are accepted only through `app_accept_invite` and looked up only
// through `app_invite_lookup` (WP-03); this file never reads another user's invite directly.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Tx } from "@mp/db";
import { toDate, toDateOrNull } from "../identity/db-errors";

export interface HouseholdRow {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  cushionCents: number;
  primaryIncomeItemId: string | null;
  plan: "free" | "family_plus";
  forwardingToken: string;
  deletionScheduledFor: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

type HouseholdSql = {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  cushion_cents: string | number;
  primary_income_item_id: string | null;
  plan: "free" | "family_plus";
  forwarding_token: string;
  deletion_scheduled_for: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
};

const HOUSEHOLD_COLUMNS = sql`id, name, timezone, currency, cushion_cents, primary_income_item_id, plan,
  forwarding_token, deletion_scheduled_for, version, created_at, updated_at`;

function toHousehold(row: HouseholdSql): HouseholdRow {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    currency: row.currency,
    cushionCents: Number(row.cushion_cents),
    primaryIncomeItemId: row.primary_income_item_id,
    plan: row.plan,
    forwardingToken: row.forwarding_token,
    deletionScheduledFor: toDateOrNull(row.deletion_scheduled_for),
    version: row.version,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

export async function getHousehold(tx: Tx, householdId: string): Promise<HouseholdRow | undefined> {
  const res = await tx.execute<HouseholdSql>(
    sql`select ${HOUSEHOLD_COLUMNS} from households where id = ${householdId}`,
  );
  return res.rows[0] ? toHousehold(res.rows[0]) : undefined;
}

export interface NewHousehold {
  id: string;
  name: string;
  timezone: string;
  cushionCents: number | undefined;
  forwardingToken: string;
  createdBy: string;
}

/**
 * The creator cannot read the row back until their membership exists, so the id is chosen here and the
 * insert does not use RETURNING (WP-03 policy). Create the membership next, in the same transaction.
 */
export async function insertHousehold(tx: Tx, h: NewHousehold): Promise<void> {
  await tx.execute(sql`insert into households (id, name, timezone, cushion_cents, forwarding_token, created_by)
    values (${h.id}, ${h.name}, ${h.timezone}, ${h.cushionCents ?? 50000}, ${h.forwardingToken}, ${h.createdBy})`);
}

export async function insertCreatorMember(tx: Tx, householdId: string, userId: string): Promise<void> {
  await tx.execute(sql`insert into household_members (household_id, user_id, color_role, is_creator)
    values (${householdId}, ${userId}, 'partnerA', true)`);
}

export interface HouseholdPatch {
  name?: string;
  timezone?: string;
  cushionCents?: number;
}

/** Updates only when the stored version is still `expected` (the trigger then bumps it). */
export async function updateHousehold(
  tx: Tx,
  householdId: string,
  expected: number,
  patch: HouseholdPatch,
): Promise<HouseholdRow | undefined> {
  const assignments = [
    patch.name !== undefined ? sql`name = ${patch.name}` : undefined,
    patch.timezone !== undefined ? sql`timezone = ${patch.timezone}` : undefined,
    patch.cushionCents !== undefined ? sql`cushion_cents = ${patch.cushionCents}` : undefined,
  ].filter((a) => a !== undefined);
  const res = await tx.execute<HouseholdSql>(sql`update households set ${sql.join(assignments, sql`, `)}
    where id = ${householdId} and version = ${expected}
    returning ${HOUSEHOLD_COLUMNS}`);
  return res.rows[0] ? toHousehold(res.rows[0]) : undefined;
}

export interface MemberRow {
  userId: string;
  firstName: string;
  lastName: string | null;
  email: string;
  colorRole: "partnerA" | "partnerB";
  isCreator: boolean;
  joinedAt: Date;
}

/** Active members (left_at is null), creator first. */
export async function listActiveMembers(tx: Tx, householdId: string): Promise<MemberRow[]> {
  const res = await tx.execute<{
    user_id: string;
    first_name: string;
    last_name: string | null;
    email: string;
    color_role: "partnerA" | "partnerB";
    is_creator: boolean;
    joined_at: Date;
  }>(sql`select m.user_id, u.first_name, u.last_name, u.email::text as email, m.color_role, m.is_creator, m.joined_at
           from household_members m join users u on u.id = m.user_id
          where m.household_id = ${householdId} and m.left_at is null
          order by m.color_role`);
  return res.rows.map((r) => ({
    userId: r.user_id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    colorRole: r.color_role,
    isCreator: r.is_creator,
    joinedAt: toDate(r.joined_at),
  }));
}

export async function endMembership(tx: Tx, householdId: string, userId: string): Promise<boolean> {
  const res = await tx.execute(sql`update household_members set left_at = now()
    where household_id = ${householdId} and user_id = ${userId} and left_at is null`);
  return (res.rowCount ?? 0) > 0;
}

// ===== Invites =====

export function hashInviteToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export interface InviteRow {
  id: string;
  email: string;
  expiresAt: Date;
  createdAt: Date;
}

type InviteSql = {
  id: string;
  email: string;
  expires_at: Date;
  created_at: Date;
};

const toInvite = (r: InviteSql): InviteRow => ({
  id: r.id,
  email: r.email,
  expiresAt: toDate(r.expires_at),
  createdAt: toDate(r.created_at),
});

/** Serializes invite creation for one household (released at commit), so "one open invite" holds under races. */
export async function lockInvites(tx: Tx, householdId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`invite_create:${householdId}`}, 0))`);
}

/** Revokes invites that expired without being used, so they stop counting as "open". */
export async function revokeExpiredInvites(tx: Tx, householdId: string): Promise<void> {
  await tx.execute(sql`update invites set revoked_at = now()
    where household_id = ${householdId} and accepted_at is null and revoked_at is null and expires_at <= now()`);
}

/** The pending invite, if any: not accepted, not revoked, not expired. */
export async function findOpenInvite(tx: Tx, householdId: string): Promise<InviteRow | undefined> {
  const res =
    await tx.execute<InviteSql>(sql`select id, email::text as email, expires_at, created_at from invites
    where household_id = ${householdId} and accepted_at is null and revoked_at is null and expires_at > now()
    order by created_at desc limit 1`);
  return res.rows[0] ? toInvite(res.rows[0]) : undefined;
}

export async function insertInvite(
  tx: Tx,
  invite: { id: string; householdId: string; email: string; tokenHash: Buffer; invitedBy: string },
): Promise<InviteRow> {
  const res =
    await tx.execute<InviteSql>(sql`insert into invites (id, household_id, email, token_hash, invited_by, expires_at)
    values (${invite.id}, ${invite.householdId}, ${invite.email}, ${invite.tokenHash}, ${invite.invitedBy},
            now() + interval '7 days')
    returning id, email::text as email, expires_at, created_at`);
  const row = res.rows[0];
  if (!row) throw new Error("invite insert returned no row");
  return toInvite(row);
}

export type InviteState = "revoked" | "accepted" | "missing";

/** Revokes a pending invite of this household. Otherwise reports why nothing changed. */
export async function revokeInvite(
  tx: Tx,
  householdId: string,
  inviteId: string,
): Promise<"revoked" | InviteState> {
  const res = await tx.execute(sql`update invites set revoked_at = now()
    where id = ${inviteId} and household_id = ${householdId} and accepted_at is null and revoked_at is null`);
  if ((res.rowCount ?? 0) > 0) return "revoked";
  const state = await tx.execute<{
    accepted: boolean;
    revoked: boolean;
  }>(sql`select accepted_at is not null as accepted,
      revoked_at is not null as revoked from invites where id = ${inviteId} and household_id = ${householdId}`);
  const row = state.rows[0];
  if (!row) return "missing";
  return row.accepted ? "accepted" : "revoked";
}

export type InviteLookupStatus = "valid" | "expired" | "revoked" | "accepted" | "mismatch";

/** `app_invite_lookup` (WP-03): status plus the masked address; possession of the token is the credential. */
export async function lookupInvite(
  tx: Tx,
  tokenHash: Buffer,
): Promise<{ status: InviteLookupStatus; maskedEmail: string | null } | undefined> {
  const res = await tx.execute<{ status: InviteLookupStatus; masked_email: string | null }>(
    sql`select status, masked_email from app_invite_lookup(${tokenHash})`,
  );
  const row = res.rows[0];
  return row ? { status: row.status, maskedEmail: row.masked_email } : undefined;
}

/** `app_accept_invite` (WP-03): the only way a user joins by invite. Returns the household id. */
export async function acceptInvite(tx: Tx, tokenHash: Buffer): Promise<string> {
  const res = await tx.execute<{ household_id: string }>(
    sql`select app_accept_invite(${tokenHash}) as household_id`,
  );
  const id = res.rows[0]?.household_id;
  if (!id) throw new Error("app_accept_invite returned no household");
  return id;
}

export async function findUserTimezone(tx: Tx, userId: string): Promise<string | undefined> {
  const res = await tx.execute<{ timezone: string }>(sql`select timezone from users where id = ${userId}`);
  return res.rows[0]?.timezone;
}

export async function findUserFirstName(tx: Tx, userId: string): Promise<string | undefined> {
  const res = await tx.execute<{ first_name: string }>(
    sql`select first_name from users where id = ${userId}`,
  );
  return res.rows[0]?.first_name;
}

/** True when the user has an active membership in any household (one household per user, Q-085). */
export async function hasActiveMembership(tx: Tx, userId: string): Promise<boolean> {
  const res = await tx.execute(
    sql`select 1 from household_members where user_id = ${userId} and left_at is null limit 1`,
  );
  return res.rows.length > 0;
}

/** Invites this user created in the last 24 hours, in households they belong to (daily cap of 5). */
export async function countRecentInvitesBy(tx: Tx, userId: string): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`select count(*)::int as n from invites
    where invited_by = ${userId} and created_at > now() - interval '24 hours'`);
  return res.rows[0]?.n ?? 0;
}

/** Revokes the pending invites a leaving member created. */
export async function revokePendingInvitesBy(tx: Tx, householdId: string, userId: string): Promise<void> {
  await tx.execute(sql`update invites set revoked_at = now()
    where household_id = ${householdId} and invited_by = ${userId} and accepted_at is null and revoked_at is null`);
}

/** `app_transfer_creator` (WP-05 migration): hands is_creator to the other member when the caller is the creator. */
export async function transferCreator(tx: Tx, householdId: string): Promise<string | null> {
  const res = await tx.execute<{ id: string | null }>(sql`select app_transfer_creator(${householdId}) as id`);
  return res.rows[0]?.id ?? null;
}
