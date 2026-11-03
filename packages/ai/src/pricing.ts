import { BATCH_DISCOUNT, PRICING } from "./config";

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** Integer micro-dollars for one call. An unknown model costs 0 (unmetered). */
export function costMicros(model: string, usage: TokenUsage, batch: boolean): number {
  const p = PRICING[model];
  if (!p) return 0;
  const raw =
    (usage.inputTokens * p.inputMicrosPerMTok +
      usage.outputTokens * p.outputMicrosPerMTok +
      usage.cacheReadTokens * p.cacheReadMicrosPerMTok +
      usage.cacheWriteTokens * p.cacheWriteMicrosPerMTok) /
    1_000_000;
  return Math.round(batch ? raw * BATCH_DISCOUNT : raw);
}

/**
 * Cost for the metering record. It is an estimate (Q-071): when the response's model is not in the price table
 * it prices by the requested model, then by the highest known rate, so a real call is never recorded as free.
 */
export function priceModel(
  responseModel: string,
  usage: TokenUsage,
  batch: boolean,
  requestedModel: string,
): { micros: number; estimated: boolean } {
  if (PRICING[responseModel]) return { micros: costMicros(responseModel, usage, batch), estimated: false };
  if (PRICING[requestedModel]) return { micros: costMicros(requestedModel, usage, batch), estimated: true };
  const highest = Object.keys(PRICING).reduce((best, id) =>
    (PRICING[id]?.outputMicrosPerMTok ?? 0) > (PRICING[best]?.outputMicrosPerMTok ?? 0) ? id : best,
  );
  return { micros: costMicros(highest, usage, batch), estimated: true };
}
