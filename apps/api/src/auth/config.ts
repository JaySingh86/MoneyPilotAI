// Cognito settings from the environment (ADR-017). In production a missing or inconsistent setting is a
// startup failure, never a silent "refuse every token": the caller exits. Elsewhere missing settings mean
// "sign-in not configured" (null), so local dev without a pool still serves anonymous routes.
import type { CognitoConfig } from "./cognito";

export class AuthConfigError extends Error {
  override readonly name = "AuthConfigError";
}

const POOL_ID = /^([a-z]{2}(?:-[a-z]+)+-\d)_[A-Za-z0-9]+$/;

export interface AuthEnv {
  NODE_ENV?: string | undefined;
  COGNITO_REGION?: string | undefined;
  COGNITO_USER_POOL_ID?: string | undefined;
  COGNITO_CLIENT_ID?: string | undefined;
}

export function loadCognitoConfig(env: AuthEnv): CognitoConfig | null {
  const { COGNITO_REGION: region, COGNITO_USER_POOL_ID: userPoolId, COGNITO_CLIENT_ID: clientId } = env;
  if (!region || !userPoolId || !clientId) {
    if (env.NODE_ENV === "production") {
      throw new AuthConfigError(
        "COGNITO_REGION, COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required in production.",
      );
    }
    return null;
  }
  const match = POOL_ID.exec(userPoolId);
  if (!match)
    throw new AuthConfigError("COGNITO_USER_POOL_ID is not a user pool id (expected <region>_<id>).");
  if (match[1] !== region) {
    throw new AuthConfigError("COGNITO_REGION does not match the region in COGNITO_USER_POOL_ID.");
  }
  return { region, userPoolId, clientId };
}
