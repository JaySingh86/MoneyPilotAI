// Seed loader for design/fixtures/rivera-household.json: the household and its two members.
// Later WPs extend it with their own entities (items, goals, ...). Rows are written through the app
// roles (mp_api for user actions, mp_worker for the billing plan), never as an owner or superuser.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ApiDb, WorkerDb } from "../tx";
import {
  acceptInvite,
  createHousehold,
  ensureUser,
  inviteMember,
  type SeedHousehold,
  type UserProfile,
} from "./flows";

/**
 * Namespace for deterministic fixture ids (uuid v5), used for the household id the API supplies at
 * creation. User ids are assigned by the database (bootstrap cannot choose them). Never change.
 */
const FIXTURE_NAMESPACE = "6f1c1d0e-6a53-4a77-9a1e-2f0a8f6f3b51";

/** RFC 4122 version 5 uuid for a fixture id such as "m-sam". */
export function fixtureUuid(fixtureId: string): string {
  const ns = Buffer.from(FIXTURE_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(fixtureId, "utf8").digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface FixtureSeedPlan {
  household: SeedHousehold & { plan: "free" | "family_plus" };
  creator: UserProfile;
  partner: UserProfile;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`fixture: ${path} must be an object`);
  return value as Record<string, unknown>;
}
function str(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`fixture: ${path} must be a non-empty string`);
  return value;
}
function cents(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`fixture: ${path} must be integer cents`);
  return value;
}

/** Validates the parts of the fixture the seed uses and maps them to rows. Pure. */
export function planFixtureSeed(fixture: unknown): FixtureSeedPlan {
  const root = record(fixture, "root");
  const hh = record(root.household, "household");
  const plan = str(hh.plan, "household.plan");
  if (plan !== "free" && plan !== "family_plus")
    throw new Error("fixture: household.plan must be free or family_plus");
  const timezone = str(hh.timezone, "household.timezone");
  const forwardingAddress = str(root.forwardingAddress, "forwardingAddress");
  const forwardingToken = forwardingAddress.split("@")[0] ?? "";
  if (!forwardingToken) throw new Error("fixture: forwardingAddress has no local part");

  if (!Array.isArray(root.members)) throw new Error("fixture: members must be an array");
  const members = root.members.map((m, i) => {
    const r = record(m, `members[${i}]`);
    const id = str(r.id, `members[${i}].id`);
    const name = str(r.name, `members[${i}].name`);
    const email = str(r.email, `members[${i}].email`);
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error(`fixture: members[${i}].email is not an address`);
    const user: UserProfile = { authSubject: `fixture|${id}`, email, firstName: name, timezone };
    return { colorRole: str(r.colorRole, `members[${i}].colorRole`), user };
  });
  const creator = members.find((m) => m.colorRole === "partnerA")?.user;
  const partner = members.find((m) => m.colorRole === "partnerB")?.user;
  if (!creator || !partner || members.length !== 2) {
    throw new Error("fixture: expected exactly one partnerA and one partnerB member");
  }

  return {
    household: {
      id: fixtureUuid(str(hh.id, "household.id")),
      name: str(hh.name, "household.name"),
      timezone,
      forwardingToken,
      cushionCents: cents(hh.cushionCents, "household.cushionCents"),
      plan,
    },
    creator,
    partner,
  };
}

export interface SeedResult {
  /** False when the household already existed (re-run). */
  created: boolean;
  householdId: string;
  userIds: { creator: string; partner: string };
}

/** Idempotent: safe to run on every `pnpm db:seed`. */
export async function seedFixture(
  dbs: { api: ApiDb; worker: WorkerDb },
  fixture: unknown,
): Promise<SeedResult> {
  const plan = planFixtureSeed(fixture);
  const { household } = plan;
  const creator = await ensureUser(dbs.api, plan.creator);
  const partner = await ensureUser(dbs.api, plan.partner);
  const created = await createHousehold(dbs.api, creator, household);

  const partnerIsMember = await dbs.api.withHouseholdTx(
    { userId: creator.id, householdId: household.id },
    async (tx) => {
      const res = await tx.execute(sql`select 1 from household_members
      where household_id = ${household.id} and user_id = ${partner.id} and left_at is null`);
      return res.rows.length > 0;
    },
  );
  if (!partnerIsMember) {
    const invite = await inviteMember(dbs.api, creator, household.id, partner.email);
    await acceptInvite(dbs.api, partner, invite.token);
  }

  // The plan is an entitlement: only the worker (billing.sync) may set it.
  await dbs.worker.withJobTx(household.id, (tx) =>
    tx.execute(
      sql`update households set plan = ${household.plan} where id = ${household.id} and plan <> ${household.plan}`,
    ),
  );

  return { created, householdId: household.id, userIds: { creator: creator.id, partner: partner.id } };
}
