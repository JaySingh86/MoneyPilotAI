// Test-only: a household with two members and bills, built through the same role paths the app uses
// (members via mp_api, bills via the superuser connection so tests can place any occurrence on any date).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { createApiDb, type ApiDb } from "@mp/db";
import { acceptInvite, createHousehold, ensureUser, inviteMember } from "@mp/db/testing";

interface Member {
  id: string;
  email: string;
}

export interface TestHousehold {
  id: string;
  timezone: string;
  sam: Member;
  jordan: Member;
}

export interface Fixtures {
  api: ApiDb;
  admin: pg.Client;
  household(timezone?: string): Promise<TestHousehold>;
  /** A bill (outflow) with one scheduled occurrence. Returns ids. */
  bill(
    hh: TestHousehold,
    input: {
      name?: string;
      scheduledOn: string;
      dueOn?: string;
      owner?: "sam" | "jordan" | "both" | "split";
      amountCents?: number | null;
      amountType?: "fixed" | "estimated" | "statement";
      rrule?: string;
      direction?: "outflow" | "inflow";
      category?: string;
    },
  ): Promise<{ itemId: string; occurrenceId: string }>;
  query<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export async function createFixtures(): Promise<Fixtures> {
  const api = createApiDb({ connectionString: inject("apiDatabaseUrl"), max: 2 });
  const admin = new pg.Client({ connectionString: inject("adminDatabaseUrl") });
  await admin.connect();
  const query = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await admin.query(text, params)).rows as T[];

  return {
    api,
    admin,
    query,
    async household(timezone = "America/New_York") {
      const tag = randomUUID().slice(0, 8);
      const sam = await ensureUser(api, {
        authSubject: `notify|sam|${tag}`,
        email: `sam-${tag}@example.test`,
        firstName: "Sam",
      });
      const jordan = await ensureUser(api, {
        authSubject: `notify|jordan|${tag}`,
        email: `jordan-${tag}@example.test`,
        firstName: "Jordan",
      });
      const id = randomUUID();
      await createHousehold(api, sam, { id, name: "Rivera", timezone, forwardingToken: `notify-${tag}` });
      const invite = await inviteMember(api, sam, id, jordan.email);
      await acceptInvite(api, jordan, invite.token);
      return { id, timezone, sam, jordan };
    },
    async bill(hh, input) {
      const itemId = randomUUID();
      const occurrenceId = randomUUID();
      const owner = input.owner ?? "sam";
      const ownerType = owner === "both" || owner === "split" ? owner : "member";
      const ownerUser = owner === "sam" ? hh.sam.id : owner === "jordan" ? hh.jordan.id : null;
      const direction = input.direction ?? "outflow";
      const amount = input.amountCents === undefined ? 215000 : input.amountCents;
      await admin.query(
        `insert into recurring_items (id, household_id, direction, kind, category, name, amount_type, amount_cents,
           rrule, dtstart, owner_type, owner_user_id, source)
         values ($1, $2, $3, 'bill', $11, $4, $5, $6, $7, $8, $9, $10, 'manual')`,
        [
          itemId,
          hh.id,
          direction,
          input.name ?? "Rent",
          input.amountType ?? "fixed",
          amount,
          input.rrule ?? "FREQ=MONTHLY;BYMONTHDAY=1",
          input.scheduledOn,
          ownerType,
          ownerUser,
          input.category ?? "housing",
        ],
      );
      await admin.query(
        `insert into occurrences (id, household_id, item_id, scheduled_on, due_on) values ($1, $2, $3, $4, $5)`,
        [occurrenceId, hh.id, itemId, input.scheduledOn, input.dueOn ?? input.scheduledOn],
      );
      return { itemId, occurrenceId };
    },
    async close() {
      await admin.end();
      await api.close();
    },
  };
}
