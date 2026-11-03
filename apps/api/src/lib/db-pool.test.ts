import { describe, expect, it, vi } from "vitest";
import { createSharedDb, installShutdown, type SignalSource } from "./db-pool";

function signals() {
  const handlers = new Map<string, () => void>();
  const source: SignalSource = {
    once(signal, handler) {
      handlers.set(signal, handler);
    },
  };
  return { source, fire: (s: "SIGINT" | "SIGTERM") => handlers.get(s)?.() };
}

describe("shared database pool", () => {
  it("opens no connection until used and closes idempotently", async () => {
    const pool = createSharedDb({ connectionString: "postgres://mp_api:x@127.0.0.1:1/none", max: 1 });
    await pool.close();
    await pool.close();
    expect(pool.close()).toBe(pool.close());
  });

  it("closes the server first, then the pool, on SIGTERM", async () => {
    const order: string[] = [];
    const done = vi.fn();
    const s = signals();
    installShutdown(
      { close: async () => void order.push("app") },
      { close: async () => void order.push("pool") },
      s.source,
      done,
    );
    s.fire("SIGTERM");
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(order).toEqual(["app", "pool"]);
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it("runs once however many signals arrive, and still closes the pool when the server fails to close", async () => {
    const poolClose = vi.fn(async () => undefined);
    const done = vi.fn();
    const failure = new Error("close failed");
    const s = signals();
    const shutdown = installShutdown(
      { close: async () => Promise.reject(failure) },
      { close: poolClose },
      s.source,
      done,
    );
    s.fire("SIGINT");
    s.fire("SIGTERM");
    await shutdown();
    expect(poolClose).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(failure);
  });
});
