// URLs the API hands us that the browser then goes to or sends a file to. The API is trusted, but a bug or a
// compromised response must not turn "Connect Gmail" into an open redirect or send a bank file over plain http.
import { MOCK_MODE } from "./config";

/** The consent screens the email connections may send the browser to. */
export const PROVIDER_HOSTS: readonly string[] = ["accounts.google.com", "login.microsoftonline.com"];

export class UnsafeUrlError extends Error {
  constructor(what: "provider" | "upload") {
    super(
      what === "provider" ? "That sign-in address is not one we trust." : "That upload address is not safe.",
    );
    this.name = "UnsafeUrlError";
  }
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * The provider's consent URL: https on an allowlisted host. In mock mode only, the web app's own origin is allowed
 * (the mock skips the consent page and redirects straight back).
 */
export function providerUrl(authUrl: string, origin: string = globalThis.location?.origin ?? ""): string {
  const url = parse(authUrl);
  if (url) {
    if (url.protocol === "https:" && PROVIDER_HOSTS.includes(url.hostname)) return url.toString();
    if (MOCK_MODE && url.origin === origin) return url.toString();
  }
  throw new UnsafeUrlError("provider");
}

/** Sends the browser to the provider's consent screen, after checking the address. */
export function goToProvider(authUrl: string): void {
  window.location.assign(providerUrl(authUrl));
}

/** Local MinIO (`pnpm dev:live`) is plain http on the loopback interface. Never in a production bundle. */
const isLoopbackHttp = (url: URL): boolean =>
  process.env.NODE_ENV !== "production" &&
  url.protocol === "http:" &&
  (url.hostname === "localhost" || url.hostname === "127.0.0.1");

/** The presigned upload URL: https, except in mock mode and for loopback http in development (WP-32). */
export function uploadUrl(url: string): string {
  const parsed = parse(url);
  if (
    parsed &&
    (parsed.protocol === "https:" ||
      (MOCK_MODE && /^https?:$/.test(parsed.protocol)) ||
      isLoopbackHttp(parsed))
  ) {
    return parsed.toString();
  }
  throw new UnsafeUrlError("upload");
}

export const CONNECT_REFUSED = "We couldn’t start the connection. Nothing was connected. Try again.";
