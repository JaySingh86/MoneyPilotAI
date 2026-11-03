// @mp/db: Drizzle schema, SQL migrations, RLS-scoped transactions, seed loader (WP-03).
export * from "./schema";
export {
  assertConnectionRole,
  createApiDb,
  createWorkerDb,
  DbContextError,
  type ApiContext,
  type AppRole,
  type ApiDb,
  type DbOptions,
  type DbSchema,
  type Tx,
  type WorkerDb,
} from "./tx";
export {
  assertMigratorRole,
  findTransactionControl,
  loadMigrations,
  MigrationError,
  parseMigrationName,
  runMigrations,
} from "./migrate";
export {
  extendOccurrences,
  householdToday,
  materializeForJob,
  materializeHousehold,
  MATERIALIZE_FUTURE_DAYS,
  MATERIALIZE_PAST_DAYS,
  planOccurrences,
  rebuildFutureOccurrences,
  type MaterializeResult,
  type PlannedOccurrence,
  type ScheduledItem,
} from "./items/materialize";
