// Model, effort and pricing per route (ADR-010, BACKEND_PLAN §7.9). Model IDs live here and nowhere else.
// Changing a route's model is an owner decision made after the eval gates pass.

export const DEFAULT_MODEL = "claude-opus-5-5";

export type AiRoute = "extract" | "explain" | "ask";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RouteConfig {
  readonly model: string;
  /** Opus 5.5 cannot disable thinking, so effort is the only depth control. No temperature is ever sent. */
  readonly effort: Effort;
  readonly maxTokens: number;
  /** Current prompt version: the file is packages/ai/prompts/<route>.v<N>.md. */
  readonly promptVersion: number;
}

export const ROUTES: Readonly<Record<AiRoute, RouteConfig>> = {
  extract: { model: DEFAULT_MODEL, effort: "low", maxTokens: 4096, promptVersion: 1 },
  explain: { model: DEFAULT_MODEL, effort: "low", maxTokens: 1024, promptVersion: 1 },
  ask: { model: DEFAULT_MODEL, effort: "medium", maxTokens: 4096, promptVersion: 1 },
};

/** Data residency for every request (CLAUDE.md "AI in product code"). */
export const INFERENCE_GEO = "us";

/** Refusal fallbacks: `fallbacks: "default"` under this beta header (BACKEND_PLAN §7.9). */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Retry policy for RateLimitError, 5xx and connection errors. Other 4xx fail immediately. */
/** Per-request timeouts in milliseconds (SDK `timeout` option). A timeout surfaces as a connection error and is retried. */
export const TIMEOUT_MS = { send: 120_000, batch: 60_000 } as const;

export const RETRY = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 20_000 } as const;

/**
 * PLACEHOLDER price table in integer micro-dollars per million tokens, used for `ai_runs.cost_micros` and the
 * eval budget cap. `cost_micros` is an estimate. The owner checks these against Anthropic's published pricing
 * before G3 (Q-071).
 */
export interface Pricing {
  readonly inputMicrosPerMTok: number;
  readonly outputMicrosPerMTok: number;
  readonly cacheReadMicrosPerMTok: number;
  readonly cacheWriteMicrosPerMTok: number;
}

export const PRICING: Readonly<Record<string, Pricing>> = {
  "claude-opus-5-5": {
    inputMicrosPerMTok: 4_000_000,
    outputMicrosPerMTok: 20_000_000,
    cacheReadMicrosPerMTok: 200_000,
    cacheWriteMicrosPerMTok: 5_000_000,
  },
};

/** The Message Batches API bills at half price. */
export const BATCH_DISCOUNT = 0.5;
