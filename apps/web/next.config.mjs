import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants.js";
import { INVITE_HEADERS, STATIC_HEADERS, productionEnvProblems } from "./security.mjs";

/**
 * Mock mode (MSW plus a fake signed-in session) exists for local development and tests only. It is
 * switched on by NEXT_PUBLIC_MP_MOCK=1 and refused here for every build and server that is not the
 * development server, so a production bundle can never carry it (see lib/config.ts).
 */
function assertMockOnlyInDevelopment(phase) {
  if (process.env.NEXT_PUBLIC_MP_MOCK !== undefined && phase !== PHASE_DEVELOPMENT_SERVER) {
    throw new Error(
      "NEXT_PUBLIC_MP_MOCK is set, but mock mode is only available on the development server. " +
        "Unset it for builds and production.",
    );
  }
}

/** A production build or server must know its API (https). */
function assertProductionEnv(phase) {
  if (phase !== PHASE_PRODUCTION_BUILD && phase !== PHASE_PRODUCTION_SERVER) return;
  // `next typegen` (the typecheck script) loads the config like a build but emits no bundle.
  if (process.argv.includes("typegen")) return;
  const problems = productionEnvProblems(process.env);
  if (problems.length > 0) {
    throw new Error(`Production web build is misconfigured: ${problems.join("; ")}.`);
  }
}

/** @type {(phase: string) => import('next').NextConfig} */
export default function nextConfig(phase) {
  assertMockOnlyInDevelopment(phase);
  assertProductionEnv(phase);
  return {
    reactStrictMode: true,
    // The Next.js dev indicator would sit on top of screenshots.
    devIndicators: false,
    // The tests build into their own folder so they never disturb a running dev server.
    distDir: process.env.MP_DIST_DIR || ".next",
    // No `X-Powered-By`.
    poweredByHeader: false,
    // Internal workspace packages ship TypeScript source.
    transpilePackages: ["@mp/format", "@mp/contracts", "@mp/ui", "@mp/engine"],
    // The Content-Security-Policy has a per-request nonce, so it is set in middleware.ts.
    async headers() {
      // The later /invite rule replaces the Referrer-Policy of the first.
      return [
        { source: "/:path*", headers: STATIC_HEADERS },
        { source: "/invite", headers: INVITE_HEADERS },
      ];
    },
  };
}
