// Connection settings shared by every pg pool, client and pg-boss (ADR-020).
//
// TLS policy:
//   - Hosts ending `.supabase.com` / `.supabase.co` are always connected over TLS and VERIFIED: the certificate must
//     chain to Supabase's published root CA (packages/db/certs/supabase-ca.crt, plus Node's public roots in case the
//     pooler uses one) and match the host name. `sslmode` in the URL does not weaken that.
//   - Encrypt-without-verify exists only behind an explicit `MP_DB_TLS_INSECURE=1`, for debugging, and callers warn.
//   - Other remote hosts keep node-postgres's own rule: `sslmode=require|verify-full` verify the server.
//   - With NODE_ENV=production, a database that is not on this machine must be verified, or the process refuses to
//     start (`DbTlsError`).
//   - Local docker URLs carry no `sslmode` and stay plain.
import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import type { ClientConfig } from "pg";

export class DbTlsError extends Error {
  override readonly name = "DbTlsError";
}

export type TlsMode = "local" | "verified" | "insecure" | "plain";

interface TlsEnv {
  NODE_ENV?: string | undefined;
  MP_DB_TLS_INSECURE?: string | undefined;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SUPABASE_HOST = /(^|\.)supabase\.(com|co)$/i;
const STRIPPED_PARAMS = ["sslmode", "uselibpqcompat", "sslrootcert", "sslcert", "sslkey"];

let supabaseCa: string | undefined;
/** Supabase's root CA followed by Node's public roots. Read once. */
function caBundle(): string[] {
  supabaseCa ??= readFileSync(new URL("../certs/supabase-ca.crt", import.meta.url), "utf8");
  return [supabaseCa, ...rootCertificates];
}

function parse(connectionString: string): URL | null {
  try {
    return new URL(connectionString);
  } catch {
    return null;
  }
}

const isInsecureRequested = (env: TlsEnv): boolean => env.MP_DB_TLS_INSECURE === "1";

/** How a connection string will be secured, without connecting. */
export function tlsMode(connectionString: string, env: TlsEnv = process.env): TlsMode {
  const url = parse(connectionString);
  if (!url) return "plain";
  const host = url.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return "local";
  if (SUPABASE_HOST.test(host)) return isInsecureRequested(env) ? "insecure" : "verified";
  const sslmode = url.searchParams.get("sslmode");
  // Only an explicit verify-full (without libpq-compat, which makes `require` encrypt-only) counts as verified for
  // a non-Supabase host; pgConfig then supplies `rejectUnauthorized: true` itself rather than relying on how a
  // pg-connection-string version reads sslmode aliases. `require`/`verify-ca` are not trusted as verified.
  const libpqCompat = url.searchParams.get("uselibpqcompat") === "true";
  if (sslmode === "verify-full" && !libpqCompat) return isInsecureRequested(env) ? "insecure" : "verified";
  if (sslmode === "require" || sslmode === "verify-ca" || sslmode === "verify-full") {
    return isInsecureRequested(env) ? "insecure" : "plain";
  }
  return "plain";
}

/** The warning to log at startup when any URL is encrypted without verification, else null. Never includes a URL. */
export function tlsWarning(connectionStrings: readonly string[], env: TlsEnv = process.env): string | null {
  return connectionStrings.some((c) => tlsMode(c, env) === "insecure")
    ? "MP_DB_TLS_INSECURE=1: database connections are encrypted but the server certificate is NOT verified. For debugging only."
    : null;
}

/** pg Pool/Client/pg-boss options for a connection string, with the TLS policy above applied. */
export function pgConfig(connectionString: string, env: TlsEnv = process.env): ClientConfig {
  const mode = tlsMode(connectionString, env);
  if (env.NODE_ENV === "production" && (mode === "plain" || mode === "insecure")) {
    throw new DbTlsError(
      mode === "insecure"
        ? "MP_DB_TLS_INSECURE is not allowed in production: remote database connections must be verified."
        : "Remote database connections must be verified in production: use a Supabase host, or sslmode=verify-full.",
    );
  }
  const url = parse(connectionString);
  if (!url || mode === "local" || mode === "plain") return { connectionString };

  const host = url.hostname.toLowerCase();
  const stripped = new URL(url);
  for (const param of STRIPPED_PARAMS) stripped.searchParams.delete(param);
  if (mode === "verified" && !SUPABASE_HOST.test(host)) {
    // Another verify-full host: Node's public roots, verification forced explicitly.
    return { connectionString: stripped.toString(), ssl: { rejectUnauthorized: true } };
  }
  return {
    connectionString: stripped.toString(),
    ssl: mode === "insecure" ? { rejectUnauthorized: false } : { ca: caBundle(), rejectUnauthorized: true },
  };
}

/** Role-qualified pooler user: `mp_api.<project-ref>` -> `{ role: "mp_api", suffix: ".<ref>" }`. */
export function splitPoolerUser(user: string): { role: string; suffix: string } {
  const dot = user.indexOf(".");
  return dot === -1 ? { role: user, suffix: "" } : { role: user.slice(0, dot), suffix: user.slice(dot) };
}

/** The same connection string with another role, keeping a Supavisor `.<ref>` suffix. */
export function urlForRole(connectionString: string, role: string, password: string): string {
  const url = new URL(connectionString);
  const { suffix } = splitPoolerUser(decodeURIComponent(url.username));
  url.username = `${role}${suffix}`;
  url.password = password;
  return url.toString();
}
