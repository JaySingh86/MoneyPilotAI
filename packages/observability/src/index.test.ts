import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./index";

function capture() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { log: createLogger("test", "info", sink), out: () => lines.join("") };
}

const SECRETS = [
  "sam@example.com",
  "rt-secret",
  "68400",
  "150701",
  "Northgate renewal offer",
  "oauth-code-123",
];

describe("createLogger redaction (CLAUDE.md hard rule 8)", () => {
  it("redacts sensitive keys at the root", () => {
    const { log, out } = capture();
    log.info({ email: "sam@example.com", refreshToken: "rt-secret", amountCents: 68400 }, "root");
    for (const s of SECRETS.slice(0, 3)) expect(out()).not.toContain(s);
  });

  it("redacts sensitive keys one and two levels deep", () => {
    const { log, out } = capture();
    log.info(
      {
        user: { email: "sam@example.com" },
        plan: { lowest: { balanceCents: 150701 } },
        msg: { subject: "Northgate renewal offer" },
        req: { query: { code: "oauth-code-123" } },
      },
      "nested",
    );
    for (const s of SECRETS) expect(out()).not.toContain(s);
  });

  it("drops error messages unless the error is marked safe to expose", () => {
    const { log, out } = capture();
    log.error({ err: new Error("could not parse amount 68400 for sam@example.com") }, "boom");
    expect(out()).not.toContain("sam@example.com");
    expect(out()).not.toContain("68400");
    expect(out()).toContain('"type":"Error"');

    const safe = Object.assign(new Error("Invite expired"), { expose: true, code: "invite_expired" });
    log.error({ err: safe }, "expected");
    expect(out()).toContain("Invite expired");
    expect(out()).toContain("invite_expired");
  });

  it("keeps non-sensitive context", () => {
    const { log, out } = capture();
    log.info({ householdId: "hh-rivera", job: "plan.recompute" }, "ok");
    expect(out()).toContain("hh-rivera");
    expect(out()).toContain("plan.recompute");
  });
});

describe("auth field names (WP-33)", () => {
  const AUTH_KEYS = [
    "refresh_token",
    "access_token",
    "id_token",
    "token_hash",
    "tokenHash",
    "newPassword",
    "mfaCode",
    "otpauthUri",
    "secret",
    "challengeId",
    "error_description",
    "refreshToken",
    "accessToken",
    "password",
  ];

  it.each(AUTH_KEYS)("redacts %s at the root, one and two levels deep", (key) => {
    const { log, out } = capture();
    log.info({ [key]: "LEAK-root", a: { [key]: "LEAK-one" }, b: { c: { [key]: "LEAK-two" } } }, "auth");
    expect(out()).not.toContain("LEAK");
    expect(out()).toContain("[redacted]");
  });
});
