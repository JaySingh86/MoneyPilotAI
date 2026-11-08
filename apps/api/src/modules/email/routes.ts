// Thin routes for email connections (BACKEND_PLAN §8.2, §8.4). Recipe: ../../lib/module.ts.
//
// Step-up MFA (ADR-018): `start` requires a recent second-factor sign-in, checked before anything else. The
// callback is a provider redirect with no sign-in; the server-side state identifies who started it.
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  EmailAuthUrl,
  EmailCallbackQuery,
  EmailConnection,
  EmailConnectionList,
  EmailConnectionParams,
  EmailProviderParams,
  HouseholdParams,
  StartEmailConnectionBody,
} from "@mp/contracts";
import { requireStepUp } from "../../auth/authenticator";
import { clearCookie, oauthCookieName, readCookie, setCookie } from "./cookie";
import type { AuthProvider } from "../../auth/provider";
import { dbContext, requireUserId } from "../../plugins/request-context";
import { graphValidationResponse } from "../../lib/webhooks";
import { requestMeta } from "../identity/audit";
import * as service from "./service";
import type { Caller, EmailDeps } from "./service";
import type { FastifyRequest } from "fastify";

function caller(request: FastifyRequest): Caller {
  return { ctx: dbContext(request), userId: requireUserId(request) };
}

export function emailRoutes(deps: () => EmailDeps, auth: () => AuthProvider): FastifyPluginAsyncZod {
  return async (scope) => {
    scope.get(
      "/households/:hid/email-connections",
      {
        schema: {
          summary: "Connected mailboxes of the household (masked; no tokens)",
          params: HouseholdParams,
          response: { 200: EmailConnectionList },
        },
      },
      async (request) => service.list(deps(), caller(request), request.params.hid),
    );

    // The response carries a one-time provider URL with the state, so it is never stored for replay.
    scope.post(
      "/email-connections/:provider/start",
      {
        schema: {
          summary: "Start connecting a mailbox: returns the provider's consent URL (step-up MFA)",
          params: EmailProviderParams,
          body: StartEmailConnectionBody,
          response: { 200: EmailAuthUrl },
        },
        config: { idempotency: "off", rateLimitGroup: "authSensitive" },
      },
      async (request, reply) => {
        // First, before anything touches the database.
        requireStepUp(auth(), request);
        const { browserNonce, ...body } = await service.start(
          deps(),
          caller(request),
          request.params.provider,
          request.body,
        );
        // Binds this round trip to this browser (the web app must send credentials for the cookie to be kept).
        void reply.header("set-cookie", setCookie(request.params.provider, browserNonce, request.hostname));
        return body;
      },
    );

    scope.get(
      "/email-connections/:provider/callback",
      {
        schema: {
          summary: "OAuth redirect target: stores the sealed token, then redirects to the web app",
          params: EmailProviderParams,
          querystring: EmailCallbackQuery,
          // The browser arrives from the provider with no bearer token; the state authenticates it.
          security: [],
          response: {
            302: z
              .undefined()
              .describe("Redirect to {returnTo}?connected=<provider> or ?connect_error=<code>"),
          },
        },
        // The global per-IP limit applies. The 256-bit state is what protects this route, and a shared 20/min
        // budget keyed by IP would let anyone lock real people out of finishing their own connection.
        config: {},
      },
      async (request, reply) => {
        const provider = request.params.provider;
        const url = await service.callback(
          deps(),
          provider,
          request.query,
          requestMeta(request),
          readCookie(request.headers.cookie, oauthCookieName(provider)),
        );
        return reply
          .header("set-cookie", clearCookie(provider, request.hostname))
          .header("cache-control", "no-store")
          .header("referrer-policy", "no-referrer")
          .redirect(url, 302);
      },
    );

    scope.post(
      "/email-connections/:id/pause",
      {
        schema: {
          summary: "Pause checking this mailbox (owner only)",
          params: EmailConnectionParams,
          response: { 200: EmailConnection },
        },
        config: { idempotency: "optional" },
      },
      async (request) => service.pause(deps(), caller(request), request.params.id, requestMeta(request)),
    );

    scope.post(
      "/email-connections/:id/resume",
      {
        schema: {
          summary: "Resume checking this mailbox (owner only)",
          params: EmailConnectionParams,
          response: { 200: EmailConnection },
        },
        config: { idempotency: "optional" },
      },
      async (request) => service.resume(deps(), caller(request), request.params.id, requestMeta(request)),
    );

    scope.delete(
      "/email-connections/:id",
      {
        schema: {
          summary: "Disconnect: revoke at the provider, stop the watch and delete the token (owner only)",
          params: EmailConnectionParams,
          response: { 204: z.null().describe("Disconnected") },
        },
        config: { idempotency: "optional" },
      },
      async (request, reply) => {
        await service.disconnect(deps(), caller(request), request.params.id, requestMeta(request));
        return reply.code(204).send(null);
      },
    );
  };
}

/** Generous per client IP: a provider pushes in bursts, but one address must not be able to flood the route. */
const WEBHOOK_LIMIT = { max: 1200, timeWindow: "1 minute" } as const;

const PushResult = z.object({ status: z.enum(["queued", "ignored"]) });

/** `POST /webhooks/gmail` (Pub/Sub push, OIDC-authenticated) and `POST /webhooks/graph` (validation handshake, clientState). */
export function emailWebhookRoutes(deps: () => EmailDeps): FastifyPluginAsyncZod {
  return async (scope) => {
    scope.post(
      "/gmail",
      {
        schema: { response: { 200: PushResult } },
        config: { rateLimit: WEBHOOK_LIMIT, idempotency: "off", skipUserAuth: true },
      },
      async (request) => service.receiveGmailPush(deps(), request.headers.authorization, request.body),
    );

    scope.post(
      "/graph",
      { config: { rateLimit: WEBHOOK_LIMIT, idempotency: "off", skipUserAuth: true } },
      async (request, reply) => {
        // Graph first sends `?validationToken=` and expects it echoed as text/plain within 10 s.
        if (graphValidationResponse(request, reply)) return reply;
        await service.receiveGraphPush(deps(), request.body);
        return reply.code(202).send();
      },
    );
  };
}
