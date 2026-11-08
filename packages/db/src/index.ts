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
  loadEngineInput,
  MAX_PLAN_OFFSET_DAYS,
  PlanDateRangeError,
  withinPlanRange,
  type LoadedPlanInput,
  type LoadOptions,
  type PlanNotReadyReason,
} from "./planning/engine-input";
export { loadBillsAverages } from "./planning/averages";
export {
  canonicalJson,
  inputsHash,
  recomputePlan,
  storeSnapshot,
  type RecomputeResult,
} from "./planning/snapshot";
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
export { NOTIFICATION_KINDS, type NotificationKind } from "./schema/notify";
export {
  insertNotification,
  notifyInviteAccepted,
  type InviteAcceptedNotice,
  type NewNotification,
} from "./notify/insert";
export { expireProposals } from "./proposals/expire";
export { autoCompleteTasks, type AutoCompleteEvent, type AutoCompleted } from "./tasks/auto-complete";
export {
  applyBillingEvents,
  type BillingStatus,
  type BillingSyncDeps,
  type BillingSyncResult,
  type StoredSubscription,
} from "./billing/sync";
export { IMPORT_ERRORS, IMPORT_STATUSES } from "./schema/imports";
