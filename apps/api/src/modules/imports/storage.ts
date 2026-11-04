// The object store the API talks to for CSV uploads (BACKEND_PLAN §7.7): a presigned upload limited to the declared
// size, a size check before processing, and a delete for an oversize object. The S3 adapter lands with the
// infrastructure (Q-143); tests use `testing.ts`. The worker has its own, read-and-delete interface.
import { AppError } from "@mp/contracts";

export interface UploadRequest {
  method: "PUT" | "POST";
  url: string;
  headers: Record<string, string>;
  fields: Record<string, string>;
  /** UTC instant, ISO 8601. */
  expiresAt: string;
}

export interface ImportStorage {
  /**
   * A presigned request that accepts only `contentType` and at most `maxBytes` (a presigned POST policy with
   * `content-length-range` on S3), valid for `expiresInSeconds`.
   */
  createUpload(input: {
    key: string;
    contentType: "text/csv";
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<UploadRequest>;
  /** The stored object's size, or null when nothing was uploaded under the key. */
  head(key: string): Promise<{ sizeBytes: number } | null>;
  delete(key: string): Promise<void>;
}

/** Until the S3 adapter is wired: uploads answer 503 instead of pretending to work. */
export const unconfiguredImportStorage: ImportStorage = {
  createUpload: () => Promise.reject(unavailable()),
  head: () => Promise.reject(unavailable()),
  delete: () => Promise.reject(unavailable()),
};

function unavailable(): AppError {
  return new AppError("internal_error", 503, "File upload is not available yet.");
}

/** Hands the module the storage lazily, so registration does no I/O and the startup code can set it once. */
let configured: ImportStorage = unconfiguredImportStorage;
export function configureImportStorage(storage: ImportStorage): void {
  configured = storage;
}
export const importStorage = (): ImportStorage => configured;

/** Object key for an import: the household and import ids only, never the file name. */
export function importKey(householdId: string, importId: string): string {
  return `imports/${householdId}/${importId}.csv`;
}
