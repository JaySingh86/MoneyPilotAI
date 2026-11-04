// Sets the Content-Security-Policy with a fresh nonce on every request (the other security headers
// are static, in next.config.mjs). Next reads the nonce from the request's CSP header and adds it
// to the scripts it renders, which is why the pages render per request (app/layout.tsx).
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildCsp } from "./security.mjs";

export function middleware(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  // Literal reads, so Next inlines the NEXT_PUBLIC_* values into the Edge bundle.
  const csp = buildCsp({
    nonce,
    dev: process.env.NODE_ENV !== "production",
    env: {
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
      NEXT_PUBLIC_COGNITO_USER_POOL_ID: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID,
      NEXT_PUBLIC_COGNITO_CLIENT_ID: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
      NEXT_PUBLIC_COGNITO_REGION: process.env.NEXT_PUBLIC_COGNITO_REGION,
      NEXT_PUBLIC_COGNITO_OAUTH_DOMAIN: process.env.NEXT_PUBLIC_COGNITO_OAUTH_DOMAIN,
    },
  });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages and the route handlers; not static files, images or prefetches.
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
