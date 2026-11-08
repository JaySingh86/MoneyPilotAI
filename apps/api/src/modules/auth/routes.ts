// /v1/auth/* (ADR-020): the only door to Supabase Auth. Thin routes; logic in service.ts.
//
// Sessions: the access token is returned in the body. The refresh token is an httpOnly cookie for
// `X-MP-Client: web` (default), or `session.refreshToken` for `mobile`. Cookie-authenticated calls (refresh,
// sign-out) need `X-MP-Client: web` plus an `Origin` equal to WEB_ORIGIN (CSRF); every web call that sets the
// cookie rejects a foreign `Origin` when one is present.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  Accepted,
  AppError,
  AUTH_CLIENT_HEADER,
  AuthClient,
  ConfirmEmailBody,
  EmailBody,
  GoogleCallbackQuery,
  GoogleStartQuery,
  MfaChallengeBody,
  MfaChallengeResponse,
  MfaEnrolResponse,
  MfaVerifyBody,
  PasswordResetBody,
  RefreshBody,
  SignedIn,
  SignInBody,
  SignInResponse,
  SignUpBody,
} from "@mp/contracts";
import { verifiedTokenOf } from "../../auth/authenticator";
import type { GoTrueSession } from "../../auth/gotrue";
import { requireUser } from "../../plugins/request-context";
import {
  clearOAuthCookie,
  clearRefreshCookie,
  newPkce,
  readCookie,
  readOAuthState,
  refreshCookieName,
  setOAuthCookie,
  setRefreshCookie,
} from "./cookies";
import { FailureLimiter } from "./failure-limiter";
import { safeNextPath } from "./next-path";
import type { AuthRuntimeSource } from "./runtime";
import { AuthService, toAuthSession } from "./service";

export interface AuthRoutesOptions {
  /** Clock in epoch ms (tests). */
  now?: () => number;
}

export function authRoutes(
  source: AuthRuntimeSource,
  options: AuthRoutesOptions = {},
): FastifyPluginAsyncZod {
  const now = options.now ?? Date.now;
  const limiter = new FailureLimiter(randomBytes(32).toString("hex"), now);
  /** A per-request service whose metric lands in the request log (never with an address). */
  const service = (request: FastifyRequest) =>
    new AuthService(source().gotrue, {
      providerRateLimited: (route) =>
        request.log.info({ event: "auth_provider_rate_limited", route }, "provider rate limit swallowed"),
      logoutOthersFailed: () =>
        request.log.warn({ event: "auth_logout_others_failed" }, "could not revoke other sessions"),
    });

  function clientOf(request: FastifyRequest): AuthClient {
    const raw = request.headers[AUTH_CLIENT_HEADER];
    if (raw === undefined) return "web";
    if (raw === "mobile" && request.headers.origin !== undefined) {
      // Native apps send no Origin. A browser claiming to be mobile would get the refresh token in a body that
      // page scripts can read, so it is refused.
      throw new AppError("validation_failed", 400, "The mobile client does not send an Origin.", {
        fields: [{ in: "headers", path: AUTH_CLIENT_HEADER, message: "Not allowed from a browser" }],
      });
    }
    const parsed = AuthClient.safeParse(raw);
    if (!parsed.success) {
      throw new AppError("validation_failed", 400, "The client header must be web or mobile.", {
        fields: [{ in: "headers", path: AUTH_CLIENT_HEADER, message: "Expected web or mobile" }],
      });
    }
    return parsed.data;
  }

  /** A browser sending a foreign Origin is refused, whatever the route does with cookies. */
  function rejectForeignOrigin(request: FastifyRequest): void {
    clientOf(request); // also refuses a "mobile" client that sends an Origin, before any credential is tried
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== source().config.webOrigin) {
      throw new AppError("forbidden", 403, "This request came from an origin that is not allowed.");
    }
  }

  /** CSRF for cookie-authenticated routes: custom header AND the exact web origin (browsers always send it on POST). */
  function requireWebCsrf(request: FastifyRequest): void {
    if (
      request.headers[AUTH_CLIENT_HEADER] !== "web" ||
      request.headers.origin !== source().config.webOrigin
    ) {
      throw new AppError("forbidden", 403, "This request came from an origin that is not allowed.");
    }
  }

  /** The signed-in answer. Web: refresh token into the cookie; mobile: into the body. */
  function sessionResponse(request: FastifyRequest, reply: FastifyReply, session: GoTrueSession) {
    const client = clientOf(request);
    const secure = source().config.cookieSecure;
    if (client === "web") setRefreshCookie(reply, session.refreshToken, secure);
    return toAuthSession(session, client === "mobile");
  }

  return async (scope) => {
    const credentials = { idempotency: "off", rateLimitGroup: "authCredentials" } as const;
    const session = { idempotency: "off", rateLimitGroup: "authSession" } as const;
    // Responses can carry tokens or Set-Cookie: never cache them.
    scope.addHook("onSend", async (_request, reply) => {
      void reply.header("cache-control", "no-store");
    });

    scope.post(
      "/auth/sign-up",
      {
        schema: {
          summary: "Create an account; a confirmation email is sent",
          description: "Always 202, including for an address that already has an account.",
          security: [],
          body: SignUpBody,
          response: { 202: Accepted },
        },
        config: credentials,
      },
      async (request, reply) => {
        rejectForeignOrigin(request);
        await service(request).signUp(request.body);
        return reply.code(202).send({ status: "accepted" as const });
      },
    );

    scope.post(
      "/auth/confirm-email",
      {
        schema: {
          summary: "Confirm the email address with the emailed code or link token, and sign in",
          security: [],
          body: ConfirmEmailBody,
          response: { 200: SignedIn },
        },
        config: credentials,
      },
      async (request, reply) => {
        rejectForeignOrigin(request);
        const { email } = request.body;
        const attempt = () => service(request).confirmEmail(request.body);
        // An emailed code is guessable, so wrong ones are counted per address as well as per IP.
        const result = email
          ? await limiter.guard(limiter.key("confirm-email", email), attempt)
          : await attempt();
        return { status: "signed_in" as const, session: sessionResponse(request, reply, result) };
      },
    );

    scope.post(
      "/auth/resend-confirmation",
      {
        schema: {
          summary: "Send the confirmation email again",
          description: "Always 202.",
          security: [],
          body: EmailBody,
          response: { 202: Accepted },
        },
        config: credentials,
      },
      async (request, reply) => {
        rejectForeignOrigin(request);
        await service(request).resendConfirmation(request.body.email);
        return reply.code(202).send({ status: "accepted" as const });
      },
    );

    scope.post(
      "/auth/sign-in",
      {
        schema: {
          summary: "Sign in with email and password",
          description:
            "`mfa_required` carries an aal1 session: call `/auth/mfa/verify` with the authenticator code to reach aal2.",
          security: [],
          body: SignInBody,
          response: { 200: SignInResponse },
        },
        config: credentials,
      },
      async (request, reply) => {
        rejectForeignOrigin(request);
        const outcome = await limiter.guard(limiter.key("sign-in", request.body.email), () =>
          service(request).signIn(request.body),
        );
        if (outcome.status === "confirm_email") return { status: "confirm_email" as const };
        const body = sessionResponse(request, reply, outcome.session);
        return outcome.status === "mfa_required"
          ? { status: "mfa_required" as const, factorId: outcome.factorId, session: body }
          : { status: "signed_in" as const, session: body };
      },
    );

    scope.post(
      "/auth/refresh",
      {
        schema: {
          summary: "Exchange the refresh token for a new session",
          description:
            "Web: reads the httpOnly cookie (send `X-MP-Client: web`; the Origin must be the web app). Mobile: send `refreshToken` in the body.",
          security: [],
          body: RefreshBody,
          response: { 200: SignedIn },
        },
        config: session,
      },
      async (request, reply) => {
        const client = clientOf(request);
        let token: string | null | undefined;
        if (client === "web") {
          requireWebCsrf(request);
          token = readCookie(request, refreshCookieName(source().config.cookieSecure));
        } else {
          token = request.body?.refreshToken;
        }
        if (!token) throw new AppError("unauthorized", 401, "Sign in to continue.");
        try {
          const result = await service(request).refresh(token);
          return { status: "signed_in" as const, session: sessionResponse(request, reply, result) };
        } catch (err) {
          // A dead refresh token must not linger in the browser.
          if (client === "web" && err instanceof AppError && err.status === 401) {
            clearRefreshCookie(reply, source().config.cookieSecure);
          }
          throw err;
        }
      },
    );

    scope.post(
      "/auth/sign-out",
      {
        schema: {
          summary: "End the session",
          description:
            "Revokes the session and clears the cookie. Send the access token, or (web) just the cookie. Always 204.",
          security: [],
          response: { 204: z.null() },
        },
        config: session,
      },
      async (request, reply) => {
        const client = clientOf(request);
        const secure = source().config.cookieSecure;
        let accessToken = request.ctx.user ? verifiedTokenOf(request).accessToken : null;
        if (client === "web") {
          requireWebCsrf(request);
          const cookie = readCookie(request, refreshCookieName(source().config.cookieSecure));
          if (!accessToken && cookie) {
            // The access token may have expired: trade the cookie for one, then revoke that session.
            accessToken = await service(request)
              .refresh(cookie)
              .then((s) => s.accessToken)
              .catch(() => null);
          }
          clearRefreshCookie(reply, secure);
        }
        if (accessToken) await service(request).signOut(accessToken);
        return reply.code(204).send(null);
      },
    );

    scope.post(
      "/auth/password-reset/request",
      {
        schema: {
          summary: "Email a password reset code and link",
          description: "Always 202.",
          security: [],
          body: EmailBody,
          response: { 202: Accepted },
        },
        config: credentials,
      },
      async (request, reply) => {
        rejectForeignOrigin(request);
        await service(request).requestPasswordReset(request.body.email);
        return reply.code(202).send({ status: "accepted" as const });
      },
    );

    scope.post(
      "/auth/password-reset/confirm",
      {
        schema: {
          summary: "Set a new password with the emailed code or link token, and sign in",
          security: [],
          body: PasswordResetBody,
          response: { 200: SignedIn },
        },
        config: credentials,
      },
      async (request, reply) => {
        rejectForeignOrigin(request);
        const { email } = request.body;
        const attempt = () => service(request).confirmPasswordReset(request.body);
        const result = email
          ? await limiter.guard(limiter.key("password-reset", email), attempt)
          : await attempt();
        return { status: "signed_in" as const, session: sessionResponse(request, reply, result) };
      },
    );

    // ---- MFA (TOTP). Bearer-authenticated: the access token is the proof of who is asking. ----

    scope.post(
      "/auth/mfa/totp/enrol",
      {
        schema: {
          summary: "Start authenticator-app enrolment",
          description:
            "Returns the otpauth URI and the secret, once. The factor counts only after `/auth/mfa/verify` with a code.",
          response: { 200: MfaEnrolResponse },
        },
        config: session,
      },
      async (request) => {
        requireUser(request);
        return service(request).enrolTotp(verifiedTokenOf(request).accessToken);
      },
    );

    scope.post(
      "/auth/mfa/challenge",
      {
        schema: {
          summary: "Open an MFA challenge",
          description: "Optional: `/auth/mfa/verify` opens one itself when `challengeId` is not sent.",
          body: MfaChallengeBody,
          response: { 200: MfaChallengeResponse },
        },
        config: session,
      },
      async (request) => {
        requireUser(request);
        return service(request).challengeMfa(verifiedTokenOf(request).accessToken, request.body?.factorId);
      },
    );

    scope.post(
      "/auth/mfa/verify",
      {
        schema: {
          summary: "Verify an authenticator code (completes enrolment, or step-up to aal2)",
          description: "Returns a new aal2 session whose `totp` proof is fresh (step-up lasts 10 minutes).",
          body: MfaVerifyBody,
          response: { 200: SignedIn },
        },
        config: credentials,
      },
      async (request, reply) => {
        requireUser(request);
        rejectForeignOrigin(request);
        const token = verifiedTokenOf(request);
        // Per account (not per IP, not per factor id a caller picks): a TOTP code is only six digits.
        const result = await limiter.guard(limiter.key("mfa-verify", token.subject), () =>
          service(request).verifyMfa(token.accessToken, request.body),
        );
        return { status: "signed_in" as const, session: sessionResponse(request, reply, result) };
      },
    );

    // ---- Google (PKCE). The verifier never leaves the API: it rides in a signed httpOnly cookie. ----

    scope.get(
      "/auth/google/start",
      {
        schema: {
          summary: "Redirect to Google sign-in",
          description: "Browser navigation. `next` is an allowlisted web path to return to.",
          security: [],
          querystring: GoogleStartQuery,
        },
        config: { rateLimitGroup: "authSession" },
      },
      async (request, reply) => {
        const { config, gotrue } = source();
        const { verifier, challenge } = newPkce();
        setOAuthCookie(
          reply,
          { verifier, next: safeNextPath(request.query.next) },
          { secret: config.cookieSecret, secure: config.cookieSecure, nowMs: now() },
        );
        return reply.redirect(
          gotrue.oauthAuthorizeUrl({
            provider: "google",
            redirectTo: `${config.apiPublicUrl}/v1/auth/google/callback`,
            codeChallenge: challenge,
          }),
          302,
        );
      },
    );

    scope.get(
      "/auth/google/callback",
      {
        schema: {
          summary: "Google return trip: exchange the code, set the session cookie, redirect to the web app",
          description:
            "Never puts a token in the redirect URL: the web app calls `/auth/refresh` to get its access token.",
          security: [],
          querystring: GoogleCallbackQuery,
        },
        config: { rateLimitGroup: "authSession" },
      },
      async (request, reply) => {
        const { config } = source();
        const state = readOAuthState(request, {
          secret: config.cookieSecret,
          secure: config.cookieSecure,
          nowMs: now(),
        });
        clearOAuthCookie(reply, config.cookieSecure);
        const failed = () => reply.redirect(`${config.webOrigin}/sign-in?error=oauth`, 302);
        const code = request.query.code;
        if (!state || !code || request.query.error !== undefined) return failed();
        try {
          const result = await service(request).exchangeGoogleCode(code, state.verifier);
          setRefreshCookie(reply, result.refreshToken, config.cookieSecure);
        } catch {
          return failed();
        }
        return reply.redirect(`${config.webOrigin}${state.next}`, 302);
      },
    );
  };
}
