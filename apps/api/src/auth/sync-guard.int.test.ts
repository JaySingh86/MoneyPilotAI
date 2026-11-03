// M1: the app_sync_auth_user guard must fail CLOSED. Invite security depends on it (users.email is what
// invites are matched against), so it must hold for any login role that is not mp_worker, including a
// different login that runs `SET ROLE mp_api`.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createTestApi, type TestApi } from "./testing/app";

let api: TestApi;
let other: pg.Client;
const LOGIN = `mp_test_login_${randomUUID().slice(0, 8)}`;

function urlFor(role: string): string {
  const url = new URL(inject("apiDatabaseUrl"));
  url.username = role;
  url.password = "pw";
  return url.toString();
}

beforeAll(async () => {
  api = await createTestApi();
  await api.admin(async (c) => {
    await c.query(`create role ${LOGIN} login password 'pw'`);
    await c.query(`grant mp_api to ${LOGIN}`);
  });
  other = new pg.Client({ connectionString: urlFor(LOGIN) });
  await other.connect();
});
afterAll(async () => {
  await other.end();
  await api.admin((c) => c.query(`drop owned by ${LOGIN}; drop role ${LOGIN}`));
  await api.close();
});

async function sync(subject: string, target: string, email: string, deleted = false) {
  await other.query("begin");
  try {
    await other.query("set local role mp_api");
    await other.query("select set_config('app.auth_subject', $1, true)", [subject]);
    return await other.query("select app_sync_auth_user($1, $2, true, $3) as ok", [target, email, deleted]);
  } finally {
    await other.query("rollback");
  }
}

describe("app_sync_auth_user fails closed", () => {
  it("a different login role running SET ROLE mp_api cannot sync another subject", async () => {
    const victim = await api.signUp("guard-victim");
    const me = await api.signUp("guard-me");
    await expect(sync(me.subject, victim.subject, "stolen@example.test")).rejects.toMatchObject({
      code: "42501",
    });
    const stored = await api.admin(
      async (c) => (await c.query("select email::text as e from users where id = $1", [victim.id])).rows[0].e,
    );
    expect(stored).toBe(victim.email);
  });

  it("nor with no subject in the session, nor delete even its own subject", async () => {
    const me = await api.signUp("guard-own");
    await expect(sync("", me.subject, "x@example.test")).rejects.toMatchObject({ code: "42501" });
    await expect(sync(me.subject, me.subject, "x@example.test", true)).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("its own subject still works through that login role", async () => {
    const me = await api.signUp("guard-ok");
    const res = await sync(me.subject, me.subject, "renamed@example.test");
    expect(res.rows[0]).toEqual({ ok: true });
  });
});
