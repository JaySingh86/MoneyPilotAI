// Notifications API logic (BACKEND_PLAN §8.2): the caller's own list, read state and email preferences.
import {
  AppError,
  type Notification,
  type NotificationList,
  type NotificationPreferences,
  type ReminderRule,
  BUILT_IN_REMINDER_RULE,
  type UpdateNotificationPreferences,
} from "@mp/contracts";
import type { ApiContext, ApiDb, Tx } from "@mp/db";
import { notFound } from "../items/changes";
import { mapDbError, type Actor } from "../items/service";
import * as itemsRepo from "../items/repo";
import * as repo from "./repo";

export interface NotifyDeps {
  db: ApiDb;
}

async function inTx<T>(deps: NotifyDeps, ctx: ApiContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await deps.db.withHouseholdTx(ctx, fn);
  } catch (err) {
    return mapDbError(err);
  }
}

/** Cursor = `<send_at as printed by Postgres, microseconds>|<id>`, base64url. */
function encodeCursor(sendAt: string, id: string): string {
  return Buffer.from(`${sendAt}|${id}`, "utf8").toString("base64url");
}

const SEND_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(cursor: string): { sendAt: string; id: string } {
  const [sendAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!sendAt || !id || !SEND_AT.test(sendAt) || !UUID.test(id)) {
    throw new AppError("validation_failed", 400, "The cursor is not valid.");
  }
  return { sendAt, id };
}

export async function listNotifications(
  deps: NotifyDeps,
  a: Actor,
  query: { limit: number; cursor?: string | undefined; unread?: "true" | "false" | undefined },
): Promise<NotificationList> {
  const after = query.cursor ? decodeCursor(query.cursor) : undefined;
  return inTx(deps, a.ctx, async (tx) => {
    const rows = await repo.listNotifications(tx, a.householdId, a.userId, {
      limit: query.limit + 1,
      after,
      unread: query.unread === "true",
    });
    const data = rows.slice(0, query.limit);
    const last = data[data.length - 1];
    let nextCursor: string | null = null;
    if (rows.length > query.limit && last) {
      const sendAt = await repo.sendAtOf(tx, a.householdId, a.userId, last.id);
      nextCursor = sendAt ? encodeCursor(sendAt, last.id) : null;
    }
    return { data, nextCursor, unreadCount: await repo.unreadCount(tx, a.householdId, a.userId) };
  });
}

export async function markRead(deps: NotifyDeps, a: Actor, id: string): Promise<Notification> {
  return inTx(deps, a.ctx, async (tx) => {
    const n = await repo.markRead(tx, a.householdId, a.userId, id);
    if (!n) throw notFound("Notification");
    return n;
  });
}

export async function getPreferences(deps: NotifyDeps, ctx: ApiContext, userId: string) {
  return inTx(deps, ctx, (tx) => repo.getPreferences(tx, userId));
}

export async function updatePreferences(
  deps: NotifyDeps,
  ctx: ApiContext,
  userId: string,
  body: UpdateNotificationPreferences,
): Promise<NotificationPreferences> {
  return inTx(deps, ctx, async (tx) => {
    await repo.upsertPreferences(tx, userId, body);
    return repo.getPreferences(tx, userId);
  });
}

// ===== Reminder rules (Q-133) =====
/** RLS would hide another household's rows, but the answer must be a refusal, not a built-in default. */
async function requireMember(tx: Tx, a: Actor): Promise<void> {
  if (!(await itemsRepo.isMember(tx, a.householdId, a.userId))) {
    throw new AppError("forbidden", 403, "You do not have access to this household.");
  }
}

export async function getDefaultRule(deps: NotifyDeps, a: Actor): Promise<ReminderRule> {
  return inTx(deps, a.ctx, async (tx) => {
    await requireMember(tx, a);
    return (await repo.getRule(tx, a.householdId, null)) ?? BUILT_IN_REMINDER_RULE;
  });
}

export async function putDefaultRule(deps: NotifyDeps, a: Actor, rule: ReminderRule): Promise<ReminderRule> {
  return inTx(deps, a.ctx, async (tx) => {
    await requireMember(tx, a);
    return repo.upsertRule(tx, a.householdId, null, rule);
  });
}

export async function getItemRule(deps: NotifyDeps, a: Actor, itemId: string): Promise<ReminderRule | null> {
  return inTx(deps, a.ctx, async (tx) => {
    await requireMember(tx, a);
    if (!(await repo.itemExists(tx, a.householdId, itemId))) throw notFound("Item");
    return repo.getRule(tx, a.householdId, itemId);
  });
}

/** `null` removes the item's own rule (it then follows the household default). */
export async function putItemRule(
  deps: NotifyDeps,
  a: Actor,
  itemId: string,
  rule: ReminderRule | null,
): Promise<ReminderRule | null> {
  return inTx(deps, a.ctx, async (tx) => {
    await requireMember(tx, a);
    if (!(await repo.itemExists(tx, a.householdId, itemId))) throw notFound("Item");
    if (rule === null) {
      await repo.deleteRule(tx, a.householdId, itemId);
      return null;
    }
    return repo.upsertRule(tx, a.householdId, itemId, rule);
  });
}
