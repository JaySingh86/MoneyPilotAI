// Optimistic concurrency (BACKEND_PLAN §8.1): resources carry `version`; PATCH sends `If-Match: <version>`;
// a mismatch is 409 with the current resource, so a partner's edit is never silently overwritten.
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError, IF_MATCH_HEADER } from "@mp/contracts";

const VERSION_TAG = /^(?:W\/)?"?([1-9]\d{0,15})"?$/;

function headerError(status: 400 | 428, message: string): AppError {
  return new AppError(
    status === 428 ? "precondition_required" : "validation_failed",
    status,
    status === 428 ? "Send If-Match with the version you edited." : "The If-Match header is invalid.",
    { fields: [{ in: "headers", path: "If-Match", message }] },
  );
}

/**
 * Parses an `If-Match` value: `7`, `"7"` or `W/"7"`. Returns the version, or null when the value is not a
 * single positive version (a list or `*` is not supported).
 */
export function parseVersionTag(value: string): number | null {
  const match = VERSION_TAG.exec(value.trim());
  if (!match?.[1]) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : null;
}

/** The version the client edited. Missing header: 428 `precondition_required`; malformed: 400. */
export function requireIfMatch(request: FastifyRequest): number {
  const raw = request.headers[IF_MATCH_HEADER];
  if (raw === undefined || raw === "") throw headerError(428, "Required for this request");
  const version = typeof raw === "string" ? parseVersionTag(raw) : null;
  if (version === null) throw headerError(400, 'Expected the resource version, e.g. "7"');
  return version;
}

/**
 * Throws 409 `conflict` carrying the current resource when the client's version is stale. Call it inside
 * the transaction that read `current`, and still update with `where version = expected` to close the race.
 */
export function assertVersion<T extends { version: number }>(expected: number, current: T): void {
  if (current.version !== expected) {
    throw new AppError("conflict", 409, "This was changed by someone else. Review the latest version.", {
      current,
    });
  }
}

/** Strong ETag for a version: `"7"`. */
export function versionTag(version: number): string {
  return `"${version}"`;
}

/** Sets `ETag` so clients can echo it in `If-Match`. */
export function setVersionTag(reply: FastifyReply, version: number): FastifyReply {
  return reply.header("etag", versionTag(version));
}
