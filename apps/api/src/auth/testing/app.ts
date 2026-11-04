// A full API for integration tests: the real identity and households modules, the real Cognito
// verifier against a fake issuer, and the real database as mp_api. Test-only.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { createApiDb, type ApiDb } from "@mp/db";
import { buildServer, type ApiServer } from "../../server";
import { createHouseholdsModule } from "../../modules/households";
import { createIdentityModule } from "../../modules/identity";
import type { BillingProvider } from "@mp/billing";
import { createBillingModules } from "../../modules/billing";
import { createWp13Modules } from "../../modules/goals";
import { createItemsModule } from "../../modules/items";
import { createPlanningModule } from "../../modules/planning";
import { tasksSummaryBadges } from "../../modules/tasks/badges";
import { createAuthenticator } from "../authenticator";
import { createCognitoProvider } from "../cognito";
import type { ApiRuntime, InviteSender } from "../runtime";
import { FakeIssuer, type TokenOptions } from "./fake-issuer";

export interface SentInvite {
  to: string;
  token: string;
  householdName: string;
  inviterFirstName: string;
}

export interface TestApi {
  app: ApiServer;
  db: ApiDb;
  issuer: FakeIssuer;
  sent: SentInvite[];
  /** Makes invite delivery fail, once. */
  failNextInvite(): void;
  /** Bearer headers for a subject. */
  as(subject: string, options?: TokenOptions): Promise<Record<string, string>>;
  /** Sign up a verified user (bootstrap) and return its id and auth headers. */
  signUp(
    label: string,
    options?: { firstName?: string; claims?: Record<string, unknown> },
  ): Promise<TestUser>;
  /** Fixture helper: runs SQL as the database superuser. */
  admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface TestUser {
  id: string;
  subject: string;
  email: string;
  headers: Record<string, string>;
}

export interface TestApiOptions {
  /** The API clock (UTC instant). Default: the fixture date, 2026-10-27. */
  now?: () => string;
  /** The billing provider behind the billing routes (WP-25). Default: none configured. */
  billingProvider?: BillingProvider | null;
}

export async function createTestApi(options: TestApiOptions = {}): Promise<TestApi> {
  const now = options.now ?? (() => "2026-10-27T16:00:00Z");
  const issuer = await FakeIssuer.create();
  const db = createApiDb({ connectionString: inject("apiDatabaseUrl"), max: 4 });
  const provider = createCognitoProvider(issuer.cognitoConfig());
  const sent: SentInvite[] = [];
  let failNext = false;
  const inviteSender: InviteSender = {
    async send(invite) {
      if (failNext) {
        failNext = false;
        throw new Error("smtp down");
      }
      sent.push({
        to: invite.to,
        token: invite.token,
        householdName: invite.householdName,
        inviterFirstName: invite.inviterFirstName,
      });
    },
  };
  const rt: ApiRuntime = { db, provider, inviteSender };
  const app = buildServer({
    authenticate: createAuthenticator({ provider, db }),
    modules: [
      createIdentityModule(() => rt),
      createHouseholdsModule(() => rt, undefined, tasksSummaryBadges(now)),
      createItemsModule(() => rt, { now }),
      ...createWp13Modules(() => rt, { now }),
      createPlanningModule(() => rt, { now }),
      ...createBillingModules(() => rt, { now, provider: options.billingProvider ?? null }),
    ],
  });
  await app.ready();

  const api: TestApi = {
    app,
    db,
    issuer,
    sent,
    failNextInvite: () => {
      failNext = true;
    },
    async as(subject, options) {
      return { authorization: `Bearer ${await issuer.accessToken(subject, options)}` };
    },
    async signUp(label, options) {
      const subject = `sub-${label}-${randomUUID()}`;
      const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
      const headers = await api.as(subject, { claims: { email, ...options?.claims } });
      const res = await app.inject({
        method: "POST",
        url: "/v1/me/bootstrap",
        headers,
        payload: { firstName: options?.firstName ?? label },
      });
      if (res.statusCode !== 200) throw new Error(`bootstrap failed: ${res.statusCode} ${res.body}`);
      return { id: (res.json() as { id: string }).id, subject, email, headers };
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

export const key = (): Record<string, string> => ({ "idempotency-key": randomUUID() });
