// `@mp/ai/extract`: the extraction route (worker-only, ARCHITECTURE §3). The root barrel still re-exports these
// so existing imports keep working; once Explain and Ask land, apps/api should import only their own modules
// and the root barrel can drop this export.
export {
  EXTRACT_PROMPT_ID,
  ExtractInputError,
  MAX_EMAIL_CHARS,
  buildExtractRequest,
  collectExtractionBatch,
  extractEmail,
  neutralizeEmailDelimiters,
  submitExtractionBatch,
  waitForBatch,
} from "./extract";
export type { BatchItem, BatchItemOutcome, ExtractInput, ExtractOutcome } from "./extract";
export { validateExtraction } from "./validate";
export type { ValidationFailure, ValidationResult, ValidationRule } from "./validate";
export { extractionJsonSchema, extractionSchema } from "../schemas/extraction.v1";
export type { ExtractionResult } from "../schemas/extraction.v1";
