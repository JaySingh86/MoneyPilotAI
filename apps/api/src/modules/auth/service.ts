// Auth logic: proxies Supabase Auth and turns its failures into generic, account-neutral errors.
// Hard rule 8: nothing here logs, and no error detail contains an email, code or token.
import { randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import {
  AppError,
  type AuthSession,
  type ConfirmEmailBody,
  type MfaVerifyBody,
  type PasswordResetBody,
  type SignInBody,
  type SignUpBody,
} from "@mp/contracts";
import { GoTrueError, type GoTrueClient, type GoTrueFactor, type GoTrueSession } from "../../auth/gotrue";

export type SignInOutcome =
  | { status: "signed_in"; session: GoTrueSession }
  | { status: "mfa_required"; factorId: string; session: GoTrueSession }
  | { status: "confirm_email" };

const UNAVAILABLE = "Sign-in is temporarily unavailable. Try again shortly.";
const RATE_LIMIT_CODES = new Set([
  "over_request_rate_limit",
  "over_email_send_rate_limit",
  "over_sms_send_rate_limit",
]);

/** Failures that say nothing about the caller's input: provider down, or the provider's own rate limit. */
function infrastructureError(err: unknown): AppError | null {
  if (!(err instanceof GoTrueError)) return new AppError("internal_error", 503, UNAVAILABLE);
  if (err.status === 429 || RATE_LIMIT_CODES.has(err.errorCode)) {
    return new AppError("rate_limited", 429, "Too many attempts. Try again in a minute.", {
      headers: { "retry-after": "60" },
    });
  }
  if (err.unavailable) return new AppError("internal_error", 503, UNAVAILABLE);
  return null;
}

const isProviderRateLimit = (err: unknown): boolean =>
  err instanceof GoTrueError && (err.status === 429 || RATE_LIMIT_CODES.has(err.errorCode));

/** Counts provider-side rate limits (a metric: never the address). */
export interface AuthMetrics {
  providerRateLimited(route: "sign_up" | "resend" | "password_reset_request"): void;
  /** Revoking the user's other sessions after a reset failed (they stay valid until they expire). */
  logoutOthersFailed(): void;
}

const rethrow = (err: unknown): never => {
  throw infrastructureError(err) ?? err;
};

const verifiedTotp = (factors: readonly GoTrueFactor[]): GoTrueFactor | undefined =>
  factors.find((f) => f.type === "totp" && f.status === "verified");

/** The `aal` claim of a token GoTrue just issued to us (not verified again: it came straight from Supabase). */
export function aalOf(accessToken: string): "aal1" | "aal2" {
  try {
    return decodeJwt(accessToken).aal === "aal2" ? "aal2" : "aal1";
  } catch {
    return "aal1";
  }
}

export function toAuthSession(session: GoTrueSession, includeRefresh: boolean): AuthSession {
  return {
    accessToken: session.accessToken,
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
    aal: aalOf(session.accessToken),
    ...(includeRefresh ? { refreshToken: session.refreshToken } : {}),
  };
}

export class AuthService {
  constructor(
    private readonly gotrue: GoTrueClient,
    private readonly metrics: AuthMetrics = {
      providerRateLimited: () => undefined,
      logoutOthersFailed: () => undefined,
    },
  ) {}

  /**
   * Always succeeds from the caller's view when the address is already registered or the provider declines
   * for a reason that depends on the account (no enumeration). A weak password is the caller's own input.
   */
  async signUp(body: SignUpBody): Promise<void> {
    try {
      await this.gotrue.signUp(body);
    } catch (err) {
      // The provider's per-address email limit would tell a caller that this address was mailed recently.
      if (isProviderRateLimit(err)) return this.metrics.providerRateLimited("sign_up");
      const infra = infrastructureError(err);
      if (infra) throw infra;
      if (err instanceof GoTrueError) {
        if (err.errorCode === "weak_password") {
          throw new AppError("validation_failed", 400, "Choose a stronger password.", {
            fields: [{ in: "body", path: "password", message: "That password is too easy to guess" }],
          });
        }
        // user_already_exists, email_exists, signup_disabled, ...: indistinguishable from success.
        return;
      }
      throw err;
    }
  }

  async confirmEmail(body: ConfirmEmailBody): Promise<GoTrueSession> {
    try {
      return await this.gotrue.verifyOtp(
        body.tokenHash !== undefined
          ? { type: "signup", tokenHash: body.tokenHash }
          : { type: "signup", email: body.email ?? "", token: body.code ?? "" },
      );
    } catch (err) {
      return invalidCode(err);
    }
  }

  /** 202 whether or not the account exists. */
  async resendConfirmation(email: string): Promise<void> {
    try {
      await this.gotrue.resendSignup(email);
    } catch (err) {
      if (isProviderRateLimit(err)) return this.metrics.providerRateLimited("resend");
      const infra = infrastructureError(err);
      if (infra) throw infra;
    }
  }

  async signIn(body: SignInBody): Promise<SignInOutcome> {
    let session: GoTrueSession;
    try {
      session = await this.gotrue.signInWithPassword(body);
    } catch (err) {
      const infra = infrastructureError(err);
      if (infra) throw infra;
      // Supabase checks the password first, so this is only said to someone who knows it.
      if (err instanceof GoTrueError && err.errorCode === "email_not_confirmed") {
        return { status: "confirm_email" };
      }
      throw new AppError("unauthorized", 401, "Email or password is incorrect.");
    }
    const user = await this.gotrue.getUser(session.accessToken).catch(rethrow);
    const factor = verifiedTotp(user.factors);
    return factor
      ? { status: "mfa_required", factorId: factor.id, session }
      : { status: "signed_in", session };
  }

  async refresh(refreshToken: string): Promise<GoTrueSession> {
    try {
      return await this.gotrue.refresh(refreshToken);
    } catch (err) {
      const infra = infrastructureError(err);
      if (infra) throw infra;
      throw new AppError("unauthorized", 401, "Your session has ended. Sign in again.");
    }
  }

  /** Best effort: the caller is signed out locally either way. */
  async signOut(accessToken: string): Promise<void> {
    await this.gotrue.logout(accessToken).catch(() => undefined);
  }

  async requestPasswordReset(email: string): Promise<void> {
    try {
      await this.gotrue.recover(email);
    } catch (err) {
      if (isProviderRateLimit(err)) return this.metrics.providerRateLimited("password_reset_request");
      const infra = infrastructureError(err);
      if (infra) throw infra;
    }
  }

  async confirmPasswordReset(body: PasswordResetBody): Promise<GoTrueSession> {
    let session: GoTrueSession;
    try {
      session = await this.gotrue.verifyOtp(
        body.tokenHash !== undefined
          ? { type: "recovery", tokenHash: body.tokenHash }
          : { type: "recovery", email: body.email ?? "", token: body.code ?? "" },
      );
    } catch (err) {
      return invalidCode(err);
    }
    // An account with an authenticator needs its code to change the password. Checked here, not left to the
    // provider: the recovery session is aal1 and must never be usable without the second factor.
    const user = await this.gotrue.getUser(session.accessToken).catch(async (err: unknown) => {
      await this.signOut(session.accessToken);
      return rethrow(err);
    });
    const factor = verifiedTotp(user.factors);
    if (factor) {
      if (body.mfaCode === undefined) {
        await this.signOut(session.accessToken); // do not leave a half-finished recovery session open
        throw new AppError("mfa_required", 403, "Enter the code from your authenticator app as well.");
      }
      try {
        session = await this.completeMfa(session.accessToken, factor.id, undefined, body.mfaCode);
      } catch (err) {
        await this.signOut(session.accessToken);
        throw err;
      }
    }
    try {
      await this.gotrue.updatePassword(session.accessToken, body.newPassword);
    } catch (err) {
      const infra = infrastructureError(err);
      if (infra) throw infra;
      await this.signOut(session.accessToken); // do not leave a half-finished recovery session open
      if (err instanceof GoTrueError && err.errorCode === "insufficient_aal") {
        throw new AppError("mfa_required", 403, "Enter the code from your authenticator app as well.");
      }
      if (err instanceof GoTrueError && err.errorCode === "weak_password") {
        throw new AppError("validation_failed", 400, "Choose a stronger password.", {
          fields: [{ in: "body", path: "newPassword", message: "That password is too easy to guess" }],
        });
      }
      throw new AppError("bad_request", 400, "The password could not be changed.");
    }
    // A reset means the old password may be compromised: end every other session.
    await this.gotrue.logoutOthers(session.accessToken).catch(() => this.metrics.logoutOthersFailed());
    return session;
  }

  // ---- MFA (TOTP) ----

  /** The secret and URI are shown once; nothing is stored here. */
  async enrolTotp(accessToken: string): Promise<{ factorId: string; otpauthUri: string; secret: string }> {
    // Adding a second authenticator would let an aal1 session (password only, or a password reset) mint its own
    // "second factor" and then pass step-up. With a verified factor, enrolling needs proof of it (aal2).
    const user = await this.gotrue.getUser(accessToken).catch(rethrow);
    if (verifiedTotp(user.factors) && aalOf(accessToken) !== "aal2") {
      throw new AppError("mfa_required", 403, "Confirm with your authenticator app first.");
    }
    try {
      const factor = await this.gotrue.mfaEnrollTotp(
        accessToken,
        `MoneyPilot ${randomBytes(4).toString("hex")}`,
      );
      return { factorId: factor.factorId, otpauthUri: factor.uri, secret: factor.secret };
    } catch (err) {
      return rethrow(err);
    }
  }

  /**
   * The factor a challenge or verify may use. With a verified factor on the account it is that factor and no
   * other (a new or foreign id is refused). Only an account with no verified factor may verify one of its own
   * unverified factors, which is enrolment.
   */
  private async resolveFactor(accessToken: string, factorId: string | undefined): Promise<string> {
    const user = await this.gotrue.getUser(accessToken).catch(rethrow);
    const verified = verifiedTotp(user.factors);
    if (verified) {
      if (factorId !== undefined && factorId !== verified.id) {
        throw new AppError("forbidden", 403, "That authenticator is not the one set up on this account.");
      }
      return verified.id;
    }
    const pending = factorId === undefined ? undefined : user.factors.find((f) => f.id === factorId);
    if (!pending) throw new AppError("not_found", 404, "No authenticator app is set up on this account.");
    return pending.id;
  }

  async challengeMfa(
    accessToken: string,
    factorId: string | undefined,
  ): Promise<{ factorId: string; challengeId: string }> {
    const id = await this.resolveFactor(accessToken, factorId);
    try {
      const { challengeId } = await this.gotrue.mfaChallenge(accessToken, id);
      return { factorId: id, challengeId };
    } catch (err) {
      return mfaFailure(err);
    }
  }

  /** Verifies a code: completes enrolment (a new factor) or upgrades the session to aal2 (step-up). */
  async verifyMfa(accessToken: string, body: MfaVerifyBody): Promise<GoTrueSession> {
    const factorId = await this.resolveFactor(accessToken, body.factorId);
    return this.completeMfa(accessToken, factorId, body.challengeId, body.code);
  }

  private async completeMfa(
    accessToken: string,
    factorId: string,
    challengeId: string | undefined,
    code: string,
  ): Promise<GoTrueSession> {
    try {
      const challenge = challengeId ?? (await this.gotrue.mfaChallenge(accessToken, factorId)).challengeId;
      return await this.gotrue.mfaVerify({ accessToken, factorId, challengeId: challenge, code });
    } catch (err) {
      return mfaFailure(err);
    }
  }

  // ---- Google ----

  async exchangeGoogleCode(authCode: string, codeVerifier: string): Promise<GoTrueSession> {
    return this.gotrue.exchangePkceCode({ authCode, codeVerifier });
  }
}

function invalidCode(err: unknown): never {
  const infra = infrastructureError(err);
  if (infra) throw infra;
  throw new AppError("bad_request", 400, "That code is invalid or has expired. Ask for a new one.");
}

function mfaFailure(err: unknown): never {
  const infra = infrastructureError(err);
  if (infra) throw infra;
  throw new AppError(
    "bad_request",
    400,
    "That code didn't work. Check your authenticator app and try again.",
  );
}
