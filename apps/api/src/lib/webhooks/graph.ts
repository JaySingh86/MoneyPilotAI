// Microsoft Graph change notifications (BACKEND_PLAN §8.4): the subscription validation handshake and
// the `clientState` check. The payload body is never trusted beyond that; the job re-reads via delta.
// https://learn.microsoft.com/graph/change-notifications-delivery-webhooks
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "@mp/contracts";
import { constantTimeEqual, webhookRejected } from "./hmac";

const MAX_VALIDATION_TOKEN = 1024;

/**
 * Answers Graph's validation request: when `?validationToken=` is present, replies 200 text/plain with the
 * decoded token and returns true. Returns false for a normal notification.
 */
export function graphValidationResponse(request: FastifyRequest, reply: FastifyReply): boolean {
  const query = request.query as Record<string, unknown> | undefined;
  const token = query?.validationToken;
  if (token === undefined) return false;
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_VALIDATION_TOKEN) {
    throw new AppError("validation_failed", 400, "The validationToken is invalid.", {
      fields: [{ in: "querystring", path: "validationToken", message: "Expected 1-1024 characters" }],
    });
  }
  void reply.code(200).type("text/plain; charset=utf-8").send(token);
  return true;
}

/**
 * Throws 401 unless every notification in the batch carries our subscription's `clientState`
 * (compared in constant time).
 */
export function assertGraphClientState(body: unknown, expected: string): void {
  const value = (body as { value?: unknown } | null | undefined)?.value;
  if (!Array.isArray(value) || value.length === 0) {
    throw webhookRejected("The Graph request has no notifications.");
  }
  for (const item of value) {
    const clientState = (item as { clientState?: unknown } | null)?.clientState;
    if (typeof clientState !== "string" || !constantTimeEqual(clientState, expected)) {
      throw webhookRejected("The Graph clientState does not match.");
    }
  }
}
