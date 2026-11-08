// WP-21 rules beyond plain isolation (the generic cross-household cases are in cases.ts): the ciphertext
// columns are readable by mp_worker only, only the owner changes a connection and only along allowed
// transitions, messages are worker-written, and an OAuth state works once, expires and is never readable.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDb, Tx, WorkerDb } from "../../src/tx";
import { count, expectDenied, expectRejected, openDbs } from "./helpers";
import { buildWorld, type World } from "./world";

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";

let api: ApiDb;
let worker: WorkerDb;
let world: World;

const asCreatorA = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.a.creator.id, householdId: world.a.id }, fn);
const asPartnerA = <T>(fn: (tx: Tx) => Promise<T>) =>
  api.withHouseholdTx({ userId: world.a.partner.id, householdId: world.a.id }, fn);
const asWorkerA = <T>(fn: (tx: Tx) => Promise<T>) => worker.withJobTx(world.a.id, fn);

const hash = (s: Buffer) => createHash("sha256").update(s).digest();

/** A connection owned by A's creator, inserted the way the callback does. */
async function newConnection(provider: "gmail" | "outlook" = "gmail"): Promise<string> {
  const id = randomUUID();
  await asCreatorA((tx) =>
    tx.execute(sql`insert into email_connections
        (id, household_id, user_id, provider, address_masked, address_hash, scopes, token_ciphertext, token_dek_wrapped, token_key_id)
      values (${id}, ${world.a.id}, ${world.a.creator.id}, ${provider}, 'x•••@x.test', ${randomBytes(32)},
        array['scope'], ${randomBytes(8)}, ${randomBytes(8)}, 'local:test')`),
  );
  return id;
}

beforeAll(async () => {
  ({ api, worker } = openDbs());
  world = await buildWorld(api);
});
afterAll(async () => {
  await api.close();
  await worker.close();
});

describe("email_connections: ciphertext columns", () => {
  it("mp_api cannot read the token columns, in any form", async () => {
    for (const column of [
      "token_ciphertext",
      "token_dek_wrapped",
      "token_key_id",
      "address_hash",
      "sync_cursor",
      "watch_ref",
      "push_received_at",
    ]) {
      await expectDenied(() =>
        asCreatorA((tx) => tx.execute(sql`select ${sql.identifier(column)} from email_connections`)),
      );
    }
    // `select *` expands to every column, so it is refused too.
    await expectDenied(() => asCreatorA((tx) => tx.execute(sql`select * from email_connections`)));
    // A WHERE clause on the ciphertext is a read (a boolean oracle), so it is refused as well.
    await expectDenied(() =>
      asCreatorA((tx) =>
        tx.execute(sql`select id from email_connections where token_ciphertext is not null`),
      ),
    );
    // RETURNING a token column is a read too.
    await expectDenied(() =>
      asCreatorA((tx) =>
        tx.execute(sql`update email_connections set status = status where id = ${world.a.email.connectionId}
          returning token_ciphertext`),
      ),
    );
  });

  it("mp_api reads the management columns of its household, partner included", async () => {
    for (const run of [asCreatorA, asPartnerA]) {
      const n = await run((tx) =>
        count(tx, sql`select id, provider, address_masked, status, user_id from email_connections`),
      );
      expect(n).toBeGreaterThan(0);
    }
  });

  it("mp_api cannot overwrite the token columns, even for its own connection", async () => {
    for (const set of [
      sql`token_ciphertext = ${randomBytes(8)}`,
      sql`token_dek_wrapped = ${randomBytes(8)}`,
      sql`token_key_id = 'x'`,
      sql`sync_cursor = 'x'`,
      sql`last_error = 'auth_expired'`,
      sql`user_id = ${world.a.partner.id}`,
      sql`household_id = ${world.b.id}`,
      sql`backfill_status = 'done'`,
    ]) {
      await expectDenied(() =>
        asCreatorA((tx) =>
          tx.execute(sql`update email_connections set ${set} where id = ${world.a.email.connectionId}`),
        ),
      );
    }
  });

  it("mp_worker reads the ciphertext columns and rotates them", async () => {
    const rows = await asWorkerA((tx) =>
      tx.execute<{ token_ciphertext: Buffer }>(
        sql`select token_ciphertext from email_connections where id = ${world.a.email.connectionId}`,
      ),
    );
    expect(rows.rows[0]?.token_ciphertext.length).toBeGreaterThan(0);
    const updated = await asWorkerA((tx) =>
      tx.execute(sql`update email_connections set token_ciphertext = ${randomBytes(8)}, token_dek_wrapped = ${randomBytes(8)}
        where id = ${world.a.email.connectionId}`),
    );
    expect(updated.rowCount).toBe(1);
  });

  it("only mp_api inserts a connection, and only as the signed-in member", async () => {
    const insert = (
      userId: string,
      householdId: string,
      status = "active",
    ) => sql`insert into email_connections
        (household_id, user_id, provider, address_masked, address_hash, scopes, token_ciphertext, token_dek_wrapped, token_key_id, status)
      values (${householdId}, ${userId}, 'outlook', 'y•••@y.test', ${randomBytes(32)}, array['s'], ${randomBytes(8)},
        ${randomBytes(8)}, 'k', ${status})`;
    // On behalf of the partner: refused.
    await expectDenied(() => asCreatorA((tx) => tx.execute(insert(world.a.partner.id, world.a.id))));
    // Already paused: refused (a new connection starts active).
    await expectDenied(() =>
      asCreatorA((tx) => tx.execute(insert(world.a.creator.id, world.a.id, "paused"))),
    );
    // The worker never creates one.
    await expectDenied(() => asWorkerA((tx) => tx.execute(insert(world.a.creator.id, world.a.id))));
    expect((await asCreatorA((tx) => tx.execute(insert(world.a.creator.id, world.a.id)))).rowCount).toBe(1);
  });

  it("a revoked connection may have no token; a live one must", async () => {
    await expectRejected(
      () =>
        asWorkerA((tx) =>
          tx.execute(
            sql`update email_connections set token_ciphertext = null where id = ${world.a.email.connectionId}`,
          ),
        ),
      CHECK_VIOLATION,
    );
  });

  it("the same mailbox cannot be connected twice by one member, but can again after a disconnect", async () => {
    const id = await newConnection();
    const addr = randomBytes(32);
    const insert = () =>
      asCreatorA((tx) =>
        tx.execute(sql`insert into email_connections
            (household_id, user_id, provider, address_masked, address_hash, scopes, token_ciphertext, token_dek_wrapped, token_key_id)
          values (${world.a.id}, ${world.a.creator.id}, 'gmail', 'd•••@x.test', ${addr}, array['s'], ${randomBytes(8)},
            ${randomBytes(8)}, 'k')`),
      );
    await insert();
    await expectRejected(insert, UNIQUE_VIOLATION);
    await asCreatorA((tx) =>
      tx.execute(sql`update email_connections set status = 'revoked', revoked_at = now()
        where household_id = ${world.a.id} and address_masked = 'd•••@x.test'`),
    );
    await insert();
    expect(id).toBeTruthy();
  });
});

describe("email_connections: who may manage one", () => {
  it("the partner can see a connection but cannot pause, resume or disconnect it", async () => {
    const id = await newConnection();
    for (const set of [sql`status = 'paused'`, sql`status = 'revoked', revoked_at = now()`]) {
      const r = await asPartnerA((tx) =>
        tx.execute(sql`update email_connections set ${set} where id = ${id}`),
      );
      expect(r.rowCount).toBe(0);
    }
    expect(await asPartnerA((tx) => count(tx, sql`select id from email_connections where id = ${id}`))).toBe(
      1,
    );
    const status = await asWorkerA((tx) =>
      tx.execute<{ status: string }>(sql`select status from email_connections where id = ${id}`),
    );
    expect(status.rows[0]?.status).toBe("active");
  });

  it("the owner follows active -> paused -> active -> revoked and nothing else", async () => {
    const id = await newConnection();
    const set = (status: string) =>
      asCreatorA((tx) =>
        tx.execute(sql`update email_connections set status = ${status},
          revoked_at = ${status === "revoked" ? sql`now()` : sql`null`} where id = ${id}`),
      );
    expect((await set("paused")).rowCount).toBe(1);
    await expectDenied(() => set("error"));
    expect((await set("active")).rowCount).toBe(1);
    expect((await set("revoked")).rowCount).toBe(1);
    // A disconnected mailbox stays disconnected.
    await expectDenied(() => set("active"));
  });

  it("the API cannot delete a connection (a disconnect keeps the audit trail)", async () => {
    await expectDenied(() => asCreatorA((tx) => tx.execute(sql`delete from email_connections`)));
  });
});

describe("email_messages", () => {
  const insert = (
    id: string,
    providerId: string,
    connectionId: string | null,
  ) => sql`insert into email_messages
      (id, household_id, connection_id, channel, provider_message_id, received_at, from_domain, stage)
    values (${id}, ${world.a.id}, ${connectionId}, 'gmail', ${providerId}, now(), 'x.example', 'discovered')`;

  it("the API reads messages but cannot write them", async () => {
    expect(await asPartnerA((tx) => count(tx, sql`select id from email_messages`))).toBeGreaterThan(0);
    await expectDenied(() => asCreatorA((tx) => tx.execute(insert(randomUUID(), "api-1", null))));
    await expectDenied(() => asCreatorA((tx) => tx.execute(sql`update email_messages set stage = 'failed'`)));
    await expectDenied(() => asCreatorA((tx) => tx.execute(sql`delete from email_messages`)));
  });

  it("the same provider message is stored once per connection", async () => {
    const connectionId = await newConnection();
    const first = () => asWorkerA((tx) => tx.execute(insert(randomUUID(), "dup-1", connectionId)));
    await first();
    await expectRejected(first, UNIQUE_VIOLATION);
    // ON CONFLICT DO NOTHING is how discover stays idempotent.
    const again = await asWorkerA((tx) =>
      tx.execute(sql`${insert(randomUUID(), "dup-1", connectionId)} on conflict do nothing`),
    );
    expect(again.rowCount).toBe(0);
  });

  it("a connection of another household cannot be referenced (tenant-safe foreign key)", async () => {
    await expectRejected(
      () => asWorkerA((tx) => tx.execute(insert(randomUUID(), "x-hh", world.b.email.connectionId))),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("removing nothing else: the worker cannot change what the message is", async () => {
    await expectDenied(() =>
      asWorkerA((tx) => tx.execute(sql`update email_messages set from_domain = 'x.example'`)),
    );
    await expectDenied(() =>
      asWorkerA((tx) => tx.execute(sql`update email_messages set household_id = ${world.b.id}`)),
    );
  });
});

describe("email_oauth_states", () => {
  const stateHash = () => hash(randomBytes(32));
  const verifier = () => randomBytes(32).toString("base64url");
  // The browser nonce is derived from the state in these tests; the API test covers the real cookie.
  const browser = (h: Buffer) => hash(h);
  const insertState = (userId: string, h: Buffer, expiresInSeconds = 600, returnTo = "/imports") =>
    asCreatorA((tx) =>
      tx.execute(sql`insert into email_oauth_states (state_hash, user_id, provider, return_to, code_verifier, browser_hash, expires_at)
        values (${h}, ${userId}, 'gmail', ${returnTo}, ${verifier()}, ${browser(h)}, now() + make_interval(secs => ${expiresInSeconds}))`),
    );
  const consume = (h: Buffer, browserHash: Buffer | null = browser(h)) =>
    api.withHouseholdTx({ userId: null }, (tx) =>
      tx.execute<{ user_id: string; household_id: string; provider: string; return_to: string }>(
        sql`select * from app_email_oauth_consume(${h}, ${browserHash})`,
      ),
    );

  it("a person starts a state only as themselves", async () => {
    await expectDenied(() => insertState(world.a.partner.id, stateHash()));
    await expectRejected(
      () => insertState(world.a.creator.id, stateHash(), 600, "/elsewhere"),
      CHECK_VIOLATION,
    );
  });

  it("nobody can read a state back, the API included; no app role can list them", async () => {
    await insertState(world.a.creator.id, stateHash());
    await expectDenied(() => asCreatorA((tx) => tx.execute(sql`select state_hash from email_oauth_states`)));
    await expectDenied(() =>
      asCreatorA((tx) => tx.execute(sql`select code_verifier from email_oauth_states`)),
    );
    await expectDenied(() => asCreatorA((tx) => tx.execute(sql`delete from email_oauth_states`)));
    await expectDenied(() =>
      asWorkerA((tx) => tx.execute(sql`select code_verifier from email_oauth_states`)),
    );
    expect(
      await asWorkerA((tx) =>
        count(tx, sql`select expires_at from email_oauth_states where expires_at > now()`),
      ),
    ).toBe(0);
  });

  it("consuming returns who started it and their household, exactly once", async () => {
    const h = stateHash();
    await insertState(world.a.creator.id, h);
    const first = await consume(h);
    expect(first.rows).toEqual([
      expect.objectContaining({
        user_id: world.a.creator.id,
        household_id: world.a.id,
        provider: "gmail",
        return_to: "/imports",
      }),
    ]);
    expect((await consume(h)).rows).toEqual([]);
  });

  it("a state without the starting browser's nonce returns nothing and is burnt (login CSRF)", async () => {
    for (const wrong of [null, hash(randomBytes(32)), Buffer.alloc(32)]) {
      const h = stateHash();
      await insertState(world.a.creator.id, h);
      expect((await consume(h, wrong)).rows).toEqual([]);
      // The right nonce afterwards does not revive it: one wrong attempt spends the state.
      expect((await consume(h)).rows).toEqual([]);
    }
  });

  it("an expired or unknown state returns nothing, and an expired one is gone", async () => {
    const h = stateHash();
    await insertState(world.a.creator.id, h, -5);
    expect((await consume(h)).rows).toEqual([]);
    expect((await consume(stateHash())).rows).toEqual([]);
  });

  it("the worker sees and prunes expired states only; a live one is invisible to it", async () => {
    const live = stateHash();
    await insertState(world.a.creator.id, live);
    await insertState(world.a.creator.id, stateHash(), -5);
    const seen = await asWorkerA((tx) => count(tx, sql`select 1 from email_oauth_states`));
    expect(seen).toBeGreaterThan(0);
    await asWorkerA((tx) => tx.execute(sql`delete from email_oauth_states where expires_at < now()`));
    expect(await asWorkerA((tx) => count(tx, sql`select 1 from email_oauth_states`))).toBe(0);
    // A DELETE without a WHERE removes nothing live either.
    await asWorkerA((tx) => tx.execute(sql`delete from email_oauth_states`));
    expect((await consume(live)).rows).toHaveLength(1);
  });
});

describe("push functions", () => {
  const callApi = <T>(fn: (tx: Tx) => Promise<T>) => api.withHouseholdTx({ userId: null }, fn);

  it("a Gmail push marks the matching active connection, and nothing else", async () => {
    const hash = world.a.email.addressHash;
    const n = await callApi((tx) =>
      tx.execute<{ n: number }>(sql`select app_email_push_gmail(${hash}) as n`),
    );
    expect(n.rows[0]?.n).toBe(1);
    const marked = await asWorkerA((tx) =>
      count(
        tx,
        sql`select 1 from email_connections where push_received_at is not null and id = ${world.a.email.connectionId}`,
      ),
    );
    expect(marked).toBe(1);
    const other = await worker.withJobTx(world.b.id, (tx) =>
      count(tx, sql`select 1 from email_connections where push_received_at is not null`),
    );
    expect(other).toBe(0);
    const none = await callApi((tx) =>
      tx.execute<{ n: number }>(sql`select app_email_push_gmail(${randomBytes(32)}) as n`),
    );
    expect(none.rows[0]?.n).toBe(0);
  });

  it("a Graph push matches Outlook connections only", async () => {
    const gmailId = world.b.email.connectionId;
    const n = await callApi((tx) =>
      tx.execute<{ n: number }>(sql`select app_email_push_graph(${gmailId}) as n`),
    );
    expect(n.rows[0]?.n).toBe(0);
  });

  it("the worker cannot call the API's functions", async () => {
    await expectDenied(() =>
      asWorkerA((tx) => tx.execute(sql`select app_email_push_gmail(${randomBytes(32)})`)),
    );
    await expectDenied(() =>
      asWorkerA((tx) =>
        tx.execute(sql`select * from app_email_oauth_consume(${randomBytes(32)}, ${randomBytes(32)})`),
      ),
    );
  });
});
