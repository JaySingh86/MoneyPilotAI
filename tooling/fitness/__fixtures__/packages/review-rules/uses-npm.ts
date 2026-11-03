// Deliberate violation: review-rules may not use npm packages in production code.
import ts from "typescript";

export const version = ts.version;
