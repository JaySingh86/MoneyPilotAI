// /v1/me routes (BACKEND_PLAN §8.2). Thin: the service owns the logic, repo.ts the SQL.
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { BootstrapBody, Me, PatchMeBody } from "@mp/contracts";
import { verifiedTokenOf } from "../../auth/authenticator";
import type { RuntimeSource } from "../../auth/runtime";
import { requireUser, requireUserId } from "../../plugins/request-context";
import { requestMeta } from "./audit";
import { IdentityService } from "./service";

export function identityRoutes(source: RuntimeSource): FastifyPluginAsyncZod {
  const service = () => new IdentityService(source().db);

  return async (scope) => {
    // Creates the users row on first call and syncs email and MFA from the verified token. The body can
    // carry a name and time zone only; the email is never taken from it.
    scope.post(
      "/me/bootstrap",
      {
        schema: {
          summary: "Create or sync the signed-in user from the verified token",
          body: BootstrapBody.nullish(),
          response: { 200: Me },
        },
        config: { idempotency: "optional", rateLimitGroup: "authSensitive" },
      },
      async (request) => {
        requireUser(request);
        const identity = source().provider.getUser(verifiedTokenOf(request));
        return service().bootstrap(identity, request.body ?? {}, requestMeta(request));
      },
    );

    scope.get(
      "/me",
      { schema: { summary: "The signed-in user and their households", response: { 200: Me } } },
      async (request) => {
        const user = requireUser(request);
        return service().getMe(requireUserId(request), user.authSubject);
      },
    );

    // Profile changes are last-write-wins: only the user edits their own profile, so there is no partner
    // to conflict with and `users` has no version column (Q-084).
    scope.patch(
      "/me",
      {
        schema: {
          summary: "Update name or time zone",
          body: PatchMeBody,
          response: { 200: Me },
        },
        config: { idempotency: "optional" },
      },
      async (request) => {
        const user = requireUser(request);
        return service().patchMe(
          requireUserId(request),
          user.authSubject,
          request.body,
          requestMeta(request),
        );
      },
    );
  };
}
