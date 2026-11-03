// Audit events written by the API (BACKEND_PLAN §5.2, §7.11). Append-only; the metadata never holds
// emails, tokens or amounts: ids and field names only.
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import type { Tx } from "@mp/db";

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/** Client IP (as resolved by Fastify's trustProxy setting) and a bounded user agent. */
export function requestMeta(request: FastifyRequest): RequestMeta {
  const ua = request.headers["user-agent"];
  return {
    ip: isIP(request.ip) ? request.ip : null,
    userAgent: typeof ua === "string" ? ua.slice(0, 256) : null,
  };
}

export interface AuditEvent {
  householdId: string | null;
  actorUserId: string;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, string | number | boolean | string[]>;
  meta?: RequestMeta;
}

/**
 * The insert policy requires actor_user_id = the signed-in user and, for a household event, current
 * membership: record the event BEFORE a statement that ends the membership (leave).
 */
export async function recordAudit(tx: Tx, event: AuditEvent): Promise<void> {
  await tx.execute(sql`insert into audit_events
      (household_id, actor_user_id, actor_type, action, entity_type, entity_id, metadata, ip, user_agent)
    values (${event.householdId}, ${event.actorUserId}, 'user', ${event.action}, ${event.entityType ?? null},
            ${event.entityId ?? null}, ${JSON.stringify(event.metadata ?? {})}::jsonb,
            ${event.meta?.ip ?? null}::inet, ${event.meta?.userAgent ?? null})`);
}
