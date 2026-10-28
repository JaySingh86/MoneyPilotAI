// Test helpers for API platform and module tests. Not used by production code.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { LightMyRequestResponse } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { AppError, PROBLEM_CONTENT_TYPE, ProblemSchema, type Problem } from "@mp/contracts";
import { createLogger, type Logger } from "@mp/observability";
import type { AuthenticatedUser, Authenticator } from "../plugins/request-context";
import { buildServer, type ApiServer, type ServerOptions } from "../server";
import { defineModule } from "./module";

export const USER_A = "00000000-0000-4000-8000-00000000000a";
export const USER_B = "00000000-0000-4000-8000-00000000000b";
export const HOUSEHOLD_1 = "00000000-0000-4000-8000-000000000101";

/**
 * Fake auth: `Bearer user:<uuid>` signs in that user, `Bearer subject:<sub>` a user before bootstrap,
 * anything else is an invalid token.
 */
export const fakeAuthenticate: Authenticator = async (request) => {
  const header = request.headers.authorization;
  if (header === undefined) return null;
  const token = header.replace(/^Bearer /, "");
  if (token.startsWith("user:")) {
    const userId = token.slice("user:".length);
    return { userId, authSubject: `sub_${userId}` } satisfies AuthenticatedUser;
  }
  if (token.startsWith("subject:")) return { userId: null, authSubject: token.slice("subject:".length) };
  throw new AppError("unauthorized", 401, "The access token is invalid.");
};

export function bearer(userId: string): Record<string, string> {
  return { authorization: `Bearer user:${userId}` };
}

/** A logger writing JSON lines to memory. */
export function captureLogger(): {
  logger: Logger;
  lines: () => Record<string, unknown>[];
  text: () => string;
} {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  const text = () => chunks.join("");
  return {
    logger: createLogger("api", "info", sink),
    text,
    lines: () =>
      text()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** Builds a server with one test module mounted at /v1 and the fake authenticator. */
export function testServer(routes: FastifyPluginAsyncZod, options: ServerOptions = {}): ApiServer {
  return buildServer({
    authenticate: fakeAuthenticate,
    ...options,
    modules: [...(options.modules ?? []), defineModule({ name: "test", routes })],
  });
}

/** Asserts an RFC 9457 response and returns the parsed problem. */
export function expectProblem(res: LightMyRequestResponse, status: number, code: Problem["code"]): Problem {
  const contentType = String(res.headers["content-type"] ?? "");
  if (!contentType.startsWith(PROBLEM_CONTENT_TYPE)) {
    throw new Error(`Expected ${PROBLEM_CONTENT_TYPE}, got "${contentType}": ${res.body}`);
  }
  const problem = ProblemSchema.parse(res.json());
  if (res.statusCode !== status || problem.status !== status || problem.code !== code) {
    throw new Error(`Expected ${status} ${code}, got ${res.statusCode} ${problem.code}: ${res.body}`);
  }
  return problem;
}

/** Asserts a webhook helper rejected with 401 `unauthorized` (optionally matching the detail). */
export async function expectWebhookRejected(
  attempt: Promise<unknown> | (() => unknown),
  detail?: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await (typeof attempt === "function" ? attempt() : attempt);
  } catch (err) {
    caught = err;
  }
  if (!(caught instanceof AppError) || caught.status !== 401 || caught.code !== "unauthorized") {
    throw new Error(`Expected a 401 unauthorized AppError, got ${String(caught)}`);
  }
  if (detail && !detail.test(caught.detail ?? "")) {
    throw new Error(`Expected detail matching ${String(detail)}, got "${caught.detail ?? ""}"`);
  }
}

/**
 * A self-signed RSA certificate made with the `openssl` CLI (present on macOS and the CI runner).
 * Test-only key material, generated per run and never written to the repo.
 */
export function makeTestCertificate(commonName: string, days = 2): { certPem: string; keyPem: string } {
  const dir = mkdtempSync(join(tmpdir(), "mp-cert-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    const made = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        String(days),
        "-subj",
        `/CN=${commonName}`,
      ],
      { encoding: "utf8" },
    );
    if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr}`);
    return { certPem: readFileSync(certPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
