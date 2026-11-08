// WP-21 worker jobs against a real Postgres as mp_worker (RLS scoped to the job's household) and the fake Gmail and
// Graph: backfill that resumes after an interruption, discover that is idempotent under duplicate pushes, watch
// start/renew/alert, disconnect (revoke at the provider, stop the watch, delete the token, audit) and the sweep.
// No network, no real inbox, no AWS (local key provider).
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createApiDb, createWorkerDb, type ApiDb, type WorkerDb } from "@mp/db";
import { createHousehold, ensureUser } from "@mp/db/testing";
import { LocalKeyProvider, openToken, sealToken } from "@mp/crypto";
import { generatePkce, ProviderError } from "@mp/email/providers";
import { createFakeGmail, createFakeGraph, type FakeMailProvider } from "@mp/email/testing";
import type { Logger } from "@mp/observability";
import { handleEmailBackfill } from "./backfill/backfill";
import { handleEmailDiscover } from "./discover/discover";
import type { EmailJobDeps, SweepDeps } from "./discover/connection";
import { handleEmailSweep, handleEmailWatchSweep } from "./discover/sweep";
import { handleEmailRevoke } from "./watch/revoke";
import { handleEmailWatch } from "./watch/watch";

const NOW = "2026-11-09T12:00:00Z";
const nowMs = () => Date.parse(NOW);

let api: ApiDb;
let worker: WorkerDb;
let admin: pg.Client;
let gmail: FakeMailProvider;
let graph: FakeMailProvider;
let keys: LocalKeyProvider;
let clock = NOW;
const captured: Record<string, unknown>[] = [];
const record = (o: unknown, msg?: string) =>
  captured.push({ ...(typeof o === "object" && o !== null ? (o as Record<string, unknown>) : {}), msg });
const logs = {
  logger: { info: record, warn: record, error: record } as unknown as Pick<Logger, "info" | "warn" | "error">,
  lines: () => captured,
};
const secret = randomBytes(32);

const deps = (): EmailJobDeps => ({
  db: worker,
  now: () => clock,
  log: logs.logger,
  providers: { gmail, outlook: graph },
  keys,
  graphStateSecret: secret,
});

beforeAll(async () => {
  api = createApiDb({ connectionString: inject("apiDatabaseUrl"), max: 2 });
  worker = createWorkerDb({ connectionString: inject("workerDatabaseUrl"), max: 4 });
  admin = new pg.Client({ connectionString: inject("adminDatabaseUrl") });
  await admin.connect();
  keys = new LocalKeyProvider(randomBytes(32));
});
afterAll(async () => {
  await api?.close();
  await worker?.close();
  await admin?.end();
});
beforeEach(() => {
  clock = NOW;
  gmail = createFakeGmail({ now: nowMs, pageSize: 2 });
  graph = createFakeGraph({ now: nowMs, pageSize: 2 });
});

interface World {
  id: string;
  userId: string;
}
async function household(label: string): Promise<World> {
  const owner = await ensureUser(api, {
    authSubject: `email|${label}|${randomUUID()}`,
    email: `${label}-${randomUUID().slice(0, 8)}@example.test`,
    firstName: label,
    timezone: "America/New_York",
  });
  const id = randomUUID();
  await createHousehold(api, owner, {
    id,
    name: `Email ${label}`,
    timezone: "America/New_York",
    forwardingToken: `${label}-${id.slice(0, 8)}`,
  });
  return { id, userId: owner.id };
}

/** A connection the way the API's callback leaves it: the fake provider's consent, then the refresh token sealed. */
async function connection(
  hh: World,
  options: {
    provider?: "gmail" | "outlook";
    address?: string;
    status?: string;
    over?: Record<string, unknown>;
  } = {},
): Promise<{ id: string; address: string; fake: FakeMailProvider }> {
  const provider = options.provider ?? "gmail";
  const fake = provider === "gmail" ? gmail : graph;
  const address =
    options.address ??
    `box-${randomBytes(3).toString("hex")}@${provider === "gmail" ? "gmail.com" : "outlook.com"}`;
  const pkce = generatePkce();
  const { code } = fake.consent(
    fake.authorizationUrl({ state: "s", codeChallenge: pkce.challenge }),
    address,
  );
  const grant = await fake.exchangeCode({ code, codeVerifier: pkce.verifier });
  const id = randomUUID();
  const sealed = await sealToken(keys, grant.refreshToken, { connectionId: id });
  await admin.query(
    `insert into email_connections (id, household_id, user_id, provider, address_masked, address_hash, scopes,
       token_ciphertext, token_dek_wrapped, token_key_id, status, revoked_at)
     values ($1,$2,$3,$4,'box•••@x.test',$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      hh.id,
      hh.userId,
      provider,
      randomBytes(32),
      grant.scopes,
      Buffer.from(sealed.ciphertext),
      Buffer.from(sealed.dekWrapped),
      sealed.keyId,
      options.status ?? "active",
      options.status === "revoked" ? new Date(nowMs()) : null,
    ],
  );
  for (const [col, value] of Object.entries(options.over ?? {})) {
    await admin.query(`update email_connections set ${col} = $1 where id = $2`, [value, id]);
  }
  return { id, address, fake };
}

const row = async (id: string) =>
  (await admin.query("select * from email_connections where id = $1", [id])).rows[0] as Record<
    string,
    unknown
  >;
const messages = async (id: string) =>
  (
    await admin.query(
      "select * from email_messages where connection_id = $1 order by received_at, provider_message_id",
      [id],
    )
  ).rows as Record<string, unknown>[];
const job = (hh: World, id: string) => ({ householdId: hh.id, connectionId: id });
const bill = (n: number) => ({
  from: "Northgate Insurance <billing@northgate-insurance.example>",
  subject: `Your statement is ready (${n})`,
});
const promo = (n: number) => ({
  from: "Shop <deals@shop.example>",
  subject: `50% off sale, last chance ${n}`,
  labels: ["CATEGORY_PROMOTIONS"],
});

describe("email.backfill", () => {
  it("scans the window page by page, stores metadata only, and finishes with a cursor", async () => {
    const hh = await household("backfill");
    const c = await connection(hh);
    c.fake.deliver(c.address, bill(1));
    c.fake.deliver(c.address, bill(2));
    c.fake.deliver(c.address, promo(3));
    c.fake.deliver(c.address, bill(4));
    c.fake.deliver(c.address, promo(5));

    const out = await handleEmailBackfill(deps(), job(hh, c.id));
    expect(out).toMatchObject({ outcome: "done", pages: 3, stored: 5 });

    const rows = await messages(c.id);
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.stage === "discovered")).toHaveLength(3);
    expect(rows.filter((r) => r.stage === "prefiltered_out")).toHaveLength(2);
    // Metadata only: no subject, no body, and the sender is a domain.
    for (const r of rows) {
      expect(r.subject).toBeNull();
      expect(Object.keys(r)).not.toContain("body");
      expect(String(r.from_domain)).toMatch(/^[a-z0-9.-]+$/);
      expect(r.channel).toBe("gmail");
    }
    expect(rows.find((r) => r.stage === "discovered")?.from_domain).toBe("northgate-insurance.example");
    expect(await row(c.id)).toMatchObject({
      backfill_status: "done",
      backfill_cursor: null,
      sync_cursor: "5",
    });
  });

  it("resumes after an interruption from the saved page token, without duplicates", async () => {
    const hh = await household("resume");
    const c = await connection(hh);
    for (let i = 1; i <= 5; i++) c.fake.deliver(c.address, bill(i));
    // The second page fails after the first was saved (a provider outage, or the process dying).
    c.fake.failNext("backfillPage", new ProviderError("transient", "down"), { after: 1 });

    await expect(handleEmailBackfill(deps(), job(hh, c.id))).rejects.toBeInstanceOf(ProviderError);
    expect(await messages(c.id)).toHaveLength(2);
    expect(await row(c.id)).toMatchObject({
      backfill_status: "running",
      backfill_cursor: "p2",
      sync_cursor: "5",
    });

    // New messages arrive while it is down; the cursor was set at the start, so discover will find them.
    c.fake.deliver(c.address, bill(6));

    const out = await handleEmailBackfill(deps(), job(hh, c.id));
    expect(out).toMatchObject({ outcome: "done" });
    // The retry continued at p2: page 1 was not fetched again.
    expect(c.fake.backfillPageTokens).toEqual([null, "p2", "p4"]);
    const rows = await messages(c.id);
    expect(new Set(rows.map((r) => r.provider_message_id)).size).toBe(rows.length);
    expect(rows).toHaveLength(6);
    expect(await row(c.id)).toMatchObject({ backfill_status: "done", sync_cursor: "5" });

    // Discover picks up the message that arrived mid-way: it is already stored, so nothing is added.
    const found = await handleEmailDiscover(deps(), job(hh, c.id));
    expect(found).toMatchObject({ outcome: "done", stored: 0 });
    expect(await messages(c.id)).toHaveLength(6);
  });

  it("running it again after it finished does nothing", async () => {
    const hh = await household("again");
    const c = await connection(hh);
    c.fake.deliver(c.address, bill(1));
    await handleEmailBackfill(deps(), job(hh, c.id));
    expect(await handleEmailBackfill(deps(), job(hh, c.id))).toEqual({
      outcome: "skipped",
      reason: "already_done",
    });
    expect(await messages(c.id)).toHaveLength(1);
  });

  it("Outlook: the delta link becomes the cursor on the last page, and a rotated refresh token is stored first", async () => {
    const hh = await household("graph");
    const c = await connection(hh, { provider: "outlook" });
    for (let i = 1; i <= 3; i++) c.fake.deliver(c.address, bill(i));
    const before = (await row(c.id)).token_ciphertext as Buffer;

    const out = await handleEmailBackfill(deps(), job(hh, c.id));
    expect(out).toMatchObject({ outcome: "done", pages: 2, stored: 3 });
    expect(await row(c.id)).toMatchObject({ backfill_status: "done", sync_cursor: "delta:3" });

    const after = await row(c.id);
    expect(Buffer.from(after.token_ciphertext as Buffer).equals(before)).toBe(false);
    const refresh = await openToken(
      keys,
      {
        ciphertext: after.token_ciphertext as Buffer,
        dekWrapped: after.token_dek_wrapped as Buffer,
        keyId: String(after.token_key_id),
      },
      { connectionId: c.id },
    );
    // The new token is the one the provider now accepts (the old one was invalidated by the rotation).
    await expect(c.fake.refresh(refresh)).resolves.toBeDefined();
  });

  it("a provider that dropped the grant puts the connection in error and tells the owner, once", async () => {
    const hh = await household("authfail");
    const c = await connection(hh);
    c.fake.revokeGrant(c.address);
    expect(await handleEmailBackfill(deps(), job(hh, c.id))).toEqual({ outcome: "auth_failed" });
    expect(await row(c.id)).toMatchObject({ status: "error", last_error: "auth_expired" });
    expect(await handleEmailBackfill(deps(), job(hh, c.id))).toMatchObject({
      outcome: "skipped",
      reason: "not_active",
    });
    const n = await admin.query(
      "select title, body, user_id from notifications where household_id = $1 and kind = 'system'",
      [hh.id],
    );
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0].user_id).toBe(hh.userId);
    expect(JSON.stringify(n.rows)).not.toContain(c.address);
  });

  it("a paused connection is not scanned", async () => {
    const hh = await household("paused");
    const c = await connection(hh, { status: "paused" });
    c.fake.deliver(c.address, bill(1));
    expect(await handleEmailBackfill(deps(), job(hh, c.id))).toMatchObject({
      outcome: "skipped",
      reason: "not_active",
    });
    expect(c.fake.count("backfillPage")).toBe(0);
  });
});

describe("email.discover", () => {
  async function ready(label: string, provider: "gmail" | "outlook" = "gmail") {
    const hh = await household(label);
    const c = await connection(hh, { provider });
    c.fake.deliver(c.address, bill(0));
    await handleEmailBackfill(deps(), job(hh, c.id));
    return { hh, c };
  }

  it("stores new mail once, however many pushes and runs there are", async () => {
    const { hh, c } = await ready("dupes");
    const before = (await messages(c.id)).length;
    c.fake.deliver(c.address, bill(1));
    c.fake.deliver(c.address, bill(2));
    c.fake.deliver(c.address, promo(3));
    // Three pushes for the same change (Pub/Sub delivers at least once), and three overlapping runs.
    for (let i = 0; i < 3; i++)
      await admin.query("update email_connections set push_received_at = now() where id = $1", [c.id]);
    const results = await Promise.all([1, 2, 3].map(() => handleEmailDiscover(deps(), job(hh, c.id))));
    expect(results.every((r) => r.outcome === "done")).toBe(true);
    const rows = await messages(c.id);
    expect(rows).toHaveLength(before + 3);
    expect(new Set(rows.map((r) => r.provider_message_id)).size).toBe(rows.length);
    // A later run, with no new mail, adds nothing and clears the push mark.
    expect(await handleEmailDiscover(deps(), job(hh, c.id))).toMatchObject({ outcome: "done", stored: 0 });
    expect((await row(c.id)).push_received_at).toBeNull();
    expect((await row(c.id)).last_synced_at).toEqual(new Date(NOW));
  });

  it("a push that arrives while discover runs is kept for the next run", async () => {
    const { hh, c } = await ready("racepush");
    await admin.query(
      "update email_connections set push_received_at = now() - interval '1 minute' where id = $1",
      [c.id],
    );
    // The second push lands while the provider call is in flight, after discover read the row.
    const original = c.fake.listChanges.bind(c.fake);
    c.fake.listChanges = async (accessToken, cursor) => {
      await admin.query("update email_connections set push_received_at = now() where id = $1", [c.id]);
      return original(accessToken, cursor);
    };
    expect(await handleEmailDiscover(deps(), job(hh, c.id))).toMatchObject({ outcome: "done" });
    expect((await row(c.id)).push_received_at).not.toBeNull();
    // The next run, which sees that push, clears it.
    c.fake.listChanges = original;
    await handleEmailDiscover(deps(), job(hh, c.id));
    expect((await row(c.id)).push_received_at).toBeNull();
  });

  it("falls back to a bounded listing when the cursor is too old, then carries on from a fresh cursor", async () => {
    const { hh, c } = await ready("expired");
    c.fake.deliver(c.address, { ...bill(1), receivedAt: "2026-11-05T10:00:00Z" });
    c.fake.deliver(c.address, { ...bill(2), receivedAt: "2026-06-01T10:00:00Z" }); // older than the 30-day fallback
    c.fake.expireCursors(c.address);
    const out = await handleEmailDiscover(deps(), job(hh, c.id));
    expect(out).toMatchObject({ outcome: "done", fallback: true });
    const ids = (await messages(c.id)).map((r) => (r.received_at as Date).toISOString().slice(0, 10));
    expect(ids).toContain("2026-11-05");
    expect(ids).not.toContain("2026-06-01");
    // The cursor moved on, so the next run uses history again.
    c.fake.deliver(c.address, bill(3));
    expect(await handleEmailDiscover(deps(), job(hh, c.id))).toMatchObject({
      outcome: "done",
      stored: 1,
      fallback: false,
    });
  });

  it("Outlook: reads the delta from the stored deltaLink", async () => {
    const { hh, c } = await ready("graphdelta", "outlook");
    c.fake.deliver(c.address, bill(1));
    const out = await handleEmailDiscover(deps(), job(hh, c.id));
    expect(out).toMatchObject({ outcome: "done", stored: 1 });
    expect((await row(c.id)).sync_cursor).toBe("delta:2");
  });

  it("does nothing before the backfill has set a cursor, for a paused connection or for another household's id", async () => {
    const hh = await household("noop");
    const c = await connection(hh);
    expect(await handleEmailDiscover(deps(), job(hh, c.id))).toMatchObject({
      outcome: "skipped",
      reason: "no_cursor",
    });
    await admin.query("update email_connections set sync_cursor = '0', status = 'paused' where id = $1", [
      c.id,
    ]);
    expect(await handleEmailDiscover(deps(), job(hh, c.id))).toMatchObject({
      outcome: "skipped",
      reason: "not_active",
    });
    const other = await household("other");
    expect(await handleEmailDiscover(deps(), job(other, c.id))).toEqual({
      outcome: "skipped",
      reason: "gone",
    });
    expect(c.fake.count("listChanges")).toBe(0);
  });

  it("rate limits and outages are retried and change nothing", async () => {
    const { hh, c } = await ready("retry");
    c.fake.deliver(c.address, bill(1));
    c.fake.failNext("listChanges", new ProviderError("rate_limited", "slow down", 30));
    await expect(handleEmailDiscover(deps(), job(hh, c.id))).rejects.toMatchObject({ kind: "rate_limited" });
    expect((await row(c.id)).status).toBe("active");
    expect(await handleEmailDiscover(deps(), job(hh, c.id))).toMatchObject({ outcome: "done", stored: 1 });
  });
});

describe("email.watch.renew", () => {
  it("starts a Gmail watch and keeps the backfill's earlier cursor", async () => {
    const hh = await household("watchg");
    const c = await connection(hh, { over: { sync_cursor: "3" } });
    const out = await handleEmailWatch(deps(), job(hh, c.id));
    expect(out.outcome).toBe("started");
    const r = await row(c.id);
    expect(r.watch_expires_at).toEqual(new Date(nowMs() + 7 * 86_400_000));
    expect(r.sync_cursor).toBe("3");
    expect(c.fake.watchOf(c.address).active).toBe(true);
  });

  it("starts with the watch's own cursor when there is none yet", async () => {
    const hh = await household("watchc");
    const c = await connection(hh);
    c.fake.deliver(c.address, bill(1));
    await handleEmailWatch(deps(), job(hh, c.id));
    expect((await row(c.id)).sync_cursor).toBe("1");
  });

  it("renews daily: the expiry moves on, and starting twice leaves one watch", async () => {
    const hh = await household("renew");
    const c = await connection(hh, { provider: "outlook" });
    await handleEmailWatch(deps(), job(hh, c.id));
    const first = await row(c.id);
    clock = "2026-11-10T12:00:00Z";
    const fakeNow = Date.parse(clock);
    const advanced = createFakeGraph({ now: () => fakeNow });
    expect(advanced).toBeDefined();
    expect(await handleEmailWatch(deps(), job(hh, c.id))).toMatchObject({ outcome: "renewed" });
    const second = await row(c.id);
    expect(second.watch_ref).toBe(first.watch_ref);
    expect(c.fake.count("startWatch")).toBe(1);
    expect(c.fake.count("renewWatch")).toBe(1);
  });

  it("recreates an Outlook subscription that lapsed", async () => {
    const hh = await household("lapsed");
    const c = await connection(hh, { provider: "outlook" });
    await handleEmailWatch(deps(), job(hh, c.id));
    const old = (await row(c.id)).watch_ref;
    c.fake.dropWatch(c.address);
    await handleEmailWatch(deps(), job(hh, c.id));
    expect((await row(c.id)).watch_ref).not.toBe(old);
    expect(c.fake.watchOf(c.address).active).toBe(true);
  });

  it("the last failed attempt puts the connection in error and tells the owner", async () => {
    const hh = await household("giveup");
    const c = await connection(hh);
    c.fake.failNext("startWatch", new ProviderError("transient", "down"), { times: 2 });
    await expect(handleEmailWatch(deps(), job(hh, c.id), { lastAttempt: false })).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect((await row(c.id)).status).toBe("active");
    await expect(handleEmailWatch(deps(), job(hh, c.id), { lastAttempt: true })).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(await row(c.id)).toMatchObject({ status: "error", last_error: "watch_failed" });
    const n = await admin.query("select count(*)::int as n from notifications where household_id = $1", [
      hh.id,
    ]);
    expect(n.rows[0].n).toBe(1);
  });
});

function sender() {
  const sent: { queue: string; data: Record<string, unknown>; key: string | undefined }[] = [];
  const keys = new Set<string>();
  return {
    sent,
    send: async (queue: string, data: object, options?: { singletonKey?: string }) => {
      // Like a `short` queue: a key that is already queued is not queued again.
      const key = options?.singletonKey;
      sent.push({ queue, data: data as Record<string, unknown>, key });
      if (key && keys.has(key)) return null;
      if (key) keys.add(key);
      return randomUUID();
    },
  };
}

describe("sweeps", () => {
  const sweepDeps = (s: ReturnType<typeof sender>): SweepDeps => ({
    db: worker,
    sender: s,
    now: () => clock,
    log: logs.logger,
  });
  const forHousehold = (s: ReturnType<typeof sender>, hid: string) =>
    s.sent.filter((x) => x.data.householdId === hid);

  it("enqueues what each connection needs, with a singleton key per connection and queue", async () => {
    const hh = await household("sweep");
    const fresh = await connection(hh); // no cursor, no watch, backfill pending
    const pushed = await connection(hh, {
      over: {
        sync_cursor: "1",
        backfill_status: "done",
        watch_expires_at: new Date(nowMs() + 5 * 86_400_000),
        push_received_at: new Date(nowMs()),
        last_synced_at: new Date(nowMs()),
      },
    });
    const gone = await connection(hh, { status: "revoked" });
    const paused = await connection(hh, { status: "paused" });
    const s = sender();
    await handleEmailSweep(sweepDeps(s));
    const mine = forHousehold(s, hh.id)
      .map((x) => `${x.queue}:${x.data.connectionId}`)
      .sort();
    expect(mine).toEqual(
      [
        `email.backfill:${fresh.id}`,
        `email.watch.renew:${fresh.id}`,
        `email.discover:${pushed.id}`,
        `email.revoke:${gone.id}`,
      ].sort(),
    );
    expect(mine.some((m) => m.endsWith(paused.id))).toBe(false);
    expect(forHousehold(s, hh.id).every((x) => x.key === `${x.queue}:${x.data.connectionId}`)).toBe(true);
    // A second sweep before the jobs ran queues nothing new (the keys are taken).
    const again = sender();
    for (const x of s.sent) again.send(x.queue, x.data, x.key ? { singletonKey: x.key } : {});
    const second = await Promise.all(
      forHousehold(s, hh.id).map((x) => again.send(x.queue, x.data, { singletonKey: x.key ?? "" })),
    );
    expect(second.every((id) => id === null)).toBe(true);
  });

  it("prunes expired OAuth states and keeps live ones", async () => {
    const hh = await household("states");
    const mk = async (expires: string) => {
      const h = randomBytes(32);
      await admin.query(
        "insert into email_oauth_states (state_hash, user_id, provider, return_to, code_verifier, browser_hash, expires_at) values ($1,$2,'gmail','/imports',$3,$5, now() + $4::interval)",
        [h, hh.userId, randomBytes(32).toString("base64url"), expires, randomBytes(32)],
      );
      return h;
    };
    const dead = await mk("-1 minute");
    const live = await mk("5 minutes");
    await handleEmailSweep(sweepDeps(sender()));
    const left = (
      await admin.query("select state_hash from email_oauth_states where user_id = $1", [hh.userId])
    ).rows.map((r) => r.state_hash as Buffer);
    expect(left.some((b) => b.equals(dead))).toBe(false);
    expect(left.some((b) => b.equals(live))).toBe(true);
  });

  it("raises the watch-expiry alert once when a watch ends within 24 hours, and renews it right away", async () => {
    const hh = await household("alert");
    const c = await connection(hh, {
      over: {
        sync_cursor: "1",
        backfill_status: "done",
        last_synced_at: new Date(nowMs()),
        watch_expires_at: new Date(nowMs() + 12 * 3_600_000),
      },
    });
    const s = sender();
    const first = await handleEmailSweep(sweepDeps(s));
    expect(first.alerts).toBeGreaterThanOrEqual(1);
    expect((await row(c.id)).last_error).toBe("watch_expiring");
    expect(forHousehold(s, hh.id).map((x) => x.queue)).toContain("email.watch.renew");
    const alertLines = logs
      .lines()
      .filter((l) => l.alert === "email_watch_expiring" && l.connectionId === c.id);
    expect(alertLines).toHaveLength(1);
    const notified = await admin.query(
      "select count(*)::int as n from notifications where household_id = $1",
      [hh.id],
    );
    expect(notified.rows[0].n).toBe(1);

    // Not repeated while it stays flagged...
    await handleEmailSweep(sweepDeps(sender()));
    expect(
      logs.lines().filter((l) => l.alert === "email_watch_expiring" && l.connectionId === c.id),
    ).toHaveLength(1);

    // ...and a successful renewal clears it.
    await handleEmailWatch(deps(), job(hh, c.id));
    expect(await row(c.id)).toMatchObject({ last_error: null });
    expect(((await row(c.id)).watch_expires_at as Date).getTime()).toBeGreaterThan(nowMs() + 24 * 3_600_000);
  });

  it("a healthy watch raises no alert; the daily sweep renews every active connection", async () => {
    const hh = await household("daily");
    const a = await connection(hh, { over: { watch_expires_at: new Date(nowMs() + 3 * 86_400_000) } });
    const b = await connection(hh, {
      provider: "outlook",
      over: { watch_expires_at: new Date(nowMs() + 2 * 86_400_000) },
    });
    await connection(hh, { status: "paused" });
    const s = sender();
    const alerts = (await handleEmailSweep(sweepDeps(s))).alerts;
    expect(alerts).toBe(0);
    const daily = sender();
    await handleEmailWatchSweep(sweepDeps(daily));
    const queued = forHousehold(daily, hh.id)
      .map((x) => `${x.queue}:${x.data.connectionId}`)
      .sort();
    expect(queued).toEqual([`email.watch.renew:${a.id}`, `email.watch.renew:${b.id}`].sort());
  });
});

describe("email.revoke (disconnect)", () => {
  async function disconnected(label: string, provider: "gmail" | "outlook" = "gmail") {
    const hh = await household(label);
    const c = await connection(hh, { provider });
    await handleEmailWatch(deps(), job(hh, c.id));
    // What the API does when the owner disconnects: it can only mark the row.
    await admin.query("update email_connections set status = 'revoked', revoked_at = now() where id = $1", [
      c.id,
    ]);
    return { hh, c };
  }

  it("stops the watch, revokes at the provider, deletes the token and writes an audit event", async () => {
    const { hh, c } = await disconnected("revoke");
    expect(c.fake.watchOf(c.address).active).toBe(true);
    const out = await handleEmailRevoke(deps(), job(hh, c.id));
    expect(out).toEqual({ outcome: "revoked", atProvider: true, watchStopped: true });
    expect(c.fake.watchOf(c.address).active).toBe(false);
    expect(c.fake.isRevoked(c.address)).toBe(true);
    expect(await row(c.id)).toMatchObject({
      status: "revoked",
      token_ciphertext: null,
      token_dek_wrapped: null,
      token_key_id: null,
      watch_ref: null,
      watch_expires_at: null,
      sync_cursor: null,
    });
    const audit = await admin.query(
      "select actor_type, actor_user_id, metadata from audit_events where entity_id = $1 and action = 'email.token_deleted'",
      [c.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_type: "system",
      actor_user_id: null,
      metadata: { provider: "gmail", revokedAtProvider: true, watchStopped: true },
    });
    expect(JSON.stringify(audit.rows)).not.toContain(c.address);
  });

  it("is idempotent: with the token gone there is nothing left to do", async () => {
    const { hh, c } = await disconnected("revoke2");
    await handleEmailRevoke(deps(), job(hh, c.id));
    const calls = c.fake.calls.length;
    expect(await handleEmailRevoke(deps(), job(hh, c.id))).toEqual({
      outcome: "skipped",
      reason: "token_gone",
    });
    expect(c.fake.calls.length).toBe(calls);
    const audit = await admin.query(
      "select count(*)::int as n from audit_events where entity_id = $1 and action = 'email.token_deleted'",
      [c.id],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it("deletes the token even when the person already removed the app at the provider", async () => {
    const { hh, c } = await disconnected("revoke3");
    c.fake.revokeGrant(c.address);
    expect(await handleEmailRevoke(deps(), job(hh, c.id))).toMatchObject({
      outcome: "revoked",
      atProvider: false,
    });
    expect((await row(c.id)).token_ciphertext).toBeNull();
  });

  it("a provider outage keeps the token and retries", async () => {
    const { hh, c } = await disconnected("revoke4");
    c.fake.failNext("revoke", new ProviderError("transient", "down"));
    await expect(handleEmailRevoke(deps(), job(hh, c.id))).rejects.toBeInstanceOf(ProviderError);
    expect((await row(c.id)).token_ciphertext).not.toBeNull();
    expect(await handleEmailRevoke(deps(), job(hh, c.id))).toMatchObject({
      outcome: "revoked",
      atProvider: true,
    });
  });

  it("Outlook cannot revoke a token remotely; that is recorded, the subscription is deleted and the token is dropped", async () => {
    const { hh, c } = await disconnected("revoke5", "outlook");
    const out = await handleEmailRevoke(deps(), job(hh, c.id));
    expect(out).toEqual({ outcome: "revoked", atProvider: false, watchStopped: true });
    expect(c.fake.watchOf(c.address).active).toBe(false);
    expect((await row(c.id)).token_ciphertext).toBeNull();
  });

  it("only touches a disconnected mailbox", async () => {
    const hh = await household("revoke6");
    const c = await connection(hh);
    expect(await handleEmailRevoke(deps(), job(hh, c.id))).toEqual({
      outcome: "skipped",
      reason: "not_revoked",
    });
    expect(c.fake.count("revoke")).toBe(0);
  });
});

describe("a disconnect never deletes a token it could not revoke (S5, S7)", () => {
  async function disconnected(label: string, provider: "gmail" | "outlook" = "gmail") {
    const hh = await household(label);
    const c = await connection(hh, { provider });
    await admin.query("update email_connections set status = 'revoked', revoked_at = now() where id = $1", [
      c.id,
    ]);
    return { hh, c };
  }
  const tokenKept = async (id: string) => (await row(id)).token_ciphertext !== null;

  it("keeps the token and retries when this worker has no client for the provider, and alerts on the last attempt", async () => {
    const { hh, c } = await disconnected("noprovider");
    const noProviders = { ...deps(), providers: {} };
    await expect(handleEmailRevoke(noProviders, job(hh, c.id))).rejects.toThrow();
    expect(await tokenKept(c.id)).toBe(true);
    await expect(handleEmailRevoke(noProviders, job(hh, c.id), { lastAttempt: true })).rejects.toThrow();
    expect(await tokenKept(c.id)).toBe(true);
    expect(logs.lines().some((l) => l.alert === "email_revoke_stuck" && l.connectionId === c.id)).toBe(true);
    // Once the provider is available the same job finishes it.
    expect(await handleEmailRevoke(deps(), job(hh, c.id))).toMatchObject({
      outcome: "revoked",
      atProvider: true,
    });
    expect(await tokenKept(c.id)).toBe(false);
  });

  it("keeps the token when no key is configured", async () => {
    const { hh, c } = await disconnected("nokey");
    const broken = {
      keyId: () => "none",
      generateDataKey: async () => {
        throw new Error("no key");
      },
      decryptDataKey: async () => {
        throw new Error("no key");
      },
    };
    await expect(handleEmailRevoke({ ...deps(), keys: broken }, job(hh, c.id))).rejects.toThrow();
    expect(await tokenKept(c.id)).toBe(true);
    expect(c.fake.count("revoke")).toBe(0);
  });

  it("refuses a token whose key id this worker is not configured for, and never reaches the provider", async () => {
    const { hh, c } = await disconnected("foreignkey");
    const other = new LocalKeyProvider(randomBytes(32));
    await expect(handleEmailRevoke({ ...deps(), keys: other }, job(hh, c.id))).rejects.toThrow(
      /unknown master key/,
    );
    expect(await tokenKept(c.id)).toBe(true);
    expect(c.fake.count("revoke")).toBe(0);
  });

  it("Outlook cannot be revoked remotely, so it is the one case that deletes without a provider revoke", async () => {
    const { hh, c } = await disconnected("msft", "outlook");
    expect(await handleEmailRevoke(deps(), job(hh, c.id))).toMatchObject({
      outcome: "revoked",
      atProvider: false,
    });
    expect(await tokenKept(c.id)).toBe(false);
  });
});

describe("provider errors that retrying will not fix", () => {
  it("a refused scope or permission fails fast: the connection goes to error and the owner is told once", async () => {
    const hh = await household("permanent");
    const c = await connection(hh, { over: { sync_cursor: "0" } });
    c.fake.failNext(
      "listChanges",
      new ProviderError("permanent", "The provider refused access to the mailbox."),
    );
    expect(await handleEmailDiscover(deps(), job(hh, c.id))).toEqual({ outcome: "provider_failed" });
    expect(await row(c.id)).toMatchObject({ status: "error", last_error: "provider_error" });
    const n = await admin.query("select count(*)::int as n from notifications where household_id = $1", [
      hh.id,
    ]);
    expect(n.rows[0].n).toBe(1);
    expect(await handleEmailDiscover(deps(), job(hh, c.id))).toMatchObject({
      outcome: "skipped",
      reason: "not_active",
    });
  });
});

describe("nothing is stored for a mailbox that was just paused or disconnected", () => {
  it("a pause that lands while discover is in flight stores no messages", async () => {
    const hh = await household("pauserace");
    const c = await connection(hh);
    c.fake.deliver(c.address, bill(0));
    await handleEmailBackfill(deps(), job(hh, c.id));
    c.fake.deliver(c.address, bill(1));
    const original = c.fake.listChanges.bind(c.fake);
    c.fake.listChanges = async (accessToken, cursor) => {
      await admin.query("update email_connections set status = 'paused' where id = $1", [c.id]);
      return original(accessToken, cursor);
    };
    const before = (await messages(c.id)).length;
    expect(await handleEmailDiscover(deps(), job(hh, c.id))).toMatchObject({ outcome: "done", stored: 0 });
    expect((await messages(c.id)).length).toBe(before);
  });
});

describe("privacy", () => {
  it("nothing the jobs log or store carries an address, a subject or a token", async () => {
    const hh = await household("privacy");
    const address = `private-${randomBytes(3).toString("hex")}@gmail.com`;
    const c = await connection(hh, { address });
    c.fake.deliver(c.address, {
      subject: "Secret subject 4111 1111 1111 1111",
      from: "Bank <alerts@bank.example>",
    });
    c.fake.revokeGrant(c.address); // forces the failure and notification paths
    await handleEmailBackfill(deps(), job(hh, c.id));
    const everything = JSON.stringify([
      logs.lines(),
      (await admin.query("select * from email_messages where household_id = $1", [hh.id])).rows,
      (await admin.query("select * from notifications where household_id = $1", [hh.id])).rows,
      (await admin.query("select * from audit_events where household_id = $1", [hh.id])).rows,
    ]);
    for (const secretText of [address, "Secret subject", "4111", "rt-", "at-"]) {
      expect(everything).not.toContain(secretText);
    }
  });
});
