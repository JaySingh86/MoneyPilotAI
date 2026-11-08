import { describe, expect, it } from "vitest";
import { AppError } from "@mp/contracts";
import { FAILURE_WINDOW_MS, FailureLimiter, MAX_FAILURES } from "./failure-limiter";

const wrongCode = () => new AppError("bad_request", 400, "wrong");
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function make(options: { maxTracked?: number } = {}) {
  let t = 1_000_000;
  const limiter = new FailureLimiter("secret", () => t, options);
  return { limiter, advance: (ms: number) => (t += ms) };
}

describe("FailureLimiter.guard", () => {
  it("parallel guesses never exceed the failure budget", async () => {
    const { limiter } = make();
    const key = limiter.key("sign-in", "a@example.test");
    let ran = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        limiter.guard(key, async () => {
          ran++;
          await tick(); // every attempt is in flight before any has failed
          throw wrongCode();
        }),
      ),
    );
    expect(ran).toBe(MAX_FAILURES);
    const limited = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof AppError && r.reason.code === "rate_limited",
    );
    expect(limited).toHaveLength(50 - MAX_FAILURES);
    // And the key is now locked.
    await expect(limiter.guard(key, async () => "ok")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("slots held by attempts that succeed are released", async () => {
    const { limiter } = make();
    const key = limiter.key("sign-in", "b@example.test");
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        limiter.guard(key, async () => {
          await tick();
          return "ok";
        }),
      ),
    );
    // At most MAX_FAILURES run at once; the rest are turned away while those are in flight.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(MAX_FAILURES);
    let ok = 0;
    for (let i = 0; i < 20; i++) {
      await limiter.guard(key, async () => "ok").then(() => ok++);
    }
    expect(ok).toBe(20); // successes never lock the key afterwards
  });

  it("slots held by non-credential failures (outage, provider limit) are released and not counted", async () => {
    const { limiter } = make();
    const key = limiter.key("sign-in", "c@example.test");
    for (let i = 0; i < 20; i++) {
      await expect(
        limiter.guard(key, async () => {
          throw new AppError("internal_error", 503, "down");
        }),
      ).rejects.toMatchObject({ status: 503 });
    }
    await expect(limiter.guard(key, async () => "ok")).resolves.toBe("ok");
  });

  it("a success clears earlier failures; the window expires", async () => {
    const { limiter, advance } = make();
    const key = limiter.key("sign-in", "d@example.test");
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      await limiter.guard(key, async () => Promise.reject(wrongCode())).catch(() => undefined);
    }
    await limiter.guard(key, async () => "ok");
    for (let i = 0; i < MAX_FAILURES; i++) {
      await limiter.guard(key, async () => Promise.reject(wrongCode())).catch(() => undefined);
    }
    await expect(limiter.guard(key, async () => "ok")).rejects.toMatchObject({ code: "rate_limited" });
    advance(FAILURE_WINDOW_MS + 1);
    await expect(limiter.guard(key, async () => "ok")).resolves.toBe("ok");
  });
});

describe("FailureLimiter eviction", () => {
  const lock = async (limiter: FailureLimiter, key: string) => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      await limiter.guard(key, async () => Promise.reject(wrongCode())).catch(() => undefined);
    }
  };
  const isLocked = (limiter: FailureLimiter, key: string) => {
    try {
      limiter.check(key);
      return false;
    } catch {
      return true;
    }
  };

  it("drops expired entries first, so a locked key survives a flood", async () => {
    const { limiter, advance } = make({ maxTracked: 10 });
    const locked = limiter.key("sign-in", "victim@example.test");
    await lock(limiter, locked);
    advance(FAILURE_WINDOW_MS - 1000); // the locked key is still locked, but old
    // Fill the table with one-failure keys that expire sooner than the locked key's window... then flood.
    for (let i = 0; i < 9; i++) limiter.fail(limiter.key("sign-in", `x${i}@example.test`));
    advance(500);
    for (let i = 0; i < 50; i++) limiter.fail(limiter.key("sign-in", `flood${i}@example.test`));
    expect(isLocked(limiter, locked)).toBe(true);
  });

  it("never evicts a locked key while unlocked ones exist", async () => {
    const { limiter } = make({ maxTracked: 10 });
    const locked = limiter.key("sign-in", "victim@example.test");
    await lock(limiter, locked); // the oldest entry, and locked
    for (let i = 0; i < 200; i++) limiter.fail(limiter.key("sign-in", `flood${i}@example.test`));
    expect(isLocked(limiter, locked)).toBe(true);
  });
});
