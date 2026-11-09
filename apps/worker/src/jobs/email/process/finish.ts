// email.validate + email.match + email.decide + the writes (BACKEND_PLAN §7.8.2), for ONE message whose extraction has
// come back (a direct call or a collected batch). One transaction: the review row or the automatic change, the
// notification, the price-change reminder and the message's new stage commit together or not at all. A repeat finds
// the message already moved (row lock + stage check) and does nothing, so a retried job is harmless.
//
// By the time this runs the body is gone: only the model's outcome and the `PreparedSummary` signals remain.
import { Temporal } from "@js-temporal/polyfill";
import { ROUTES } from "@mp/ai";
import { EXTRACT_PROMPT_ID, type ExtractOutcome } from "@mp/ai/extract";
import { householdToday, insertNotification, type Tx, type WorkerDb } from "@mp/db";
import { isSameOrSubdomain } from "@mp/email";
import { isMonthlySubscription } from "@mp/notify";
import type { Logger } from "@mp/observability";
import type { JobSender } from "../../plan/recompute";
import { enqueuePlanRecompute } from "../../plan/recompute";
import { enqueueRemindersPlan } from "../../reminders/plan";
import { evaluate, isPriceChange, runMatch, triage, type Evaluation, type PreparedSummary } from "./analyze";
import { applyAutomaticChange } from "./items-port";
import { messageMeta } from "./message-meta";
import { insertPriceChangeReminders, planPriceChangeReminders } from "./reminder";
import * as repo from "./repo";

export interface FinishDeps {
  db: WorkerDb;
  /** UTC instant as ISO 8601. */
  now: () => string;
  log: Pick<Logger, "info" | "warn" | "error">;
  /** Used after commit to refresh the plan and reminders. Optional: the sweeps catch up without it. */
  sender?: JobSender | undefined;
}

export type FinishOutcome =
  | "queued"
  | "auto_applied"
  | "irrelevant"
  | "failed"
  | "prefiltered_out"
  /** Already processed by an earlier run, or the message is gone. */
  | "skipped";

/** At most this many items are announced one by one in a day; after that one daily digest says it once. */
export const REVIEW_NOTIFICATIONS_PER_DAY = 3;

export type ModelOutcome = ExtractOutcome | { status: "batch_error" };

/** The message cannot be read or extracted: it leaves `discovered` so it is not retried forever. */
export async function failMessage(
  deps: FinishDeps,
  householdId: string,
  messageId: string,
  stage: "failed" | "irrelevant" | "prefiltered_out" = "failed",
): Promise<FinishOutcome> {
  return deps.db.withJobTx(householdId, async (tx) => {
    const m = await repo.lockMessage(tx, householdId, messageId);
    if (!m || m.stage !== "discovered") return "skipped";
    await repo.finishMessage(tx, householdId, messageId, {
      stage,
      truncated: false,
      subject: null,
      nowIso: deps.now(),
    });
    return stage;
  });
}

/** True when a message's sender is on the household's (or the global) ignore list. */
export function isIgnoredSender(fromDomain: string, ignored: readonly string[]): boolean {
  return ignored.some((d) => isSameOrSubdomain(fromDomain, d));
}

export async function finishExtracted(
  deps: FinishDeps,
  args: {
    householdId: string;
    messageId: string;
    /** Who is told about new review items: the mailbox's owner. */
    notifyUserId: string;
    prepared: PreparedSummary;
    outcome: ModelOutcome;
  },
): Promise<FinishOutcome> {
  const { householdId, messageId } = args;
  const nowIso = deps.now();
  let wrote = false;
  const result = await deps.db.withJobTx(householdId, async (tx): Promise<FinishOutcome> => {
    const message = await repo.lockMessage(tx, householdId, messageId);
    if (!message || message.stage !== "discovered") return "skipped";
    const done = (stage: repo.FinalStage, subject: string | null = null) =>
      repo.finishMessage(tx, householdId, messageId, {
        stage,
        truncated: args.prepared.truncated,
        subject,
        nowIso,
      });

    const t = triage(args.outcome, args.prepared);
    if (t.kind === "unusable") {
      await done("failed");
      return "failed";
    }
    if (t.kind === "irrelevant") {
      await done("irrelevant");
      return "irrelevant";
    }

    const facts = await repo.householdFacts(tx, householdId);
    if (!facts) {
      await done("failed");
      return "failed";
    }
    const fields = t.mapped.fields;
    const match = runMatch(await repo.loadMatchables(tx, householdId), fields, args.prepared, message);
    const item =
      match.status === "matched" && match.itemId !== null
        ? await repo.loadItemContext(tx, householdId, match.itemId, nowIso)
        : null;
    const firstSeen = item !== null ? await repo.senderFirstSeen(tx, householdId, message.fromDomain) : true;

    const ev = evaluate({
      extracted: t,
      prepared: args.prepared,
      message,
      match,
      item,
      senderFirstSeen: firstSeen,
      autoApplyEnabled: facts.autoApplyEnabled,
    });
    if (ev.kind === "skip") {
      await done("irrelevant");
      return "irrelevant";
    }

    const meta = messageMeta({
      fromDomain: message.fromDomain,
      subject: args.prepared.subject,
      receivedAtIso: message.receivedAtIso,
    });
    const base = {
      householdId,
      messageId,
      extractorVersion: EXTRACT_PROMPT_ID,
      modelId: ROUTES.extract.model,
      fields: fields,
      evidence: t.mapped.evidence,
      messageMeta: meta,
      matchItemId: ev.matchItemId,
      matchType: ev.matchType,
      nowIso,
    };

    let outcome: FinishOutcome = "queued";
    if (ev.decision.action === "auto_apply" && ev.matchItemId !== null) {
      // The same guards as the API (see items-port.ts). A refusal is not an error: a person decides instead.
      const applied = await applyAutomaticChange(tx, {
        householdId,
        itemId: ev.matchItemId,
        change: ev.decision.change,
        fields,
      });
      if (applied.ok) {
        const changeId = await repo.insertAutomaticChange(tx, householdId, {
          entityId: applied.entityId,
          before: applied.before,
          after: applied.after,
          appliedAtIso: nowIso,
        });
        const id = await repo.insertExtractedItem(tx, {
          ...base,
          checks: ev.checks,
          state: "auto_applied",
          appliedChangeId: changeId,
        });
        await repo.audit(tx, householdId, "review.auto_applied", "extracted_item", id);
        wrote = applied.wrote;
        outcome = "auto_applied";
      } else {
        const id = await repo.insertExtractedItem(tx, {
          ...base,
          checks: refused(ev, applied.code),
          state: "queued",
          appliedChangeId: null,
        });
        await notifyReview(tx, args.notifyUserId, householdId, id, facts.timezone, nowIso);
      }
    } else {
      const id = await repo.insertExtractedItem(tx, {
        ...base,
        checks: ev.checks,
        state: "queued",
        appliedChangeId: null,
      });
      await notifyReview(tx, args.notifyUserId, householdId, id, facts.timezone, nowIso);
    }

    // A price increase on a monthly subscription reminds its owner once (Q-134), reviewed or not.
    if (
      ev.reminderAllowed &&
      item !== null &&
      isMonthlySubscription(item.rrule, item.category) &&
      isPriceChange(t, item)
    ) {
      await insertPriceChangeReminders(
        tx,
        householdId,
        planPriceChangeReminders({
          item,
          members: await repo.memberIds(tx, householdId),
          timezone: facts.timezone,
          nowIso,
          today: householdToday(nowIso, facts.timezone),
        }),
      );
    }

    await done("extracted", meta.subject);
    return outcome;
  });

  if (wrote && deps.sender) {
    // After commit, best effort: `GET /plan` computes on read and the 15-minute sweep re-plans reminders anyway.
    try {
      await enqueuePlanRecompute(deps.sender, householdId);
      await enqueueRemindersPlan(deps.sender, householdId);
    } catch (err) {
      deps.log.warn({ err }, "could not queue the plan refresh after an automatic change");
    }
  }
  return result;
}

/** The stored checks when auto-apply was chosen but the items port refused: the item goes to review, and says why. */
function refused(ev: Extract<Evaluation, { kind: "route" }>, code: string): Record<string, unknown> {
  return {
    ...ev.checks,
    decision: { action: "review", reasons: ["apply_refused"], refused: code },
  };
}

/**
 * Tells the mailbox's owner there is something to review: one notification per item for the first few of the day, then a
 * single digest for the rest ("a daily digest if more than 3", BACKEND_PLAN §7.8.2). No names or amounts in the text.
 */
async function notifyReview(
  tx: Tx,
  userId: string,
  householdId: string,
  extractedItemId: string,
  timezone: string,
  nowIso: string,
): Promise<void> {
  const today = householdToday(nowIso, timezone);
  const dayStart = Temporal.PlainDate.from(today).toZonedDateTime(timezone).toInstant().toString();
  const queued = await repo.queuedToday(tx, householdId, dayStart);
  if (queued <= REVIEW_NOTIFICATIONS_PER_DAY) {
    await insertNotification(tx, {
      householdId,
      userId,
      kind: "review",
      dedupeKey: `review:item:${extractedItemId}`,
      title: "Something new to review",
      body: "MoneyPilot found an update in your email and did not apply it. Look it over in Email & imports.",
      deepLink: "/imports",
    });
  } else {
    await insertNotification(tx, {
      householdId,
      userId,
      kind: "review",
      dedupeKey: `review:digest:${userId}:${today}`,
      title: "Several things to review",
      body: "MoneyPilot found several updates in your email today. Look them over in Email & imports.",
      deepLink: "/imports",
    });
  }
}
