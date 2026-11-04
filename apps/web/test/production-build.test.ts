// @vitest-environment node
// Builds the app for production and reads what it ships: none of the mock mode, the mock sign-in, the
// mock API or its engine may be in the bundle (security finding M1). The build goes into its own
// folder so it never disturbs a running dev server.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WEB = resolve(import.meta.dirname, "..");
const DIST = ".next-prodcheck";

const FORBIDDEN = [
  "mock-access-token",
  "any password works",
  "riveraInput",
  "rivera-household",
  "mp.mock.auth",
  "__mpMock",
];
const FORBIDDEN_PATTERNS = [
  // The mock sign-in code; as a whole number, so digit tables in vendor code ("0123456789") don't count.
  /(?<!\d)123456(?!\d)/,
  // `msw` as a word: the package name, a path or an import.
  /\bmsw\b/,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const prodEnv = {
  NEXT_PUBLIC_API_URL: "https://api.moneypilot.example",
  NEXT_PUBLIC_COGNITO_USER_POOL_ID: "us-east-1_AbCdEf123",
  NEXT_PUBLIC_COGNITO_CLIENT_ID: "client-id-for-the-build-test",
};

function build(extra: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, MP_DIST_DIR: DIST, NODE_ENV: "production" };
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
  return execFileSync("pnpm", ["exec", "next", "build"], { cwd: WEB, env, encoding: "utf8", stdio: "pipe" });
}

function failure(extra: Record<string, string | undefined>): string {
  try {
    build(extra);
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  return "";
}

describe("production build", () => {
  // `next build` rewrites the tracked next-env.d.ts to point at DIST; put it back afterwards.
  const NEXT_ENV = join(WEB, "next-env.d.ts");
  let nextEnv: string;
  beforeAll(() => {
    nextEnv = readFileSync(NEXT_ENV, "utf8");
    rmSync(join(WEB, DIST), { recursive: true, force: true });
  });
  afterAll(() => {
    writeFileSync(NEXT_ENV, nextEnv);
    rmSync(join(WEB, DIST), { recursive: true, force: true });
  });

  it("refuses to build with mock mode on", () => {
    expect(failure({ ...prodEnv, NEXT_PUBLIC_MP_MOCK: "1" })).toMatch(
      /only available on the development server/,
    );
  });

  it("refuses to build without an https API URL or the Cognito settings", () => {
    expect(failure({ ...prodEnv, NEXT_PUBLIC_API_URL: undefined, NEXT_PUBLIC_MP_MOCK: undefined })).toMatch(
      /NEXT_PUBLIC_API_URL is not set/,
    );
    expect(
      failure({ ...prodEnv, NEXT_PUBLIC_API_URL: "http://api.example.com", NEXT_PUBLIC_MP_MOCK: undefined }),
    ).toMatch(/must be an https URL/);
    expect(
      failure({ ...prodEnv, NEXT_PUBLIC_COGNITO_USER_POOL_ID: undefined, NEXT_PUBLIC_MP_MOCK: undefined }),
    ).toMatch(/NEXT_PUBLIC_COGNITO_USER_POOL_ID is not set/);
  });

  it("ships no mock code, mock sign-in text, mock API or engine", () => {
    build({ ...prodEnv, NEXT_PUBLIC_MP_MOCK: undefined });
    const shipped = files(join(WEB, DIST)).filter(
      // Source maps, caches and trace files hold file paths, not what ships.
      (f) => /\.(js|html|json|css|rsc|txt)$/.test(f) && !/(cache|trace|\.map$)/.test(f),
    );
    expect(shipped.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const file of shipped) {
      const text = readFileSync(file, "utf8");
      for (const needle of FORBIDDEN)
        if (text.includes(needle)) hits.push(`${needle} in ${file.replace(WEB, "")}`);
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) hits.push(`${pattern} in ${file.replace(WEB, "")}`);
      }
    }
    expect(hits).toEqual([]);
  }, 240_000);
});
