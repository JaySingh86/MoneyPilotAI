// A second limiter for guessable secrets (passwords, emailed codes, TOTP codes): N failures per window for one
// target, whatever the caller's IP. The per-IP limiter alone cannot stop a distributed guesser.
//
// The key is a keyed hash of the target (an email address or a user id), so no address sits in memory or in a
// log, and it is counted whether or not the account exists, so a lockout reveals nothing. Per API instance and
// in memory (like the other platform limiters, Q-031). The cost of that design: anyone who knows an address can
// lock that address out of sign-in for the window. Supabase's own per-account limits sit behind this.
//
// Atomic per key: `guard` reserves a slot (synchronously, before any await) and releases it afterwards, so N
// parallel guesses can never run more than the budget allows.
import { createHmac } from "node:crypto";
import { AppError } from "@mp/contracts";

export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
/** Bound on tracked targets, so a flood of random addresses cannot grow memory without limit. */
const DEFAULT_MAX_TRACKED = 20_000;

export interface FailureLimiterOptions {
  maxTracked?: number;
}

export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();
  /** Attempts running now: each holds one slot of the budget until it finishes. */
  private readonly inflight = new Map<string, number>();
  private readonly maxTracked: number;

  constructor(
    private readonly secret: string,
    private readonly now: () => number,
    options: FailureLimiterOptions = {},
  ) {
    this.maxTracked = options.maxTracked ?? DEFAULT_MAX_TRACKED;
  }

  /** A stable, non-reversible key for a target within a namespace (route). */
  key(namespace: string, target: string): string {
    return createHmac("sha256", this.secret).update(`${namespace}\0${target.toLowerCase()}`).digest("hex");
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - FAILURE_WINDOW_MS;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.failures.delete(key);
    else this.failures.set(key, list);
    return list;
  }

  private used(key: string): number {
    return this.recent(key).length + (this.inflight.get(key) ?? 0);
  }

  private lockedError(key: string): AppError {
    const oldest = this.recent(key)[0] ?? this.now();
    const retryAfter = Math.max(1, Math.ceil((oldest + FAILURE_WINDOW_MS - this.now()) / 1000));
    return new AppError("rate_limited", 429, "Too many attempts. Try again later.", {
      headers: { "retry-after": String(retryAfter) },
    });
  }

  /** Throws a generic 429 once the target has used up its budget (recorded failures plus attempts running). */
  check(key: string): void {
    if (this.used(key) >= MAX_FAILURES) throw this.lockedError(key);
  }

  /** Makes room for one new key: expired entries go first; then an unlocked key; a locked key only as a last resort. */
  private makeRoom(key: string): void {
    if (this.failures.size < this.maxTracked || this.failures.has(key)) return;
    for (const k of [...this.failures.keys()]) this.recent(k); // drops expired entries
    if (this.failures.size < this.maxTracked) return;
    let victim: string | undefined;
    for (const k of this.failures.keys()) {
      if (this.used(k) < MAX_FAILURES) {
        victim = k; // Map order is insertion order: the oldest unlocked key
        break;
      }
    }
    victim ??= this.failures.keys().next().value;
    if (victim !== undefined) this.failures.delete(victim);
  }

  fail(key: string): void {
    const list = this.recent(key);
    this.makeRoom(key);
    this.failures.set(key, [...list, this.now()]);
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  /**
   * Runs `attempt`: refused up front when the budget (failures plus attempts running) is used up, counted on a
   * caller-input failure, cleared on success. The slot is taken before the first await, so concurrent attempts
   * cannot slip past the check together.
   */
  async guard<T>(key: string, attempt: () => Promise<T>): Promise<T> {
    this.check(key);
    this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
    let result: T;
    try {
      result = await attempt();
    } catch (err) {
      // Release first, then count: the failure replaces the slot, so the budget never double-counts.
      this.release(key);
      // Only wrong credentials or codes count; an outage (5xx) or the provider's own limit does not.
      if (err instanceof AppError && (err.code === "bad_request" || err.code === "unauthorized"))
        this.fail(key);
      throw err;
    }
    this.release(key);
    this.clear(key);
    return result;
  }

  private release(key: string): void {
    const n = (this.inflight.get(key) ?? 0) - 1;
    if (n > 0) this.inflight.set(key, n);
    else this.inflight.delete(key);
  }
}
