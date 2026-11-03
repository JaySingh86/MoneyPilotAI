// pnpm db:seed — loads design/fixtures/rivera-household.json through the app roles
// (DATABASE_URL = mp_api, WORKER_DATABASE_URL = mp_worker). Idempotent.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertLocalSeedTarget } from "../seed/guard";
import { seedPlanning } from "../seed/items";
import { seedFixture } from "../seed/rivera";
import { createApiDb, createWorkerDb } from "../tx";
import { fail, REPO_ROOT, requireEnv, say } from "./env";

try {
  const fixture: unknown = JSON.parse(
    await readFile(resolve(REPO_ROOT, "design/fixtures/rivera-household.json"), "utf8"),
  );
  const apiUrl = requireEnv("DATABASE_URL");
  const workerUrl = requireEnv("WORKER_DATABASE_URL");
  // Made-up users and money rows: local development databases only (G1 L-5).
  assertLocalSeedTarget(process.env, [apiUrl, workerUrl]);
  const api = createApiDb({ connectionString: apiUrl, max: 2 });
  const worker = createWorkerDb({ connectionString: workerUrl, max: 2 });
  try {
    const result = await seedFixture({ api, worker }, fixture);
    say(
      result.created
        ? "seeded the Rivera household (2 members)"
        : "Rivera household already seeded; ensured members and plan",
    );
    const planning = await seedPlanning({ api, worker }, result, fixture);
    say(
      planning.created
        ? `seeded ${planning.items} items, goals, planned expenses, a balance and ${planning.occurrences} occurrences`
        : "Rivera items already seeded",
    );
  } finally {
    await api.close();
    await worker.close();
  }
} catch (error) {
  fail(error);
}
