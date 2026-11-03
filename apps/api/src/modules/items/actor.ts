// The calling member for a household route, shared by the modules that read it (items, goals, tasks,
// proposals).
import type { FastifyRequest } from "fastify";
import { AppError } from "@mp/contracts";
import { dbContext, requireUserId } from "../../plugins/request-context";
import type { Actor } from "./service";

export function actor(request: FastifyRequest): Actor {
  const ctx = dbContext(request);
  const householdId = request.ctx.householdId;
  if (!householdId) throw new AppError("validation_failed", 400, "The household id is missing.");
  return { ctx, userId: requireUserId(request), householdId };
}
