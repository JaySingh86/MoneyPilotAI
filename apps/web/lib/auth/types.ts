// The sign-in adapter (ADR-017): our own screens call this; the Cognito implementation uses Amplify
// Auth, and mock mode swaps in a fake so `pnpm dev` runs without AWS.

export interface AuthSession {
  /** Cognito access token, sent to the API as `Authorization: Bearer` (ADR-017). */
  accessToken: string;
  email: string | null;
  /** From the sign-up form; the first `POST /me/bootstrap` needs it (the token has no trusted name). */
  firstName: string | null;
}

/** What the sign-in screen must do next. */
export type SignInStep =
  | { step: "done" }
  /** Enter the 6-digit code from the authenticator app. */
  | { step: "totp" }
  /** The email address is not confirmed yet: enter the code we sent. */
  | { step: "confirm_sign_up" }
  /** Cognito wants a challenge these screens do not handle yet (passkey, MFA setup, new password). */
  | { step: "unsupported"; detail: string };

export type AuthErrorCode =
  | "invalid_credentials"
  | "invalid_code"
  | "code_expired"
  | "weak_password"
  | "user_exists"
  | "rate_limited"
  | "not_configured"
  | "step_up_unavailable"
  | "network"
  | "unknown";

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface SignUpInput {
  email: string;
  password: string;
  firstName: string;
}

/** A started TOTP setup: show the secret (or the `otpauth://` link as a QR code), then confirm with a code. */
export interface TotpSetup {
  /** The shared secret, to type into an authenticator app. */
  sharedSecret: string;
  /** The `otpauth://` URI an authenticator app can scan. */
  setupUri: string;
  /** Checks the first code from the app and turns 2-step verification on. */
  confirm(code: string): Promise<void>;
}

export interface AuthAdapter {
  readonly kind: "cognito" | "mock";
  /** The current session, refreshing expired tokens. Null when signed out. */
  getSession(): Promise<AuthSession | null>;
  signIn(email: string, password: string): Promise<SignInStep>;
  confirmTotp(code: string): Promise<SignInStep>;
  signUp(input: SignUpInput): Promise<SignInStep>;
  confirmSignUp(email: string, code: string): Promise<void>;
  resendSignUpCode(email: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  confirmPasswordReset(email: string, code: string, newPassword: string): Promise<void>;
  /** Federated sign-in; leaves the page. */
  signInWithGoogle(): Promise<void>;
  /**
   * Step-up (ADR-018): proves a fresh TOTP code and refreshes the access token, so the next request to a
   * step-up route (leave, export, delete, connect email) carries a recent MFA time. Throws `invalid_code`.
   */
  stepUp(code: string): Promise<void>;
  /** Starts TOTP enrollment for the signed-in user (the "Turn on 2-step verification" action). */
  setUpTotp(): Promise<TotpSetup>;
  signOut(): Promise<void>;
  /**
   * Calls `listener` after a sign-in and after every token refresh, so the app can sync the user
   * (`POST /me/bootstrap`) with the new claims. Returns an unsubscribe function.
   */
  onTokensChanged(listener: () => void): () => void;
}

/** Friendly copy for an auth failure. Never says whether an account exists. */
export function authMessage(error: unknown): string {
  if (error instanceof AuthError) {
    switch (error.code) {
      case "invalid_credentials":
        return "That email and password don’t match. Check them and try again.";
      case "invalid_code":
        return "That code isn’t right. Check it and try again.";
      case "code_expired":
        return "That code has expired. Ask for a new one.";
      case "weak_password":
        return "Choose a longer password with upper and lower case letters and a number.";
      case "user_exists":
        return "We couldn’t create that account. Try signing in instead.";
      case "rate_limited":
        return "Too many tries. Wait a few minutes and try again.";
      case "not_configured":
        return "Sign-in isn’t set up for this environment yet.";
      case "step_up_unavailable":
        return "The 2-step check isn’t available yet in this environment.";
      case "network":
        return "We couldn’t reach the sign-in service. Check your connection and try again.";
      default:
        return "Something went wrong. Try again.";
    }
  }
  return "Something went wrong. Try again.";
}
