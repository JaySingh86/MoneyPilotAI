// Job `email.process` (BACKEND_PLAN §7.8.2, §9): the direct path for NEW mail. For one connection it takes the messages
// discovery found and nobody processed, and for each one: skips ignored senders, fetches the raw message through the
// worker-only provider path, turns it into redacted text (parsing sandbox), makes ONE structured extraction call (no
// tools), then validates, matches, decides and writes (finish.ts). The first 13-month backfill does not come through
// here: it goes through the Batch API (jobs/ai/batch.ts, §7.9).
//
// Singleton per CONNECTION, not per message (a deviation from §9's "key = message id", Q-230): a Microsoft refresh
// rotates the refresh token, so concurrent per-message jobs for one mailbox would race for it. Inside the job messages
// run one after another on one access token; a message already processed is skipped (row lock + stage), so a retried or
// repeated job is harmless. Bounded per run; the minute sweep queues the next run.
//
// Hard rules: the body lives only in memory for the span of one message (rule 7); logs carry counts and fixed outcome
// labels, never an address, a subject, a name or an amount (rule 8); email text reaches only the tool-free extraction
// call (rule 9).
import { z } from "zod";
import { AiCallError, type AiClient } from "@mp/ai";
import { ExtractInputError, extractEmail } from "@mp/ai/extract";
import { ProviderError } from "@mp/email/providers";
import {
  accessFor,
  failOrRethrow,
  loadConnection,
  providerFor,
  type Connection,
  type EmailJobDeps,
} from "../discover/connection";
import { failMessage, finishExtracted, isIgnoredSender, type FinishDeps, type FinishOutcome } from "./finish";
import { charge, clearsNewSenderBar, isNewSender, loadGate, peek, take } from "./gate";
import { DEFAULT_LIMITS, type ExtractLimits } from "./limits";
import { readMessage } from "./read";
import * as repo from "./repo";

export const EMAIL_PROCESS_QUEUE = "email.process";
export const EmailProcessJob = z.object({ householdId: z.uuid(), connectionId: z.uuid() });
export type EmailProcessJob = z.infer<typeof EmailProcessJob>;
/** BACKEND_PLAN §9: 5 attempts, then `failed`. `short` keeps one queued job per connection. */
export const EMAIL_PROCESS_QUEUE_OPTIONS = {
  policy: "short",
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
} as const;
export const emailProcessSingletonKey = (j: EmailProcessJob) => `${EMAIL_PROCESS_QUEUE}:${j.connectionId}`;

/** Messages per run. The next minute's sweep continues with the rest. */
export const PROCESS_MESSAGES_PER_RUN = 25;

export interface ProcessDeps extends EmailJobDeps, Pick<FinishDeps, "sender"> {
  ai: AiClient;
  /** Cost caps (B1). Default: the documented defaults. */
  limits?: ExtractLimits;
}

export type ProcessOutcome =
  | { outcome: "skipped"; reason: "not_active" | "no_provider" | "no_token" | "gone" | "no_household" }
  | { outcome: "auth_failed" | "provider_failed" }
  | {
      outcome: "done";
      counts: Partial<Record<FinishOutcome, number>>;
      /** Messages left waiting because a cap was reached (a count only). */
      deferred?: number;
    };

export async function handleEmailProcess(
  deps: ProcessDeps,
  data: unknown,
  opts: { lastAttempt?: boolean } = {},
): Promise<ProcessOutcome> {
  const job = EmailProcessJob.parse(data);
  const { householdId } = job;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const nowIso = deps.now();
  const prep = await deps.db.withJobTx(householdId, async (tx) => {
    const conn = await loadConnection(tx, householdId, job.connectionId);
    if (!conn) return null;
    const facts = await repo.householdFacts(tx, householdId);
    return {
      conn,
      facts,
      gate: facts ? await loadGate(tx, householdId, facts.timezone, nowIso, limits) : null,
      ignored: await repo.ignoredDomains(tx, householdId),
      messages:
        conn.status === "active"
          ? await repo.listPending(tx, householdId, conn.id, "discover", PROCESS_MESSAGES_PER_RUN)
          : [],
    };
  });
  if (!prep) return { outcome: "skipped", reason: "gone" };
  const { conn, facts, gate, ignored, messages } = prep;
  if (conn.status !== "active") return { outcome: "skipped", reason: "not_active" };
  if (!facts || !gate) return { outcome: "skipped", reason: "no_household" };
  const provider = providerFor(deps, conn);
  if (!provider) return { outcome: "skipped", reason: "no_provider" };
  if (!conn.sealed) return { outcome: "skipped", reason: "no_token" };
  const counts: Partial<Record<FinishOutcome, number>> = {};
  const count = (o: FinishOutcome) => void (counts[o] = (counts[o] ?? 0) + 1);
  if (messages.length === 0) return { outcome: "done", counts };

  // The message in flight, so that after the last retry it fails ("5x, then failed", BACKEND_PLAN §9) instead of being
  // picked up again by every sweep, one model call at a time, forever.
  let current: string | null = null;
  let deferred = 0;
  try {
    const { accessToken } = await accessFor(deps, conn, provider);
    for (const [index, message] of messages.entries()) {
      current = message.id;
      if (isIgnoredSender(message.fromDomain, ignored)) {
        count(await failMessage(deps, householdId, message.id, "prefiltered_out"));
        continue;
      }
      // B1: the cheap checks come first, so a capped message costs no provider read.
      const isNew = await isNewSender(deps.db, householdId, gate, message.fromDomain);
      const verdict = peek(gate, isNew);
      if (verdict === "daily_cap") {
        deferred += messages.length - index; // today's budget is spent: the rest waits for tomorrow
        break;
      }
      if (verdict === "new_sender_cap") {
        deferred++;
        continue;
      }
      const read = await readMessage(provider, accessToken, message, facts.timezone);
      if (read.kind === "gone") {
        count(await failMessage(deps, householdId, message.id, "failed"));
        continue;
      }
      if (read.kind === "unreadable") {
        // Nothing in it ("empty") is not a failure; a message over a parsing limit goes nowhere (Q-067).
        count(
          await failMessage(deps, householdId, message.id, read.reason === "empty" ? "irrelevant" : "failed"),
        );
        continue;
      }
      // A never-seen sender must clear a stricter keyword bar before it costs a model call.
      if (isNew && !clearsNewSenderBar(read.prepared.subject, message.fromDomain, limits)) {
        count(await failMessage(deps, householdId, message.id, "prefiltered_out"));
        continue;
      }
      take(gate, isNew);
      await charge(deps.db, householdId, message.id, isNew, nowIso);
      let outcome;
      try {
        outcome = await extractEmail(deps.ai, {
          text: read.text,
          receivedAt: read.receivedAt,
          truncated: read.prepared.truncated,
          householdId,
          reference: message.id,
        });
      } catch (err) {
        // A message that breaks the input contract (text that still looks unredacted) is never sent: it fails alone.
        if (err instanceof ExtractInputError) {
          count(await failMessage(deps, householdId, message.id, "failed"));
          continue;
        }
        // A 4xx from the model API will not get better by retrying this message: fail it, keep going.
        if (err instanceof AiCallError && err.kind === "client_error") {
          deps.log.error({ kind: err.kind, status: err.status }, "the model API refused a message");
          count(await failMessage(deps, householdId, message.id, "failed"));
          continue;
        }
        throw err; // rate limits, outages and anything unexpected: the job retries; finished messages stay finished
      }
      count(
        await finishExtracted(deps, {
          householdId,
          messageId: message.id,
          notifyUserId: conn.userId,
          prepared: read.prepared,
          outcome,
        }),
      );
    }
    if (deferred > 0)
      deps.log.info({ deferred }, "email messages left waiting: an extraction cap was reached");
    return { outcome: "done", counts, deferred };
  } catch (err) {
    if (opts.lastAttempt && current !== null && !(err instanceof ProviderError)) {
      deps.log.error({ queue: EMAIL_PROCESS_QUEUE }, "a message failed on its last attempt");
      await failMessage(deps, householdId, current, "failed");
    }
    return processFailure(deps, conn, err);
  }
}

/** Provider trouble that retrying will not fix marks the connection; everything else is rethrown for pg-boss. */
async function processFailure(
  deps: EmailJobDeps,
  conn: Connection,
  err: unknown,
): Promise<{ outcome: "auth_failed" | "provider_failed" }> {
  if (err instanceof ProviderError) return { outcome: await failOrRethrow(deps, conn, err) };
  throw err;
}
