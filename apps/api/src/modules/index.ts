// API module registry (ARCHITECTURE §3.1). APPEND-ONLY: a work package adds one import at the end of the
// imports and one entry at the end of the array; never reorder or remove entries, so parallel merges do
// not conflict. Each module lives in `./<name>/` (routes.ts, service.ts, repo.ts, schemas.ts) and exports
// `defineModule({ name, routes })`; follow the route recipe in `../lib/module.ts`. After adding routes,
// run `pnpm contracts:gen` and commit the regenerated files in packages/contracts/src/openapi.
import type { ApiModule } from "../lib/module";
import { billingModules } from "./billing";
import { identityModules } from "./identity";
import { wp13Modules } from "./goals";
import { importsModule } from "./imports";
import { itemsModule } from "./items";
import { planningModule } from "./planning";
import { reviewModule } from "./review";
import { notifyModules } from "./notify";
import { authModule } from "./auth";
import { emailModules } from "./email";

export const modules: readonly ApiModule[] = [
  // Append new modules below this line, one per line.
  ...identityModules, // WP-05: identity, households
  itemsModule,
  planningModule, // WP-12: plan, what-if, calendar, renewals
  reviewModule, // WP-14
  ...wp13Modules, // WP-13: goals, proposals, tasks
  ...billingModules, // WP-25: billing, billing webhook
  importsModule, // WP-16: CSV import
  ...notifyModules, // WP-15: notifications, preferences, SES events webhook
  authModule, // WP-33: /v1/auth (Supabase Auth proxy)
  ...emailModules, // WP-21: email connections, OAuth callback, Gmail and Graph push webhooks
];
