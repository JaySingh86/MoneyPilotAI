// SQL for email connections (BACKEND_PLAN §5.2). The API role has no SELECT on the token columns or the address
// hash (migration 202611091000), so none of these statements names them except the one INSERT, which only writes.
import { sql } from "drizzle-orm";
import type { Tx } from "@mp/db";
import type { EmailProviderId, EmailReturnTo } from "@mp/contracts";

export interface ConnectionRow {
  id: string;
  householdId: string;
  provider: EmailProviderId;
  userId: string;
  addressMasked: string;
  status: "active" | "paused" | "error" | "revoked";
  lastSyncedAt: string | null;
  backfillMonths: number;
  matched: number;
  used: number;
}

type ConnectionSql = {
  id: string;
  household_id: string;
  provider: EmailProviderId;
  user_id: string;
  address_masked: string;
  status: ConnectionRow["status"];
  last_synced_at: Date | string | null;
  backfill_months: number;
  matched: string | number;
  used: string | number;
};

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

function toRow(r: ConnectionSql): ConnectionRow {
  return {
    id: r.id,
    householdId: r.household_id,
    provider: r.provider,
    userId: r.user_id,
    addressMasked: r.address_masked,
    status: r.status,
    lastSyncedAt: iso(r.last_synced_at),
    backfillMonths: r.backfill_months,
    matched: Number(r.matched),
    used: Number(r.used),
  };
}

// Matched: it looked like a bill, statement or renewal (the prefilter let it through). Used: it produced an item
// or a change. Both are counted from message metadata; no body is stored.
const COLUMNS = sql`c.id, c.household_id, c.provider, c.user_id, c.address_masked, c.status, c.last_synced_at, c.backfill_months,
  (select count(*) from email_messages m where m.connection_id = c.id and m.stage <> 'prefiltered_out') as matched,
  (select count(*) from email_messages m where m.connection_id = c.id and m.stage = 'extracted') as used`;

export async function isMember(tx: Tx, householdId: string): Promise<boolean> {
  const res = await tx.execute(sql`select 1 from household_members
    where household_id = ${householdId} and user_id = app_user_id() and left_at is null`);
  return res.rows.length > 0;
}

export async function currentHouseholdId(tx: Tx): Promise<string | null> {
  const res = await tx.execute<{ household_id: string }>(sql`select household_id from household_members
    where user_id = app_user_id() and left_at is null order by joined_at limit 1`);
  return res.rows[0]?.household_id ?? null;
}

export async function listConnections(tx: Tx, householdId: string): Promise<ConnectionRow[]> {
  const res = await tx.execute<ConnectionSql>(sql`select ${COLUMNS} from email_connections c
    where c.household_id = ${householdId} and c.status <> 'revoked' order by c.created_at, c.id`);
  return res.rows.map(toRow);
}

export async function getConnection(tx: Tx, id: string): Promise<ConnectionRow | undefined> {
  const res = await tx.execute<ConnectionSql>(
    sql`select ${COLUMNS} from email_connections c where c.id = ${id}`,
  );
  return res.rows[0] ? toRow(res.rows[0]) : undefined;
}

/** Live (not revoked) connections that are healthy: what the household summary reports. */
export async function countActive(tx: Tx, householdId: string): Promise<number> {
  const res = await tx.execute<{ n: string }>(sql`select count(*) as n from email_connections
    where household_id = ${householdId} and status = 'active'`);
  return Number(res.rows[0]?.n ?? 0);
}

export async function setStatus(
  tx: Tx,
  id: string,
  from: readonly ConnectionRow["status"][],
  to: "active" | "paused" | "revoked",
): Promise<boolean> {
  const fromList = sql.join(
    from.map((s) => sql`${s}`),
    sql`, `,
  );
  const res = await tx.execute(sql`update email_connections
    set status = ${to}, revoked_at = ${to === "revoked" ? sql`now()` : sql`null`}
    where id = ${id} and status in (${fromList})`);
  return (res.rowCount ?? 0) > 0;
}

/** The leaver's own connections, for WP-05's leave transaction. Returns the ids revoked. */
export async function revokeAllOf(tx: Tx, householdId: string, userId: string): Promise<string[]> {
  const res = await tx.execute<{ id: string }>(sql`update email_connections
    set status = 'revoked', revoked_at = now()
    where household_id = ${householdId} and user_id = ${userId} and status <> 'revoked'
    returning id`);
  return res.rows.map((r) => r.id);
}

export async function insertState(
  tx: Tx,
  s: {
    stateHash: Buffer;
    browserHash: Buffer;
    userId: string;
    provider: EmailProviderId;
    returnTo: EmailReturnTo;
    verifier: string;
  },
  ttlMinutes: number,
): Promise<void> {
  await tx.execute(sql`insert into email_oauth_states (state_hash, user_id, provider, return_to, code_verifier, browser_hash, expires_at)
    values (${s.stateHash}, ${s.userId}, ${s.provider}, ${s.returnTo}, ${s.verifier}, ${s.browserHash},
            now() + make_interval(mins => ${ttlMinutes}))`);
}

export interface ConsumedState {
  userId: string;
  householdId: string | null;
  provider: EmailProviderId;
  returnTo: EmailReturnTo;
  verifier: string;
}

export async function consumeState(
  tx: Tx,
  stateHash: Buffer,
  browserHash: Buffer | null,
): Promise<ConsumedState | undefined> {
  const res = await tx.execute<{
    user_id: string;
    household_id: string | null;
    provider: EmailProviderId;
    return_to: EmailReturnTo;
    code_verifier: string;
  }>(sql`select * from app_email_oauth_consume(${stateHash}, ${browserHash})`);
  const r = res.rows[0];
  return r
    ? {
        userId: r.user_id,
        householdId: r.household_id,
        provider: r.provider,
        returnTo: r.return_to,
        verifier: r.code_verifier,
      }
    : undefined;
}

export async function insertConnection(
  tx: Tx,
  c: {
    id: string;
    householdId: string;
    userId: string;
    provider: EmailProviderId;
    addressMasked: string;
    addressHash: Buffer;
    scopes: string[];
    ciphertext: Uint8Array;
    dekWrapped: Uint8Array;
    keyId: string;
  },
): Promise<void> {
  const scopes = sql`array[${sql.join(
    c.scopes.map((s) => sql`${s}`),
    sql`, `,
  )}]::text[]`;
  await tx.execute(sql`insert into email_connections
      (id, household_id, user_id, provider, address_masked, address_hash, scopes,
       token_ciphertext, token_dek_wrapped, token_key_id, status)
    values (${c.id}, ${c.householdId}, ${c.userId}, ${c.provider}, ${c.addressMasked}, ${c.addressHash}, ${scopes},
            ${Buffer.from(c.ciphertext)}, ${Buffer.from(c.dekWrapped)}, ${c.keyId}, 'active')`);
}

export async function pushGmail(tx: Tx, addressHash: Buffer): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`select app_email_push_gmail(${addressHash}) as n`);
  return Number(res.rows[0]?.n ?? 0);
}

export async function pushGraph(tx: Tx, connectionId: string): Promise<number> {
  const res = await tx.execute<{ n: number }>(sql`select app_email_push_graph(${connectionId}) as n`);
  return Number(res.rows[0]?.n ?? 0);
}
