import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "@mp/observability";
import { JobFailedError, guardJob } from "./guard";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { log: createLogger("worker", "debug", stream), text: () => lines.join("") };
}

describe("guardJob (security L4)", () => {
  const secret = new Error("could not pay $1,234.56 to sam@rivera.example", {
    cause: new Error("balance 987654 for Sam Rivera"),
  });

  it("throws a static error without the original message or cause", async () => {
    const { log } = capture();
    const failure = await guardJob("plan.recompute", log, async () => Promise.reject(secret)).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(JobFailedError);
    expect((failure as Error).message).toBe("plan.recompute failed");
    expect((failure as Error).cause).toBeUndefined();
    expect(String((failure as Error).stack)).not.toMatch(/1,234|sam@|987654|Rivera/);
  });

  it("the logger keeps the original error's message and cause out of the log line", async () => {
    const { log, text } = capture();
    await guardJob("plan.recompute", log, async () => Promise.reject(secret)).catch(() => undefined);
    const out = text();
    expect(out).toContain("job failed");
    expect(out).toContain("plan.recompute");
    expect(out).not.toMatch(/1,234|sam@|987654|Rivera/);
  });

  it("returns the handler's result when it succeeds", async () => {
    const { log } = capture();
    expect(await guardJob("q", log, async () => 42)).toBe(42);
  });
});
