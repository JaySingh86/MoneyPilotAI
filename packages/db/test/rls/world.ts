// Two households built through the app role (mp_api), plus a stranger with no household.
// Every row the RLS tests rely on is created the way the API would create it.
import { randomUUID } from "node:crypto";
import {
  acceptInvite,
  createHousehold,
  ensureUser,
  inviteMember,
  type SeedUser,
  type UserProfile,
} from "../../src/seed/flows";
import type { ApiDb } from "../../src/tx";
import { seedItemsWorld, type ItemsWorldRows } from "./items-world";

export interface TestHousehold {
  id: string;
  creator: SeedUser;
  partner: SeedUser;
  /** Token of the partner's (accepted) invite. */
  partnerInviteToken: string;
  /** One row in every WP-06 table. */
  items: ItemsWorldRows;
}

export interface World {
  a: TestHousehold;
  b: TestHousehold;
  /** Signed in, member of nothing. */
  stranger: SeedUser;
}

/** A unique profile, before bootstrap. */
export function newProfile(label: string): UserProfile {
  const unique = randomUUID();
  return {
    authSubject: `test|${label}|${unique}`,
    email: `${label}-${unique}@example.test`,
    firstName: label,
  };
}

/** A signed-in user with a users row, created through bootstrap. */
export async function createUser(db: ApiDb, label: string): Promise<SeedUser> {
  return ensureUser(db, newProfile(label));
}

export async function buildHousehold(db: ApiDb, label: string): Promise<TestHousehold> {
  const creator = await createUser(db, `${label}-creator`);
  const partner = await createUser(db, `${label}-partner`);
  const id = randomUUID();
  await createHousehold(db, creator, {
    id,
    name: `Household ${label}`,
    timezone: "America/New_York",
    forwardingToken: `${label}-${id.slice(0, 8)}`,
  });
  const invite = await inviteMember(db, creator, id, partner.email);
  await acceptInvite(db, partner, invite.token);
  // A second, still-open invite so invites has a pending row too.
  await inviteMember(db, creator, id, `pending-${id}@example.test`);
  const household = { id, creator, partner, partnerInviteToken: invite.token };
  // One row in every WP-06 table, so the cross-household tests have a victim in each.
  const items = await seedItemsWorld(db, household);
  return { ...household, items };
}

export async function buildWorld(db: ApiDb): Promise<World> {
  const [a, b] = await Promise.all([buildHousehold(db, "a"), buildHousehold(db, "b")]);
  const stranger = await createUser(db, "stranger");
  return { a, b, stranger };
}
