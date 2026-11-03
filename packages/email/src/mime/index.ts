// Public surface of the MIME module. `prepareEmail` is the ONLY way from message bytes to text: it parses in
// an isolated Worker and always redacts. The in-process variant, htmlToText and the sanitizers return
// unredacted text or skip the sandbox, so they are deliberately not exported; import them by path from
// tests in this package only.
export { prepareEmail, SANDBOX_DEFAULTS } from "./sandbox.js";
export type { PrepareEmailOptions, SandboxOptions } from "./sandbox.js";
export { EMAIL_LIMITS } from "./prepare.js";
export type {
  PrepareFailure,
  PrepareLimits,
  PrepareNote,
  PrepareOptions,
  PrepareResult,
  PreparedEmail,
} from "./prepare.js";
export { MAX_MIME_PARTS } from "./mime-parts.js";
export type { AuthenticationVerdicts, Verdict } from "./auth.js";
