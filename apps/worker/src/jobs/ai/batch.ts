// Jobs `ai.batch.submit` and `ai.batch.collect` (BACKEND_PLAN §7.9, §9): the first 13-month backfill goes through the
// Message Batches API (half price, results within hours) instead of one call per message. New mail does not come
// through here (email.process makes a direct call).
//
//   submit   for one connection, takes up to BATCH_SIZE backfill messages nobody has processed, reads each one
//            (fetch, sandboxed parse, redaction), submits ONE batch whose `custom_id` is the message row id, and records
//            the batch id on the messages. The text is NOT kept: it goes to the API and is dropped.
//   collect  once the batch has ended, reads each message AGAIN (a body is never stored, rule 7; redaction and parsing
//            are deterministic, so the evidence quotes still match), reads the results keyed by `custom_id`, and runs
//            every one through the same finish step as a direct call. A refused item or a batch error is re-run
//            through a direct call (the Batches API has no refusal fallbacks, Q-076). Results for ids that are not ours
//            are ignored by the `@mp/ai` helper.
//
// Idempotent: a message that already left `discovered` is skipped on a repeat. The messages are RESERVED before the batch
// is submitted and the reservation is swapped for the real batch id afterwards, so a failure to record the id cannot
// make every sweep submit the same messages again; a reservation left by a crash goes back to waiting after 30 minutes.
// Cost caps (security review B1): the daily budget, the new-sender sub-cap and the backfill total apply here too.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AiCallError, type AiClient } from "@mp/ai";
import {
  ExtractInputError,
  buildExtractRequest,
  collectExtractionBatch,
  extractEmail,
  submitExtractionBatch,
  type BatchItem,
} from "@mp/ai/extract";
import { ProviderError, type MailProvider } from "@mp/email/providers";
import {
  accessFor,
  failOrRethrow,
  loadConnection,
  providerFor,
  type Connection,
  type EmailJobDeps,
} from "../email/discover/connection";
import {
  failMessage,
  finishExtracted,
  isIgnoredSender,
  type FinishDeps,
  type FinishOutcome,
} from "../email/process/finish";
import type { PreparedSummary } from "../email/process/analyze";
import { clearsNewSenderBar, isNewSender, loadGate, peek, take, type Gate } from "../email/process/gate";
import { DEFAULT_LIMITS, markCharged, type ExtractLimits } from "../email/process/limits";
import { readMessage } from "../email/process/read";
import * as repo from "../email/process/repo";

export const AI_BATCH_SUBMIT_QUEUE = "ai.batch.submit";
export const AI_BATCH_COLLECT_QUEUE = "ai.batch.collect";
export const AiBatchSubmitJob = z.object({ householdId: z.uuid(), connectionId: z.uuid() });
export const AiBatchCollectJob = z.object({ householdId: z.uuid(), batchId: z.string().min(1).max(100) });
export type AiBatchSubmitJob = z.infer<typeof AiBatchSubmitJob>;
export type AiBatchCollectJob = z.infer<typeof AiBatchCollectJob>;
/** Per batch: collect polls until `ended` (the sweep re-queues it), so retries only cover real failures. */
export const AI_BATCH_QUEUE_OPTIONS = {
  policy: "short",
  retryLimit: 5,
  retryDelay: 60,
  retryBackoff: true,
} as const;
export const aiBatchSubmitSingletonKey = (j: AiBatchSubmitJob) =>
  `${AI_BATCH_SUBMIT_QUEUE}:${j.connectionId}`;
export const aiBatchCollectSingletonKey = (j: AiBatchCollectJob) => `${AI_BATCH_COLLECT_QUEUE}:${j.batchId}`;

/** Messages per batch. A longer backfill is continued by the next sweep. */
export const BATCH_SIZE = 200;

export interface BatchDeps extends EmailJobDeps, Pick<FinishDeps, "sender"> {
  ai: AiClient;
  /** Cost caps (B1). Default: the documented defaults. */
  limits?: ExtractLimits;
}

/** A message read and ready to go to the model, with the signals that outlive its text. */
interface ReadyItem {
  item: BatchItem;
  prepared: PreparedSummary;
  /** Was its sender new to the household when it was charged? */
  newSender: boolean;
}

/**
 * Reads messages for a batch. Unreadable ones leave `discovered` right away; the rest come back as ready items. An item
 * that would break the model input contract (text that still looks unredacted) fails alone, before it can sink a batch.
 *
 * With a `gate` (a submit) every message is checked against today's budget, the new-sender sub-cap and the stricter bar
 * for never-seen senders, before and after the read, exactly as the direct path does; a message over a cap is simply left
 * waiting (counted in `deferred`). Without one (a collect: the batch was charged when it was submitted) nothing is checked.
 */
async function readAll(
  deps: BatchDeps,
  conn: Connection,
  provider: MailProvider,
  accessToken: string,
  timezone: string,
  ignored: readonly string[],
  messages: readonly repo.PendingMessage[],
  gate: Gate | null,
): Promise<{ ready: ReadyItem[]; deferred: number }> {
  const ready: ReadyItem[] = [];
  let deferred = 0;
  for (const [index, message] of messages.entries()) {
    if (isIgnoredSender(message.fromDomain, ignored)) {
      await failMessage(deps, conn.householdId, message.id, "prefiltered_out");
      continue;
    }
    let newSender = false;
    if (gate) {
      newSender = await isNewSender(deps.db, conn.householdId, gate, message.fromDomain);
      const verdict = peek(gate, newSender);
      if (verdict === "daily_cap") {
        deferred += messages.length - index;
        break;
      }
      if (verdict === "new_sender_cap") {
        deferred++;
        continue;
      }
    }
    const read = await readMessage(provider, accessToken, message, timezone);
    if (read.kind === "gone") {
      await failMessage(deps, conn.householdId, message.id, "failed");
      continue;
    }
    if (read.kind === "unreadable") {
      await failMessage(
        deps,
        conn.householdId,
        message.id,
        read.reason === "empty" ? "irrelevant" : "failed",
      );
      continue;
    }
    if (gate && newSender && !clearsNewSenderBar(read.prepared.subject, message.fromDomain, gate.limits)) {
      await failMessage(deps, conn.householdId, message.id, "prefiltered_out");
      continue;
    }
    const item: BatchItem = {
      messageId: message.id,
      text: read.text,
      receivedAt: read.receivedAt,
      truncated: read.prepared.truncated,
      householdId: conn.householdId,
    };
    try {
      buildExtractRequest(item);
    } catch (err) {
      if (!(err instanceof ExtractInputError)) throw err;
      await failMessage(deps, conn.householdId, message.id, "failed");
      continue;
    }
    if (gate) take(gate, newSender);
    ready.push({ item, prepared: read.prepared, newSender });
  }
  return { ready, deferred };
}

export type SubmitOutcome =
  | {
      outcome: "skipped";
      reason: "not_active" | "no_provider" | "no_token" | "gone" | "no_household" | "nothing";
    }
  | { outcome: "auth_failed" | "provider_failed" }
  | { outcome: "submitted"; batchId: string; messages: number; deferred: number };

export async function handleAiBatchSubmit(
  deps: BatchDeps,
  data: unknown,
  opts: { lastAttempt?: boolean } = {},
): Promise<SubmitOutcome> {
  const job = AiBatchSubmitJob.parse(data);
  const { householdId } = job;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const nowIso = deps.now();
  const prep = await deps.db.withJobTx(householdId, async (tx) => {
    const conn = await loadConnection(tx, householdId, job.connectionId);
    if (!conn) return null;
    const facts = await repo.householdFacts(tx, householdId);
    // A crash between reserving and recording a batch id leaves a reservation: after a while it goes back to waiting.
    await repo.releaseStaleReservations(tx, householdId, nowIso);
    let skippedOverCap = 0;
    let room = BATCH_SIZE;
    if (conn.status === "active") {
      // The whole backfill is capped per connection (B1): what is over the cap is not extracted.
      const sent = await repo.backfillSent(tx, householdId, conn.id);
      room = Math.min(BATCH_SIZE, Math.max(0, limits.backfillMax - sent));
      if (room === 0) skippedOverCap = await repo.skipRestOfBackfill(tx, householdId, conn.id, nowIso);
    }
    return {
      conn,
      facts,
      gate: facts ? await loadGate(tx, householdId, facts.timezone, nowIso, limits) : null,
      ignored: await repo.ignoredDomains(tx, householdId),
      skippedOverCap,
      messages:
        conn.status === "active" && room > 0
          ? await repo.listPending(tx, householdId, conn.id, "backfill", room, true)
          : [],
    };
  });
  if (!prep) return { outcome: "skipped", reason: "gone" };
  const { conn, facts, gate, ignored, messages } = prep;
  if (prep.skippedOverCap > 0) {
    deps.log.info(
      { skipped: prep.skippedOverCap },
      "backfill cap reached: the rest of the mailbox is not extracted",
    );
  }
  if (conn.status !== "active") return { outcome: "skipped", reason: "not_active" };
  if (!facts || !gate) return { outcome: "skipped", reason: "no_household" };
  const provider = providerFor(deps, conn);
  if (!provider) return { outcome: "skipped", reason: "no_provider" };
  if (!conn.sealed) return { outcome: "skipped", reason: "no_token" };
  if (messages.length === 0) return { outcome: "skipped", reason: "nothing" };

  // The reservation is written BEFORE the batch is submitted and swapped for the real id after: a failure to record the
  // id can then never make every sweep submit the same messages again (B1).
  const token = `${repo.RESERVATION_PREFIX}${randomUUID()}`;
  let reserved = false;
  let submitted = false;
  try {
    const { accessToken } = await accessFor(deps, conn, provider);
    const { ready, deferred } = await readAll(
      deps,
      conn,
      provider,
      accessToken,
      facts.timezone,
      ignored,
      messages,
      gate,
    );
    if (ready.length === 0) {
      if (deferred > 0)
        deps.log.info({ deferred }, "email messages left waiting: an extraction cap was reached");
      return { outcome: "skipped", reason: "nothing" };
    }
    await deps.db.withJobTx(householdId, async (tx) => {
      await repo.reserveForBatch(
        tx,
        householdId,
        ready.map((r) => r.item.messageId),
        token,
      );
      for (const r of ready) await markCharged(tx, householdId, r.item.messageId, r.newSender, nowIso);
    });
    reserved = true;
    const batch = await submitExtractionBatch(
      deps.ai,
      ready.map((r) => r.item),
    );
    // From here the batch exists at the provider: whatever happens next, the messages must never be submitted again.
    submitted = true;
    await deps.db.withJobTx(householdId, (tx) => repo.confirmBatch(tx, householdId, token, batch.id));
    if (deferred > 0)
      deps.log.info({ deferred }, "email messages left waiting: an extraction cap was reached");
    return { outcome: "submitted", batchId: batch.id, messages: ready.length, deferred };
  } catch (err) {
    if (reserved && !submitted) {
      // Submitting failed: give the messages back. (If recording the id failed after a good submit, the reservation
      // stays until it goes stale, so it is submitted at most once per half hour, not every minute.)
      await deps.db
        .withJobTx(householdId, (tx) => repo.releaseBatch(tx, householdId, token))
        .catch(() => undefined);
    }
    if (opts.lastAttempt && !submitted && !(err instanceof ProviderError)) {
      // Nothing was submitted: these messages would be picked up again by every sweep. They fail instead.
      deps.log.error({ queue: AI_BATCH_SUBMIT_QUEUE }, "a batch could not be submitted on its last attempt");
      for (const m of messages) await failMessage(deps, householdId, m.id, "failed");
    }
    return batchFailure(deps, conn, err);
  }
}

export type CollectOutcome =
  | { outcome: "skipped"; reason: "no_messages" | "not_active" | "no_provider" | "no_token" | "no_household" }
  | { outcome: "pending" }
  | { outcome: "auth_failed" | "provider_failed" }
  | { outcome: "done"; counts: Partial<Record<FinishOutcome, number>> };

export async function handleAiBatchCollect(
  deps: BatchDeps,
  data: unknown,
  opts: { lastAttempt?: boolean } = {},
): Promise<CollectOutcome> {
  const job = AiBatchCollectJob.parse(data);
  const { householdId, batchId } = job;
  const prep = await deps.db.withJobTx(householdId, async (tx) => {
    const messages = await repo.listInBatch(tx, householdId, batchId);
    const connectionId = messages[0]?.connectionId ?? null;
    return {
      messages,
      conn: connectionId ? await loadConnection(tx, householdId, connectionId) : null,
      facts: await repo.householdFacts(tx, householdId),
      ignored: await repo.ignoredDomains(tx, householdId),
    };
  });
  const { messages, conn, facts, ignored } = prep;
  if (messages.length === 0) return { outcome: "skipped", reason: "no_messages" };
  if (!conn || conn.status === "revoked") {
    // Disconnected (or removed): nothing will ever collect this batch, so its messages fail instead of looping (N3).
    await deps.db.withJobTx(householdId, (tx) => repo.failBatch(tx, householdId, batchId, deps.now()));
    return { outcome: "skipped", reason: "not_active" };
  }
  if (conn.status !== "active") return { outcome: "skipped", reason: "not_active" }; // paused: resumes where it was
  if (!facts) return { outcome: "skipped", reason: "no_household" };
  const provider = providerFor(deps, conn);
  if (!provider) return { outcome: "skipped", reason: "no_provider" };
  if (!conn.sealed) return { outcome: "skipped", reason: "no_token" };

  // Cheap check first: no mailbox read until the batch has ended.
  if ((await deps.ai.batchStatus(batchId)) !== "ended") return { outcome: "pending" };
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const fallbackGate = await deps.db.withJobTx(householdId, (tx) =>
    loadGate(tx, householdId, facts.timezone, deps.now(), limits, batchId),
  );

  const counts: Partial<Record<FinishOutcome, number>> = {};
  const count = (o: FinishOutcome) => void (counts[o] = (counts[o] ?? 0) + 1);
  try {
    const { accessToken } = await accessFor(deps, conn, provider);
    // No gate here: the batch was charged when it was submitted.
    const { ready } = await readAll(
      deps,
      conn,
      provider,
      accessToken,
      facts.timezone,
      ignored,
      messages,
      null,
    );
    if (ready.length === 0) return { outcome: "done", counts };
    const results = await collectExtractionBatch(
      deps.ai,
      batchId,
      ready.map((r) => r.item),
      { householdId },
    );
    for (const { item, prepared } of ready) {
      let outcome = results.get(item.messageId) ?? { status: "batch_error" as const, detail: "missing" };
      if (outcome.status === "refusal" || outcome.status === "batch_error") {
        // No fallbacks in the Batches API: one direct call, which has them (Q-076). It is a real call, so it is
        // charged; over the daily cap the message goes back to waiting (and is submitted again tomorrow).
        if (take(fallbackGate, false) !== "ok") {
          // A message released once already (refused or errored in a batch again) fails instead of cycling forever.
          const releases = messages.find((m) => m.id === item.messageId)?.releases ?? 0;
          if (releases >= 1) {
            count(await failMessage(deps, householdId, item.messageId, "failed"));
          } else {
            await deps.db.withJobTx(householdId, (tx) =>
              repo.releaseMessage(tx, householdId, item.messageId),
            );
          }
          continue;
        }
        try {
          outcome = await extractEmail(deps.ai, { ...item, reference: item.messageId });
        } catch (err) {
          if (err instanceof AiCallError && err.kind === "client_error") {
            count(await failMessage(deps, householdId, item.messageId, "failed"));
            continue;
          }
          throw err;
        }
      }
      count(
        await finishExtracted(deps, {
          householdId,
          messageId: item.messageId,
          notifyUserId: conn.userId,
          prepared,
          outcome,
        }),
      );
    }
    return { outcome: "done", counts };
  } catch (err) {
    if (opts.lastAttempt && !(err instanceof ProviderError)) {
      deps.log.error({ queue: AI_BATCH_COLLECT_QUEUE }, "a batch could not be collected on its last attempt");
      for (const m of messages) await failMessage(deps, householdId, m.id, "failed");
    }
    return batchFailure(deps, conn, err);
  }
}

async function batchFailure(
  deps: EmailJobDeps,
  conn: Connection,
  err: unknown,
): Promise<{ outcome: "auth_failed" | "provider_failed" }> {
  // Provider trouble that retrying will not fix marks the connection; anything else (rate limits, outages, a model API
  // error) is rethrown for pg-boss to retry with backoff.
  if (err instanceof ProviderError) return { outcome: await failOrRethrow(deps, conn, err) };
  throw err;
}
