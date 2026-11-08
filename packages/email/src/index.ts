// Gmail/Graph/forwarding adapters, MIME to text, prefilter, redaction, matcher. Core built in WP-19.
// Raw (unredacted) text helpers are intentionally not exported: prepareEmail is the only way from message
// bytes to text, and it always redacts.
export const PACKAGE = "@mp/email";
export * from "./match/index.js";
export * from "./mime/index.js";
export * from "./pdf/index.js";
export * from "./prefilter/index.js";
export * from "./providers/index.js";
export * from "./redact/index.js";
