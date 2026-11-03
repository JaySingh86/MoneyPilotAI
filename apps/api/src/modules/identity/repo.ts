// SQL for the identity module. Every function takes the request's transaction (withHouseholdTx), so RLS
// applies. Raw SQL on purpose: mp_api has column-level grants, and the Drizzle query builder lists
// columns it has no privilege on.
import { sql } from "drizzle-orm";
import type { Tx } from "@mp/db";
import { toDate, toDateOrNull } from "./db-errors";

export interface UserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  timezone: string;
  mfaEnabled: boolean;
  createdAt: Date;
  deletedAt: Date | null;
}

type UserSqlRow = {
  id: string;
  email: string;
  first_name: string;
  last_name: string | null;
  timezone: string;
  mfa_enabled: boolean;
  created_at: Date;
  deleted_at: Date | null;
};

const USER_COLUMNS = sql`id, email::text as email, first_name, last_name, timezone, mfa_enabled, created_at, deleted_at`;

function toUser(row: UserSqlRow): UserRow {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    timezone: row.timezone,
    mfaEnabled: row.mfa_enabled,
    createdAt: toDate(row.created_at),
    deletedAt: toDateOrNull(row.deleted_at),
  };
}

export async function findUserBySubject(tx: Tx, authSubject: string): Promise<UserRow | undefined> {
  const res = await tx.execute<UserSqlRow>(
    sql`select ${USER_COLUMNS} from users where auth_subject = ${authSubject}`,
  );
  return res.rows[0] ? toUser(res.rows[0]) : undefined;
}

export async function findUserById(tx: Tx, userId: string): Promise<UserRow | undefined> {
  const res = await tx.execute<UserSqlRow>(sql`select ${USER_COLUMNS} from users where id = ${userId}`);
  return res.rows[0] ? toUser(res.rows[0]) : undefined;
}

export interface NewUser {
  authSubject: string;
  email: string;
  firstName: string;
  lastName: string | null;
  timezone: string;
}

/** Inserts the caller's own row (RLS: only for the verified subject). Null when a concurrent call won. */
export async function insertUser(tx: Tx, user: NewUser): Promise<UserRow | undefined> {
  const res =
    await tx.execute<UserSqlRow>(sql`insert into users (auth_subject, email, first_name, last_name, timezone)
    values (${user.authSubject}, ${user.email}, ${user.firstName}, ${user.lastName}, ${user.timezone})
    on conflict (auth_subject) do nothing
    returning ${USER_COLUMNS}`);
  return res.rows[0] ? toUser(res.rows[0]) : undefined;
}

/**
 * app_sync_auth_user (WP-03 + WP-05 migration): mirrors the verified email and MFA flag. Call it only
 * with values from a verified token whose email_verified claim is true. The database refuses any subject
 * but the request's own and refuses deletes.
 */
export async function syncAuthUser(
  tx: Tx,
  authSubject: string,
  email: string,
  mfaEnabled: boolean,
): Promise<boolean> {
  const res = await tx.execute<{ ok: boolean }>(
    sql`select app_sync_auth_user(${authSubject}, ${email}, ${mfaEnabled}, false) as ok`,
  );
  return res.rows[0]?.ok === true;
}

export interface ProfilePatch {
  firstName?: string;
  lastName?: string | null;
  timezone?: string;
}

export async function updateProfile(
  tx: Tx,
  userId: string,
  patch: ProfilePatch,
): Promise<UserRow | undefined> {
  const assignments = [
    patch.firstName !== undefined ? sql`first_name = ${patch.firstName}` : undefined,
    patch.lastName !== undefined ? sql`last_name = ${patch.lastName}` : undefined,
    patch.timezone !== undefined ? sql`timezone = ${patch.timezone}` : undefined,
  ].filter((a) => a !== undefined);
  if (assignments.length === 0) return findUserById(tx, userId);
  const res = await tx.execute<UserSqlRow>(
    sql`update users set ${sql.join(assignments, sql`, `)} where id = ${userId} returning ${USER_COLUMNS}`,
  );
  return res.rows[0] ? toUser(res.rows[0]) : undefined;
}

export interface MembershipRow {
  householdId: string;
  householdName: string;
  colorRole: "partnerA" | "partnerB";
  isCreator: boolean;
  joinedAt: Date;
}

export async function listMemberships(tx: Tx, userId: string): Promise<MembershipRow[]> {
  const res = await tx.execute<{
    household_id: string;
    name: string;
    color_role: "partnerA" | "partnerB";
    is_creator: boolean;
    joined_at: Date;
  }>(sql`select m.household_id, h.name, m.color_role, m.is_creator, m.joined_at
           from household_members m join households h on h.id = m.household_id
          where m.user_id = ${userId} and m.left_at is null
          order by m.joined_at`);
  return res.rows.map((r) => ({
    householdId: r.household_id,
    householdName: r.name,
    colorRole: r.color_role,
    isCreator: r.is_creator,
    joinedAt: toDate(r.joined_at),
  }));
}
