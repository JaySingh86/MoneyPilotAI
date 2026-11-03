import { describe, expect, it } from "vitest";
import { assertLocalSeedTarget, SeedTargetError } from "./guard";

const local = "postgres://mp_api:pw@localhost:5432/moneypilot";

describe("assertLocalSeedTarget (G1 L-5)", () => {
  it("allows local databases outside production", () => {
    expect(() => assertLocalSeedTarget({}, [local, "postgres://u:p@127.0.0.1:5432/x"])).not.toThrow();
    expect(() => assertLocalSeedTarget({ NODE_ENV: "development" }, [local])).not.toThrow();
  });

  it("refuses NODE_ENV=production even for a local URL", () => {
    expect(() => assertLocalSeedTarget({ NODE_ENV: "production" }, [local])).toThrow(SeedTargetError);
  });

  it("refuses a remote host, and any remote URL among several", () => {
    const rds = "postgres://u:p@mp.abc123.us-east-1.rds.amazonaws.com:5432/moneypilot";
    expect(() => assertLocalSeedTarget({}, [rds])).toThrow(/not a local database host/);
    expect(() => assertLocalSeedTarget({}, [local, rds])).toThrow(SeedTargetError);
  });

  it("refuses an unparsable URL without echoing it (it may hold a password)", () => {
    expect(() => assertLocalSeedTarget({}, ["not a url with secret"])).toThrow(/not valid/);
    try {
      assertLocalSeedTarget({}, ["postgres://u:secretpw@@@host"]);
    } catch (e) {
      expect(String(e)).not.toContain("secretpw");
    }
  });
});
