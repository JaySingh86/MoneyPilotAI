// A small fetch wrapper for the real provider clients: bounded time, bounded size, and every failure mapped to a
// ProviderError with a fixed message (a provider's response text can carry an address or a subject). `fetch` is
// injected, so tests never touch the network.
import { ProviderError } from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 25 * 1024 * 1024;

/** A fixed error for a status, or one chosen from the OAuth `error` code in the body (RFC 6749 §5.2). */
export type StatusMapping = ProviderError | ((oauthError: string | undefined) => ProviderError);

/** Reads only the OAuth `error` code; the rest of the body (which can carry an address) is never kept. */
async function oauthErrorCode(res: Response): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse((await res.text()).slice(0, 4000));
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
      return /^[a-z_]{1,64}$/.test(parsed.error) ? parsed.error : undefined;
    }
  } catch {
    // Not JSON: no code.
  }
  return undefined;
}

export interface Http {
  json<T = unknown>(
    url: string,
    init: RequestInit & { expect?: readonly number[]; mapStatus?: Record<number, StatusMapping> },
  ): Promise<{ status: number; body: T }>;
  bytes(url: string, init: RequestInit): Promise<Uint8Array>;
}

function retryAfter(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 3600) : undefined;
}

/** Google answers quota problems with 403 too; only those are worth waiting out. */
const QUOTA_REASON = /ratelimit|quota|backenderror/i;

async function forbidden(res: Response): Promise<ProviderError> {
  let text = "";
  try {
    text = (await res.text()).slice(0, 4000);
  } catch {
    // An unreadable body is treated as a permission problem below.
  }
  // The text is only matched here; it never goes into the error (it can carry an address).
  if (QUOTA_REASON.test(text)) {
    return new ProviderError("rate_limited", "The provider is limiting requests for now.", retryAfter(res));
  }
  return new ProviderError("permanent", "The provider refused access to the mailbox.");
}

function failure(res: Response, mapped?: ProviderError): ProviderError {
  if (mapped) return mapped;
  if (res.status === 401) return new ProviderError("auth_revoked", "The provider rejected the credentials.");
  if (res.status === 429) {
    return new ProviderError("rate_limited", "The provider is rate limiting requests.", retryAfter(res));
  }
  if (res.status === 404) return new ProviderError("not_found", "The provider has no such resource.");
  if (res.status >= 500)
    return new ProviderError("transient", "The provider is unavailable.", retryAfter(res));
  return new ProviderError("permanent", "The provider rejected the request.");
}

async function read(res: Response): Promise<Uint8Array> {
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new ProviderError("permanent", "The provider response is too large.");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_BODY_BYTES)
    throw new ProviderError("permanent", "The provider response is too large.");
  return buf;
}

export function createHttp(fetchImpl: FetchLike): Http {
  async function call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new ProviderError("transient", "The provider could not be reached.");
    }
  }
  return {
    async json(url, { expect = [200], mapStatus, ...init }) {
      const res = await call(url, init);
      if (!expect.includes(res.status)) {
        const mapping = mapStatus?.[res.status];
        if (res.status === 403 && !mapping) throw await forbidden(res);
        throw failure(res, typeof mapping === "function" ? mapping(await oauthErrorCode(res)) : mapping);
      }
      if (res.status === 204) return { status: res.status, body: undefined as never };
      const buf = await read(res);
      if (buf.length === 0) return { status: res.status, body: undefined as never };
      try {
        return { status: res.status, body: JSON.parse(Buffer.from(buf).toString("utf8")) as never };
      } catch {
        throw new ProviderError("transient", "The provider sent an unreadable response.");
      }
    },
    async bytes(url, init) {
      const res = await call(url, init);
      if (res.status !== 200) throw res.status === 403 ? await forbidden(res) : failure(res);
      return read(res);
    },
  };
}

export const bearer = (accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
});

export function form(values: Record<string, string>): { body: string; headers: Record<string, string> } {
  return {
    body: new URLSearchParams(values).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
}
