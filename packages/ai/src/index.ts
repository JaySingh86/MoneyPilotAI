// @mp/ai: Claude client, versioned prompts, schemas and evals (WP-11).
// Per ARCHITECTURE §3, apps/api may import only the explain/ask modules; extraction is worker-only.
export const PACKAGE = "@mp/ai";

export { AiClient, AiCallError } from "./client";
export type { AiClientOptions, AiPurpose, AiRunRecord, AiRunStatus, Completion } from "./client";
export { DEFAULT_MODEL, INFERENCE_GEO, ROUTES } from "./config";
export type { AiRoute, Effort, RouteConfig } from "./config";
export { costMicros } from "./pricing";
export type { TokenUsage } from "./pricing";
export { loadPrompt } from "./prompts";
export { createAnthropicClient, createSdkTransport } from "./sdk-transport";
export type { ModelRequest, ModelResponse, ModelTransport } from "./transport";

export {
  EXTRACT_PROMPT_ID,
  ExtractInputError,
  MAX_EMAIL_CHARS,
  buildExtractRequest,
  collectExtractionBatch,
  extractEmail,
  submitExtractionBatch,
  waitForBatch,
} from "./extract/extract";
export type { BatchItem, BatchItemOutcome, ExtractInput, ExtractOutcome } from "./extract/extract";
export { validateExtraction } from "./extract/validate";
export type { ValidationFailure, ValidationResult, ValidationRule } from "./extract/validate";
export { extractionJsonSchema, extractionSchema } from "./schemas/extraction.v1";
export type { ExtractionResult } from "./schemas/extraction.v1";
