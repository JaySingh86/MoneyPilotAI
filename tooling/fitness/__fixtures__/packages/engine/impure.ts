// Deliberate violations: the engine must not do I/O or import other internal packages.
import { readFileSync } from "node:fs";
import { table } from "../db/index";

export const impure = () => readFileSync(table);
