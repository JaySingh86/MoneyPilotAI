// A test API for the review module: the real identity, items and review modules against the real database as
// mp_api, with a clock the test controls (the undo window depends on it). Test-only; same shape as
// auth/testing/app.ts, which does not know about this module.
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
import { createReviewModule } from "./index";

export interface ReviewTestApi {
  app: ApiServer;
  db: ApiDb;
  /** The clock every module reads. */
  setNow(iso: string): void;
  as(subject: string, options?: TokenOptions): Promise<Record<string, string>>;
  signUp(label: string): Promise<{ id: string; headers: Record<string, string> }>;
  admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createReviewTestApi(startNow = "2026-11-03T16:00:00Z"): Promise<ReviewTestApi> {
  const issuer = await FakeIssuer.create();
  const db = createApiDb({ connectionString: inject("apiDatabaseUrl"), max: 4 });
  const provider = createCognitoProvider(issuer.cognitoConfig());
  const rt: ApiRuntime = { db, provider, inviteSender: { send: async () => undefined } };
  let now = startNow;
  const clock = () => now;
  const app = buildServer({
    authenticate: createAuthenticator({ provider, db }),
    modules: [
      createIdentityModule(() => rt),
      createHouseholdsModule(() => rt),
      createItemsModule(() => rt, { now: clock }),
      createReviewModule(() => rt, { now: clock }),
    ],
  });
  await app.ready();
  const api: ReviewTestApi = {
    app,
    db,
    setNow: (iso) => {
      now = iso;
    },
    async as(subject, options) {
      return { authorization: `Bearer ${await issuer.accessToken(subject, options)}` };
    },
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
