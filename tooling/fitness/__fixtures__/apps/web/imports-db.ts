// Deliberate violation: apps/web must never import packages/db.
import { table } from "../../packages/db/index";

export const leaked = table;
