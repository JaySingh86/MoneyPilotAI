// Webhook verification helpers (BACKEND_PLAN §8.4). The webhooks module verifies first, then records the
// event in `webhook_events` (idempotency) and enqueues a job; it never trusts a payload it did not verify.
export {
  assertFreshTimestamp,
  constantTimeEqual,
  signHmac,
  verifyHmacSignature,
  webhookRejected,
  type HmacAlgorithm,
  type HmacVerifyInput,
  type SignatureEncoding,
} from "./hmac";
export {
  checkSigningCertificate,
  createCertificateLoader,
  isTrustedSigningCertUrl,
  snsHost,
  snsStringToSign,
  topicRegion,
  trustedSubscribeUrl,
  verifySnsMessage,
  type CertificateLoader,
  type SnsMessage,
  type SnsVerifyOptions,
} from "./sns";
export { GOOGLE_JWKS_URL, verifyGoogleOidcToken, type GoogleOidcOptions } from "./google-oidc";
export { assertGraphClientState, graphValidationResponse } from "./graph";
