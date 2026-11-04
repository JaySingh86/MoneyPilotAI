// Test helpers for the imports module: an in-memory object store and a test API (real identity, households and
// imports modules against the real database as mp_api). Test-only.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { createApiDb, type ApiDb } from "@mp/db";
import { createAuthenticator } from "../../auth/authenticator";
import { createCognitoProvider } from "../../auth/cognito";
import { FakeIssuer, type TokenOptions } from "../../auth/testing/fake-issuer";
import type { ApiRuntime } from "../../auth/runtime";
import { buildServer, type ApiServer } from "../../server";
import { createHouseholdsModule } from "../households";
import { createIdentityModule } from "../identity";
import { createItemsModule } from "../items";
import { createReviewModule } from "../review";
import { createImportsModule } from "./index";
import type { ImportQueue } from "./service";
import type { ImportStorage, UploadRequest } from "./storage";

/** An object store in memory. `put` plays the browser's upload. */
export class MemoryImportStorage implements ImportStorage {
  readonly objects = new Map<string, Uint8Array>();
  readonly uploads: { key: string; maxBytes: number; contentType: string; expiresInSeconds: number }[] = [];

  put(key: string, data: Uint8Array | string): void {
    this.objects.set(key, typeof data === "string" ? new TextEncoder().encode(data) : data);
  }

  async createUpload(input: {
    key: string;
    contentType: "text/csv";
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<UploadRequest> {
    this.uploads.push(input);
    return {
      method: "PUT",
      url: `https://storage.example.test/${input.key}?signature=fake`,
      headers: { "content-type": input.contentType },
      fields: {},
      expiresAt: "2026-11-04T12:15:00Z",
    };
  }

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    const object = this.objects.get(key);
    return object ? { sizeBytes: object.byteLength } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export class RecordingQueue implements ImportQueue {
  readonly sent: { householdId: string; importId: string }[] = [];
  async enqueueProcess(householdId: string, importId: string): Promise<void> {
    this.sent.push({ householdId, importId });
  }
}

export interface ImportsTestApi {
  app: ApiServer;
  db: ApiDb;
  storage: MemoryImportStorage;
  queue: RecordingQueue;
  as(subject: string, options?: TokenOptions): Promise<Record<string, string>>;
  signUp(label: string): Promise<{ id: string; headers: Record<string, string> }>;
  admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createImportsTestApi(
  options: { importsLimit?: { max: number; timeWindow: string } } = {},
): Promise<ImportsTestApi> {
  const issuer = await FakeIssuer.create();
  const db = createApiDb({ connectionString: inject("apiDatabaseUrl"), max: 4 });
  const provider = createCognitoProvider(issuer.cognitoConfig());
  const rt: ApiRuntime = { db, provider, inviteSender: { send: async () => undefined } };
  const storage = new MemoryImportStorage();
  const queue = new RecordingQueue();
  const app = buildServer({
    // Most tests make far more than 10 import calls a minute; the limit itself has its own test.
    rateLimit: { groups: { imports: options.importsLimit ?? { max: 1000, timeWindow: "1 minute" } } },
    authenticate: createAuthenticator({ provider, db }),
    modules: [
      createIdentityModule(() => rt),
      createHouseholdsModule(() => rt),
      createItemsModule(() => rt, {}),
      createReviewModule(() => rt, {}),
      createImportsModule(() => rt, { storage: () => storage, queue }),
    ],
  });
  await app.ready();
  const api: ImportsTestApi = {
    app,
    db,
    storage,
    queue,
    as: async (subject, options) => ({
      authorization: `Bearer ${await issuer.accessToken(subject, options)}`,
    }),
    async signUp(label) {
      const subject = `sub-${label}-${randomUUID()}`;
      const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
      const headers = await api.as(subject, { claims: { email } });
      const res = await app.inject({
        method: "POST",
        url: "/v1/me/bootstrap",
        headers,
        payload: { firstName: label },
      });
      if (res.statusCode !== 200) throw new Error(`bootstrap failed: ${res.statusCode} ${res.body}`);
      return { id: (res.json() as { id: string }).id, headers };
    },
    async admin(fn) {
      const client = new pg.Client({ connectionString: inject("adminDatabaseUrl") });
      await client.connect();
      try {
        return await fn(client);
      } finally {
        await client.end();
      }
    },
    async close() {
      await app.close();
      await db.close();
    },
  };
  return api;
}
