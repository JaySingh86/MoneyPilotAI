import { afterEach, describe, expect, it } from "vitest";
import { modules } from "../../modules";
import { buildServer, type ApiServer } from "../../server";
import { bearer, expectProblem, fakeAuthenticate, HOUSEHOLD_1, USER_A } from "../testing";
import { exampleModule } from "./example-routes";

let app: ApiServer;
afterEach(async () => {
  await app?.close();
});

const base = `/v1/households/${HOUSEHOLD_1}/example-notes`;
const body = { title: "Car registration", amountCents: 18500, dueOn: "2026-11-20" };

function server() {
  app = buildServer({ authenticate: fakeAuthenticate, modules: [exampleModule()] });
  return app;
}

function create(key = "create-1") {
  return app.inject({
    method: "POST",
    url: base,
    headers: { ...bearer(USER_A), "idempotency-key": key },
    payload: body,
  });
}

describe("example module (route recipe)", () => {
  it("creates with an Idempotency-Key, Location and ETag, and replays a retry", async () => {
    server();
    const first = await create();
    expect(first.statusCode).toBe(201);
    expect(first.headers.etag).toBe('"1"');
    expect(first.headers.location).toBe(`${base}/${first.json().id}`);
    const retry = await create();
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.json().id).toBe(first.json().id);
  });

  it("requires the Idempotency-Key on create", async () => {
    server();
    const res = await app.inject({ method: "POST", url: base, headers: bearer(USER_A), payload: body });
    expectProblem(res, 400, "validation_failed");
  });

  it("updates with If-Match and answers a stale version with 409 and the current note", async () => {
    server();
    const note = (await create()).json();
    const patch = (version: string) =>
      app.inject({
        method: "PATCH",
        url: `${base}/${note.id}`,
        headers: { ...bearer(USER_A), "if-match": version },
        payload: { amountCents: 19000 },
      });
    const ok = await patch('"1"');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json()).toMatchObject({ amountCents: 19000, version: 2 });
    const stale = expectProblem(await patch('"1"'), 409, "conflict");
    expect(stale.current).toMatchObject({ version: 2 });
    expectProblem(
      await app.inject({ method: "PATCH", url: `${base}/${note.id}`, headers: bearer(USER_A), payload: {} }),
      428,
      "precondition_required",
    );
  });

  it("validates money as integer cents and dates as YYYY-MM-DD", async () => {
    server();
    const res = await app.inject({
      method: "POST",
      url: base,
      headers: { ...bearer(USER_A), "idempotency-key": "bad" },
      payload: { title: "x", amountCents: 185.5, dueOn: "11/20/2026" },
    });
    const problem = expectProblem(res, 400, "validation_failed");
    expect(problem.fields?.map((f) => f.path).sort()).toEqual(["amountCents", "dueOn"]);
  });

  it("shares the auth-sensitive budget", async () => {
    server();
    for (let i = 0; i < 20; i += 1) expect((await create(`k-${i}`)).statusCode).toBe(201);
    expectProblem(await create("k-20"), 429, "rate_limited");
  });

  it("is not in the module registry, so it is never served", () => {
    expect(modules.map((m) => m.name)).not.toContain("example");
  });
});
