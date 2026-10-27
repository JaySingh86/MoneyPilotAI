// Deliberate violation: adapters never import each other.
import { table } from "../../db/index";

export const leaked = table;
