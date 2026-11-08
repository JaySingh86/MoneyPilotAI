import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { DbTlsError, pgConfig, splitPoolerUser, tlsMode, tlsWarning, urlForRole } from "./connection";

const POOLER = "postgresql://mp_api.abcdref:p%40ss@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
const DIRECT = "postgresql://mp_api:pw@db.abcdref.supabase.co:5432/postgres";
const LOCAL = "postgres://mp_api:x@localhost:5432/moneypilot";
const OTHER = "postgres://mp_api:x@db.internal.example.com:5432/moneypilot";
const SUPABASE_CA_SHA256 =
  "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA";

describe("the committed Supabase CA", () => {
  it("is Supabase Root 2021 CA, unchanged", () => {
    const cert = new X509Certificate(readFileSync(new URL("../certs/supabase-ca.crt", import.meta.url)));
    expect(cert.subject).toContain("CN=Supabase Root 2021 CA");
    expect(cert.fingerprint256).toBe(SUPABASE_CA_SHA256);
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("pgConfig: Supabase hosts verify the server by default", () => {
  for (const [name, url] of [
    ["session pooler", POOLER],
    ["direct", DIRECT],
  ] as const) {
    it(`${name}: trusts the Supabase CA plus the public roots, with verification on`, () => {
      const config = pgConfig(`${url}?sslmode=require`, {});
      const ssl = config.ssl as { ca: string[]; rejectUnauthorized: boolean };
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(ssl.ca).toContain(readFileSync(new URL("../certs/supabase-ca.crt", import.meta.url), "utf8"));
      expect(ssl.ca.length).toBe(rootCertificates.length + 1);
      // sslmode is stripped: node-postgres would otherwise let it override the ssl object.
      expect(config.connectionString).not.toMatch(/sslmode|uselibpqcompat|sslrootcert/);
      expect(new URL(config.connectionString as string).username).toBe(new URL(url).username);
    });
  }

  it("applies even when the URL says nothing about TLS", () => {
    expect(pgConfig(POOLER, {}).ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it("is what node-postgres ends up with", () => {
    const client = new pg.Client(pgConfig(`${POOLER}?sslmode=require`, {}));
    const ssl = (client as unknown as { connectionParameters: { ssl: { rejectUnauthorized: boolean } } })
      .connectionParameters.ssl;
    expect(ssl.rejectUnauthorized).toBe(true);
  });

  it("does not trust a lookalike host", () => {
    expect(tlsMode("postgres://u:p@db.x.supabase.co.evil.com:5432/postgres", {})).toBe("plain");
    expect(tlsMode("postgres://u:p@notsupabase.co:5432/postgres", {})).toBe("plain");
  });
});

describe("pgConfig: encrypt-without-verify is opt-in", () => {
  it("MP_DB_TLS_INSECURE=1 turns verification off on Supabase hosts and reports it", () => {
    const env = { MP_DB_TLS_INSECURE: "1" };
    const config = pgConfig(`${POOLER}?sslmode=require`, env);
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
    expect(config.connectionString).not.toMatch(/sslmode/);
    expect(tlsMode(POOLER, env)).toBe("insecure");
    expect(tlsWarning([POOLER, LOCAL], env)).toMatch(/MP_DB_TLS_INSECURE/);
  });

  it("only the exact value 1 counts", () => {
    expect(tlsMode(POOLER, { MP_DB_TLS_INSECURE: "true" })).toBe("verified");
    expect(tlsWarning([POOLER], {})).toBeNull();
  });

  it("local databases never warn", () => {
    expect(tlsWarning([LOCAL], { MP_DB_TLS_INSECURE: "1" })).toBeNull();
    expect(pgConfig(LOCAL, {}).ssl).toBeUndefined();
    expect(pgConfig(LOCAL, {}).connectionString).toBe(LOCAL);
  });
});

describe("pgConfig: other remote hosts", () => {
  it("only an explicit verify-full counts as verified, and verification is forced explicitly", () => {
    expect(tlsMode(`${OTHER}?sslmode=verify-full`, {})).toBe("verified");
    expect(pgConfig(`${OTHER}?sslmode=verify-full`, {}).ssl).toEqual({ rejectUnauthorized: true });
    expect(tlsMode(`${OTHER}?sslmode=require`, {})).toBe("plain");
    expect(tlsMode(`${OTHER}?sslmode=verify-ca`, {})).toBe("plain");
    expect(tlsMode(`${OTHER}?sslmode=verify-full&uselibpqcompat=true`, {})).toBe("plain");
    expect(tlsMode(`${OTHER}?sslmode=require&uselibpqcompat=true`, {})).toBe("plain");
  });

  it("production refuses sslmode=require or libpq-compat on a non-Supabase host (not proven verified)", () => {
    const prod = { NODE_ENV: "production" };
    expect(() => pgConfig(`${OTHER}?sslmode=require`, prod)).toThrow(DbTlsError);
    expect(() => pgConfig(`${OTHER}?sslmode=require&uselibpqcompat=true`, prod)).toThrow(DbTlsError);
  });

  it("MP_DB_TLS_INSECURE=1 makes sslmode=require encrypt-only", () => {
    const config = pgConfig(`${OTHER}?sslmode=require`, { MP_DB_TLS_INSECURE: "1" });
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("sslmode=disable and no sslmode count as plain", () => {
    expect(tlsMode(OTHER, {})).toBe("plain");
    expect(tlsMode(`${OTHER}?sslmode=disable`, {})).toBe("plain");
  });
});

describe("pgConfig in production", () => {
  const prod = { NODE_ENV: "production" };
  it("refuses a remote database whose TLS is not verified", () => {
    expect(() => pgConfig(OTHER, prod)).toThrow(DbTlsError);
    expect(() => pgConfig(`${OTHER}?sslmode=disable`, prod)).toThrow(/verified/);
    expect(() => pgConfig(POOLER, { ...prod, MP_DB_TLS_INSECURE: "1" })).toThrow(DbTlsError);
    expect(() => pgConfig(`${OTHER}?sslmode=require`, { ...prod, MP_DB_TLS_INSECURE: "1" })).toThrow(
      DbTlsError,
    );
  });
  it("accepts verified remote and any local database", () => {
    expect(() => pgConfig(POOLER, prod)).not.toThrow();
    expect(() => pgConfig(`${OTHER}?sslmode=verify-full`, prod)).not.toThrow();
    expect(() => pgConfig(LOCAL, prod)).not.toThrow();
    expect(() => pgConfig("postgres://u:p@127.0.0.1/db", prod)).not.toThrow();
  });
  it("the error never contains the password", () => {
    try {
      pgConfig("postgres://u:topsecret@db.internal.example.com/db", prod);
    } catch (error) {
      expect(String(error)).not.toContain("topsecret");
    }
  });
});

describe("pooler user names", () => {
  it("splits and rebuilds the role-qualified user", () => {
    expect(splitPoolerUser("mp_api.abcdref")).toEqual({ role: "mp_api", suffix: ".abcdref" });
    expect(splitPoolerUser("mp_api")).toEqual({ role: "mp_api", suffix: "" });
    const admin = "postgresql://postgres.abcdref:adminpw@host:5432/postgres?sslmode=require";
    const worker = new URL(urlForRole(admin, "mp_worker", "a/b+c"));
    expect(worker.username).toBe("mp_worker.abcdref");
    expect(decodeURIComponent(worker.password)).toBe("a/b+c");
    expect(worker.searchParams.get("sslmode")).toBe("require");
  });

  it("keeps a plain local user plain", () => {
    expect(new URL(urlForRole("postgres://postgres:x@localhost/db", "mp_api", "pw")).username).toBe("mp_api");
  });
});
