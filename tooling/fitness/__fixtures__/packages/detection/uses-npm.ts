// Deliberate violation: detection may only use its allowlisted npm packages in production code.
import ts from "typescript";

export const version = ts.version;
