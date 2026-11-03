// Test and seed helpers, kept off the package barrel so product code cannot import them by accident
// (G1 L-5): household lifecycle steps and the fixture seed. Import from "@mp/db/testing".
export { acceptInvite, createHousehold, ensureUser, inviteMember } from "./seed/flows";
export { planningUuid, seedPlanning } from "./seed/items";
export { assertLocalSeedTarget, SeedTargetError } from "./seed/guard";
export { fixtureUuid, seedFixture, type SeedResult } from "./seed/rivera";
