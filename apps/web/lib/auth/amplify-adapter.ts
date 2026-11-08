// Cognito sign-in through Amplify Auth (ADR-017). Our screens, the UI kit's components; Amplify only
// talks to the user pool. There is no real user pool in this repo: the ids come from
// NEXT_PUBLIC_COGNITO_* (see .env.example) and nothing here holds a credential.
import { Amplify } from "aws-amplify";
import {
  confirmResetPassword,
  confirmSignIn,
  confirmSignUp,
  fetchAuthSession,
  fetchUserAttributes,
  resendSignUpCode,
  resetPassword,
  signIn,
  signInWithRedirect,
  signOut,
  signUp,
  setUpTOTP,
  updateMFAPreference,
  verifyTOTPSetup,
} from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";
import type { CognitoConfig } from "../config";
import { AuthError } from "./types";
import type { AuthAdapter, AuthSession, SignInStep } from "./types";

function configure(config: CognitoConfig): void {
  const redirect = typeof window === "undefined" ? "" : `${window.location.origin}/sign-in`;
  Amplify.configure(
    {
      Auth: {
        Cognito: {
          userPoolId: config.userPoolId,
          userPoolClientId: config.userPoolClientId,
          loginWith: config.oauthDomain
            ? {
                oauth: {
                  domain: config.oauthDomain,
                  scopes: ["openid", "email", "profile"],
                  redirectSignIn: [redirect],
                  redirectSignOut: [redirect],
                  responseType: "code",
                  providers: ["Google"],
                },
              }
            : undefined,
        },
      },
    },
    { ssr: false },
  );
}

/** Maps Amplify's exception names to our codes. Messages are written in `authMessage`. */
function toAuthError(error: unknown): AuthError {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAuthorizedException":
    case "UserNotFoundException":
      return new AuthError("invalid_credentials", name);
    case "CodeMismatchException":
      return new AuthError("invalid_code", name);
    case "ExpiredCodeException":
      return new AuthError("code_expired", name);
    case "InvalidPasswordException":
      return new AuthError("weak_password", name);
    case "UsernameExistsException":
      return new AuthError("user_exists", name);
    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException":
      return new AuthError("rate_limited", name);
    case "NetworkError":
      return new AuthError("network", name);
    default:
      return new AuthError("unknown", name || "unknown");
  }
}

function toStep(result: { isSignedIn: boolean; nextStep: { signInStep: string } }): SignInStep {
  if (result.isSignedIn) return { step: "done" };
  switch (result.nextStep.signInStep) {
    case "DONE":
      return { step: "done" };
    case "CONFIRM_SIGN_IN_WITH_TOTP_CODE":
      return { step: "totp" };
    case "CONFIRM_SIGN_UP":
      return { step: "confirm_sign_up" };
    default:
      return {
        step: "unsupported",
        detail: "This sign-in needs a step these screens don’t handle yet. Try again from the mobile app.",
      };
  }
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toAuthError(error);
  }
}

export function createAmplifyAdapter(config: CognitoConfig | null): AuthAdapter {
  if (config) configure(config);
  const requireConfig = (): void => {
    if (!config) throw new AuthError("not_configured", "Cognito is not configured");
  };
  return {
    kind: "cognito",
    async getSession(): Promise<AuthSession | null> {
      if (!config) return null;
      try {
        const session = await fetchAuthSession();
        const accessToken = session.tokens?.accessToken?.toString();
        if (!accessToken) return null;
        const email = session.tokens?.idToken?.payload.email;
        const given = session.tokens?.idToken?.payload.given_name;
        let firstName = typeof given === "string" ? given : null;
        if (firstName === null) {
          const attributes = await fetchUserAttributes().catch(() => ({}) as Record<string, string>);
          firstName = attributes.given_name ?? null;
        }
        return { accessToken, email: typeof email === "string" ? email : null, firstName };
      } catch {
        return null;
      }
    },
    async signIn(email, password) {
      requireConfig();
      return toStep(await call(() => signIn({ username: email, password })));
    },
    async confirmTotp(code) {
      requireConfig();
      return toStep(await call(() => confirmSignIn({ challengeResponse: code })));
    },
    async signUp({ email, password, firstName }) {
      requireConfig();
      const result = await call(() =>
        signUp({
          username: email,
          password,
          options: { userAttributes: { email, given_name: firstName } },
        }),
      );
      return result.isSignUpComplete ? { step: "done" } : { step: "confirm_sign_up" };
    },
    async confirmSignUp(email, code) {
      requireConfig();
      await call(() => confirmSignUp({ username: email, confirmationCode: code }));
    },
    async resendSignUpCode(email) {
      requireConfig();
      await call(() => resendSignUpCode({ username: email }));
    },
    async requestPasswordReset(email) {
      requireConfig();
      await call(() => resetPassword({ username: email }));
    },
    async confirmPasswordReset(email, code, newPassword) {
      requireConfig();
      await call(() => confirmResetPassword({ username: email, confirmationCode: code, newPassword }));
    },
    async signInWithGoogle() {
      requireConfig();
      await call(() => signInWithRedirect({ provider: "Google" }));
    },
    async stepUp() {
      requireConfig();
      // Cognito has no "re-check my TOTP and stamp the token" call. The real wiring (a TOTP challenge that
      // refreshes the access token with a new auth time) lands with WP-09's pool configuration (Q-176).
      throw new AuthError("step_up_unavailable", "step-up is not wired to the user pool yet");
    },
    async setUpTotp() {
      requireConfig();
      const details = await call(() => setUpTOTP());
      return {
        sharedSecret: details.sharedSecret,
        setupUri: details.getSetupUri("MoneyPilot").toString(),
        async confirm(code: string) {
          await call(() => verifyTOTPSetup({ code }));
          await call(() => updateMFAPreference({ totp: "PREFERRED" }));
        },
      };
    },
    async signOut() {
      if (config) await call(() => signOut());
    },
    onTokensChanged(listener) {
      return Hub.listen("auth", ({ payload }) => {
        if (payload.event === "signedIn" || payload.event === "tokenRefresh") listener();
      });
    },
  };
}
