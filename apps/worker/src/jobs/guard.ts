// Wraps a job handler so a failure never stores user data in pg-boss (security review L4). pg-boss keeps the
// thrown error's message in the job's `output`, and an error from the planner, the database or a validator
// can carry an amount, a name or an address. The original error goes to the shared logger, whose serializer
// keeps only the type, code and stack frames of an error that is not marked `expose`; what is thrown on is
// an error with a fixed message and no cause.
import type { Logger } from "@mp/observability";

export class JobFailedError extends Error {
  override readonly name = "JobFailedError";
  constructor(queue: string) {
    super(`${queue} failed`);
  }
}

export async function guardJob<T>(
  queue: string,
  log: Pick<Logger, "error">,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    log.error({ err, queue }, "job failed");
    throw new JobFailedError(queue);
  }
}
