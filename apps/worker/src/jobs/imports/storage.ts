// The object store the import job reads from (BACKEND_PLAN §7.7). The S3 adapter lands with the infrastructure
// (Q-143); tests use an in-memory one. The worker reads the file and deletes it after processing.
export interface ImportFileStore {
  /** The stored bytes, or null when the object does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

/** Until the S3 adapter is wired: processing fails (and retries) instead of silently doing nothing. */
export const unconfiguredImportFileStore: ImportFileStore = {
  get: () => Promise.reject(new Error("No import file store is configured.")),
  delete: () => Promise.reject(new Error("No import file store is configured.")),
};

let configured: ImportFileStore = unconfiguredImportFileStore;
export function configureImportFileStore(store: ImportFileStore): void {
  configured = store;
}
export const importFileStore = (): ImportFileStore => configured;
