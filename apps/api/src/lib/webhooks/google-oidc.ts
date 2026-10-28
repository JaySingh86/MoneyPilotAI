// Gmail Pub/Sub push authentication (BACKEND_PLAN §8.4): the push carries a Google-signed OIDC token.
// Verify signature (Google JWKS), issuer, audience, expiry, and that it was minted for our push service
// account with a verified email.
// https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { webhookRejected } from "./hmac";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface GoogleOidcOptions {
  /** The audience configured on the push subscription (our webhook URL or a fixed string). */
  audience: string;
  /** The push subscription's service account email. */
  serviceAccountEmail: string;
  /** Key source. Default: Google's JWKS, fetched and cached by jose. */
  jwks?: JWTVerifyGetKey;
  /** Current time in epoch ms (tests). */
  nowMs?: number;
}

let googleJwks: JWTVerifyGetKey | undefined;
function defaultJwks(): JWTVerifyGetKey {
  googleJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return googleJwks;
}

/** Verifies `Authorization: Bearer <token>` from a Pub/Sub push. Throws 401; returns the claims. */
export async function verifyGoogleOidcToken(
  authorization: string | undefined,
  options: GoogleOidcOptions,
): Promise<JWTPayload & { email: string }> {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!match?.[1]) throw webhookRejected("The push request has no bearer token.");

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(match[1], options.jwks ?? defaultJwks(), {
      issuer: GOOGLE_ISSUERS,
      audience: options.audience,
      algorithms: ["RS256"],
      clockTolerance: 60,
      requiredClaims: ["exp", "iat", "email"],
      ...(options.nowMs !== undefined ? { currentDate: new Date(options.nowMs) } : {}),
    }));
  } catch (err) {
    if (err instanceof joseErrors.JOSEError) throw webhookRejected("The push token is invalid.");
    throw err;
  }
  if (payload.email !== options.serviceAccountEmail || payload.email_verified !== true) {
    throw webhookRejected("The push token was not issued for our service account.");
  }
  return payload as JWTPayload & { email: string };
}
