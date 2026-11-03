// Deliberate violations: review-rules must not do I/O or import another internal package.
import { readFileSync } from "node:fs";
import { table } from "../db/index";

export const impure = () => readFileSync(table);
