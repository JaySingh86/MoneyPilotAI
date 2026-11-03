// Seed loader, part 3 (WP-13): the fixture's `tasks` (3 due this week, 4 later, 3 done as of the fixture
// date; nav badge 3). Run after `seedPlanning`'s items exist (it calls this itself).
//
// The fixture gives a title, owner, due date, hint and done flag only. The source, the linked item and the
// auto-complete rule below are inferred from the title (QUESTIONS.md Q-110): the electricity task completes
// when the actual amount arrives; renewal tasks link to their renewal item.
import { sql } from "drizzle-orm";
import type { WorkerDb } from "../tx";
import type { SeedResult } from "./rivera";

type Source = "user" | "engine" | "email" | "renewal" | "setup";

interface TaskMeta {
  source: Source;
  /** Fixture id of the linked item. */
  item?: string;
  dedupeKey?: string;
  /** Completes itself when the actual amount of the linked item arrives. */
  autoComplete?: boolean;
  completedReason?: string;
}

const TASK_META: Readonly<Record<string, TaskMeta>> = {
  t1: { source: "engine", dedupeKey: "flags:review_subscriptions" },
  t2: { source: "engine", item: "b-power", dedupeKey: "flag:estimate:b-power", autoComplete: true },
  t3: { source: "renewal", item: "b-carins" },
  t4: { source: "email", item: "r-health" },
  t5: { source: "renewal", item: "r-av" },
  t6: { source: "renewal", item: "r-renters" },
  t7: { source: "renewal", item: "r-reg" },
  d1: { source: "setup", completedReason: "setup" },
  d2: { source: "setup", completedReason: "setup" },
  d3: { source: "setup", completedReason: "setup" },
};

interface Rec {
  [key: string]: unknown;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`fixture: ${path} must be a non-empty string`);
  return value;
}

export interface SeedTask {
  fixtureId: string;
  title: string;
  /** A fixture member id, `both` or `split`. */
  owner: string;
  dueOn: string | null;
  dueHint: string | null;
  completed: boolean;
  meta: TaskMeta;
}

/** Validates the fixture's tasks and maps them to rows. Pure. */
export function planTasksSeed(fixture: unknown): SeedTask[] {
  const root = fixture as Rec;
  if (!Array.isArray(root.tasks)) throw new Error("fixture: tasks must be an array");
  return root.tasks.map((raw, i) => {
    const t = raw as Rec;
    const path = `tasks[${i}]`;
    const id = str(t.id, `${path}.id`);
    const meta = TASK_META[id];
    if (!meta) throw new Error(`fixture: ${path} (${id}) has no source mapping in seed/tasks.ts`);
    return {
      fixtureId: id,
      title: str(t.title, `${path}.title`),
      owner: str(t.owner, `${path}.owner`),
      dueOn: t.dueOn === null || t.dueOn === undefined ? null : str(t.dueOn, `${path}.dueOn`),
      dueHint: t.dueHint === undefined ? null : str(t.dueHint, `${path}.dueHint`),
      completed: t.completed === true,
      meta,
    };
  });
}

/** Idempotent: a household that already has tasks is left alone. Written by the worker role. */
export async function seedTasks(
  worker: WorkerDb,
  seeded: SeedResult,
  fixture: unknown,
  userIdForMember: (member: string) => string,
  /** The deterministic row id for a fixture id (`planningUuid` in seed/items.ts). */
  idFor: (householdId: string, fixtureId: string) => string,
): Promise<number> {
  const tasks = planTasksSeed(fixture);
  const householdId = seeded.householdId;
  const creatorId = seeded.userIds.creator;
  return worker.withJobTx(householdId, async (tx) => {
    const existing = await tx.execute<{ n: string }>(
      sql`select count(*)::text as n from tasks where household_id = ${householdId}`,
    );
    if (Number(existing.rows[0]?.n ?? 0) > 0) return 0;
    for (const t of tasks) {
      const isMember = t.owner !== "both" && t.owner !== "split";
      const itemId = t.meta.item ? idFor(householdId, t.meta.item) : null;
      const rule =
        t.meta.autoComplete && itemId ? JSON.stringify({ type: "actual_amount_received", itemId }) : null;
      await tx.execute(sql`insert into tasks
          (id, household_id, title, owner_type, owner_user_id, due_on, due_hint, linked_item_id, source,
           dedupe_key, auto_complete_rule, completed_at, completed_by, completed_reason, created_by)
        values (${idFor(householdId, t.fixtureId)}, ${householdId}, ${t.title},
           ${isMember ? "member" : t.owner}::owner_type, ${isMember ? userIdForMember(t.owner) : null},
           ${t.dueOn}::date, ${t.dueHint}, ${itemId}, ${t.meta.source}, ${t.meta.dedupeKey ?? null},
           ${rule}::jsonb,
           ${t.completed ? `${t.dueOn ?? "2026-10-26"}T12:00:00Z` : null}::timestamptz,
           ${t.completed ? creatorId : null}, ${t.completed ? (t.meta.completedReason ?? "manual") : null},
           ${creatorId})`);
    }
    return tasks.length;
  });
}
