// @vitest-environment node
// Security headers (CSP with a per-request nonce, HSTS and friends) and the production environment
// checks.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.mjs";
import { middleware } from "../middleware";
import { STATIC_HEADERS, buildCsp, cognitoOrigins, productionEnvProblems } from "../security.mjs";

const prodEnv = {
  NEXT_PUBLIC_API_URL: "https://api.moneypilot.example",
  NEXT_PUBLIC_COGNITO_USER_POOL_ID: "us-east-1_AbCdEf123",
  NEXT_PUBLIC_COGNITO_CLIENT_ID: "client-id",
};

function directive(csp: string, name: string): string[] {
  const part = csp.split("; ").find((d) => d.startsWith(`${name} `));
  return part ? part.slice(name.length + 1).split(" ") : [];
}

describe("Content-Security-Policy", () => {
  const csp = buildCsp({ nonce: "abc123", dev: false, env: prodEnv });

  it("is locked down by default", () => {
    expect(directive(csp, "default-src")).toEqual(["'self'"]);
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "base-uri")).toEqual(["'self'"]);
    expect(directive(csp, "form-action")).toEqual(["'self'"]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp, "img-src")).toEqual(["'self'", "data:"]);
    expect(directive(csp, "font-src")).toEqual(["'self'"]);
    expect(directive(csp, "style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("allows scripts from self and the nonce only, with no eval in production", () => {
    expect(directive(csp, "script-src")).toEqual(["'self'", "'nonce-abc123'"]);
    expect(csp).not.toContain("unsafe-eval");
    expect(directive(csp, "script-src")).not.toContain("'unsafe-inline'");
  });

  it("connects only to self, the API and Cognito", () => {
    expect(directive(csp, "connect-src")).toEqual([
      "'self'",
      "https://api.moneypilot.example",
      "https://cognito-idp.us-east-1.amazonaws.com",
      "https://cognito-identity.us-east-1.amazonaws.com",
    ]);
  });

  it("adds the hosted UI domain when Google sign-in is configured", () => {
    expect(cognitoOrigins({ ...prodEnv, NEXT_PUBLIC_COGNITO_OAUTH_DOMAIN: "auth.example.com" })).toContain(
      "https://auth.example.com",
    );
  });

  it("references no Google origin (the fonts are self-hosted)", () => {
    expect(csp).not.toMatch(/google|gstatic/);
  });

  it("allows eval and the mock worker only in development", () => {
    const dev = buildCsp({ nonce: "n", dev: true, env: {} });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "worker-src")).toEqual(["'self'"]);
    expect(directive(dev, "connect-src")).toContain("http://localhost:4000");
    expect(csp).not.toContain("worker-src");
  });
});

describe("middleware", () => {
  it("sets the policy with a fresh nonce on the request and the response", () => {
    const first = middleware(new NextRequest("http://localhost:3100/overview"));
    const second = middleware(new NextRequest("http://localhost:3100/overview"));
    const csp = first.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(/'nonce-([^']+)'/.exec(second.headers.get("content-security-policy") ?? "")?.[1]).not.toBe(nonce);
    // The request headers Next reads the nonce from.
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
  });
});

describe("static security headers", () => {
  it("sends HSTS, nosniff, a referrer policy, a permissions policy and frame denial", () => {
    const headers = Object.fromEntries(STATIC_HEADERS.map((h) => [h.key, h.value]));
    expect(headers["Strict-Transport-Security"]).toMatch(/max-age=\d{8,}; includeSubDomains/);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toMatch(/camera=\(\)/);
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });

  it("applies them to every route through next.config", async () => {
    const config = nextConfig("phase-development-server");
    const rules = await config.headers?.();
    expect(rules).toEqual([{ source: "/:path*", headers: STATIC_HEADERS }]);
    expect(config.poweredByHeader).toBe(false);
  });
});

describe("production environment", () => {
  it("accepts an https API and a configured user pool", () => {
    expect(productionEnvProblems(prodEnv)).toEqual([]);
  });

  it("rejects a missing, http or malformed API URL", () => {
    expect(productionEnvProblems({ ...prodEnv, NEXT_PUBLIC_API_URL: undefined })).toContain(
      "NEXT_PUBLIC_API_URL is not set",
    );
    expect(productionEnvProblems({ ...prodEnv, NEXT_PUBLIC_API_URL: "http://api.example.com" })).toContain(
      "NEXT_PUBLIC_API_URL must be an https URL",
    );
    expect(productionEnvProblems({ ...prodEnv, NEXT_PUBLIC_API_URL: "not a url" })).toContain(
      "NEXT_PUBLIC_API_URL must be an https URL",
    );
  });

  it("rejects missing Cognito settings", () => {
    const problems = productionEnvProblems({ NEXT_PUBLIC_API_URL: prodEnv.NEXT_PUBLIC_API_URL });
    expect(problems).toEqual([
      "NEXT_PUBLIC_COGNITO_USER_POOL_ID is not set",
      "NEXT_PUBLIC_COGNITO_CLIENT_ID is not set",
    ]);
  });

  it("stops a production build or server config when the environment is wrong", () => {
    const saved = { ...process.env };
    try {
      for (const key of Object.keys(prodEnv)) delete process.env[key];
      delete process.env.NEXT_PUBLIC_MP_MOCK;
      expect(() => nextConfig("phase-production-build")).toThrow(
        /misconfigured.*NEXT_PUBLIC_API_URL is not set/,
      );
      expect(() => nextConfig("phase-production-server")).toThrow(/misconfigured/);
      expect(() => nextConfig("phase-development-server")).not.toThrow();
      Object.assign(process.env, prodEnv);
      expect(() => nextConfig("phase-production-build")).not.toThrow();
    } finally {
      process.env = saved;
    }
  });

  it("never lets mock mode into a build or a production server", () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, prodEnv, { NEXT_PUBLIC_MP_MOCK: "1" });
      expect(() => nextConfig("phase-production-build")).toThrow(/only available on the development server/);
      expect(() => nextConfig("phase-production-server")).toThrow(/only available on the development server/);
      expect(() => nextConfig("phase-development-server")).not.toThrow();
    } finally {
      process.env = saved;
    }
  });
});
