// Where the browser may land after Google sign-in. The callback redirects to WEB_ORIGIN + this path, so an
// absolute URL, a protocol-relative one or a backslash trick can never leave the web app. Only the first
// path segment is allowlisted (the app's own routes); anything else falls back to the home page.
const ALLOWED_FIRST_SEGMENTS = new Set([
  "",
  "overview",
  "bills",
  "calendar",
  "goals",
  "renewals",
  "tasks",
  "imports",
  "settings",
  "setup",
  "invite",
  "sign-in",
]);

const SHAPE = /^\/[A-Za-z0-9\-._~/]*$/;

export const DEFAULT_NEXT_PATH = "/";

export function safeNextPath(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0 || raw.length > 256) return DEFAULT_NEXT_PATH;
  // Path only: no query or fragment survives the round trip (the invite token lives in sessionStorage).
  if (!SHAPE.test(raw) || raw.includes("//") || raw.split("/").includes("..")) return DEFAULT_NEXT_PATH;
  const first = raw.split("/")[1] ?? "";
  return ALLOWED_FIRST_SEGMENTS.has(first) ? raw : DEFAULT_NEXT_PATH;
}
