import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../../..");
export const MIGRATIONS_DIR = resolve(here, "../../migrations");
export const FIXTURE_PATH = resolve(REPO_ROOT, "design/fixtures/rivera-household.json");
