// pnpm db:seed — loads design/fixtures/rivera-household.json through the app roles
// (DATABASE_URL = mp_api, WORKER_DATABASE_URL = mp_worker). Idempotent.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { seedFixture } from "../seed/rivera";
import { createApiDb, createWorkerDb } from "../tx";
import { fail, REPO_ROOT, requireEnv, say } from "./env";

try {
  const fixture: unknown = JSON.parse(
    await readFile(resolve(REPO_ROOT, "design/fixtures/rivera-household.json"), "utf8"),
  );
  const api = createApiDb({ connectionString: requireEnv("DATABASE_URL"), max: 2 });
  const worker = createWorkerDb({ connectionString: requireEnv("WORKER_DATABASE_URL"), max: 2 });
  try {
    const result = await seedFixture({ api, worker }, fixture);
    say(
      result.created
        ? "seeded the Rivera household (2 members)"
        : "Rivera household already seeded; ensured members and plan",
    );
  } finally {
    await api.close();
    await worker.close();
  }
} catch (error) {
  fail(error);
}
