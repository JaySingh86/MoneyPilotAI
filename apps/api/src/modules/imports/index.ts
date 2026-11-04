// Imports module (WP-16): CSV upload, processing request and column mapping. Parsing and detection run in the worker.
import { defineModule } from "../../lib/module";
import { runtime, type RuntimeSource } from "../../auth/runtime";
import { importsRoutes } from "./routes";
import type { ImportQueue } from "./service";
import { importStorage, type ImportStorage } from "./storage";

export interface ImportsModuleOptions {
  /** UTC instant as ISO 8601. Default: the system clock. */
  now?: () => string;
  /** Default: the storage set by `configureImportStorage` (unconfigured answers 503). */
  storage?: () => ImportStorage;
  queue?: ImportQueue;
}

export function createImportsModule(source: RuntimeSource = runtime, options: ImportsModuleOptions = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const storage = options.storage ?? importStorage;
  return defineModule({
    name: "imports",
    routes: importsRoutes(() => ({
      db: source().db,
      now,
      storage,
      ...(options.queue ? { queue: options.queue } : {}),
    })),
  });
}

export const importsModule = createImportsModule();
export { configureImportStorage, type ImportStorage, type UploadRequest } from "./storage";
export type { ImportQueue } from "./service";
