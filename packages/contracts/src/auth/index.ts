// Auth contracts (ADR-020): web and mobile call these `/v1/auth/*` routes; only the API talks to Supabase Auth.
//
// Clients: `X-MP-Client: web | mobile` (default `web`). Web gets the refresh token as an httpOnly cookie
// scoped to `/v1/auth` and never in a body; mobile gets it in `session.refreshToken` and sends it back in the
// refresh body. Web calls that use the cookie (refresh, sign-out) must also send `X-MP-Client: web` and a
// matching `Origin` (CSRF).
//
// Errors never reveal whether an account exists: sign-up, resend and reset requests always answer 202, and a
// wrong email or password is one generic 401.
import { z } from "zod";
import { Timestamp } from "../common";

export const AUTH_CLIENT_HEADER = "x-mp-client";
export const AuthClient = z.enum(["web", "mobile"]);
export type AuthClient = z.infer<typeof AuthClient>;

const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
/** Supabase hashes with bcrypt, which ignores everything past 72 bytes: refuse longer ones. */
const Password = z.string().min(8).max(72);
const FirstName = z.string().trim().min(1).max(80);
/** Numeric one-time code from the email (Supabase sends 6 to 8 digits). */
const OtpCode = z.string().regex(/^\d{6,8}$/, "Expected the numeric code from the email");
const TokenHash = z
  .string()
  .min(8)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);
const TotpCode = z.string().regex(/^\d{6}$/, "Expected the 6-digit code");
const FactorId = z.uuid();

export const AuthSession = z
  .object({
    accessToken: z.string().describe("Send as Authorization: Bearer. Keep it in memory only."),
    expiresAt: Timestamp,
    aal: z.enum(["aal1", "aal2"]).describe("aal2: a TOTP code was verified in this session."),
    refreshToken: z
      .string()
      .optional()
      .describe("Only for `X-MP-Client: mobile`. Web gets an httpOnly cookie instead."),
  })
  .meta({ id: "AuthSession" });
export type AuthSession = z.infer<typeof AuthSession>;

export const SignedIn = z
  .object({ status: z.literal("signed_in"), session: AuthSession })
  .meta({ id: "AuthSignedIn" });
export type SignedIn = z.infer<typeof SignedIn>;

export const SignUpBody = z
  .object({ firstName: FirstName, email: Email, password: Password })
  .strict()
  .meta({ id: "SignUpBody" });
export type SignUpBody = z.infer<typeof SignUpBody>;

export const Accepted = z.object({ status: z.literal("accepted") }).meta({ id: "AuthAccepted" });

/** Confirm with the emailed code (`email` + `code`) or the link's `tokenHash`. */
export const ConfirmEmailBody = z
  .object({ email: Email.optional(), code: OtpCode.optional(), tokenHash: TokenHash.optional() })
  .strict()
  .refine((b) => (b.tokenHash !== undefined) !== (b.email !== undefined && b.code !== undefined), {
    message: "Send either email and code, or tokenHash",
  })
  .meta({ id: "ConfirmEmailBody" });
export type ConfirmEmailBody = z.infer<typeof ConfirmEmailBody>;

export const EmailBody = z.object({ email: Email }).strict().meta({ id: "AuthEmailBody" });

export const SignInBody = z
  .object({ email: Email, password: z.string().min(1).max(72) })
  .strict()
  .meta({ id: "SignInBody" });
export type SignInBody = z.infer<typeof SignInBody>;

/**
 * `mfa_required`: the password was right and the account has an authenticator. The session is aal1 (enough for
 * everyday use, ADR-018); the client should ask for the code and call `/auth/mfa/verify`.
 * `confirm_email`: the password was right but the address is not confirmed yet (no session; offer a resend).
 * It is only returned after a correct password, so it does not reveal accounts to strangers.
 */
export const SignInResponse = z
  .discriminatedUnion("status", [
    SignedIn,
    z.object({ status: z.literal("mfa_required"), factorId: FactorId, session: AuthSession }),
    z.object({ status: z.literal("confirm_email") }),
  ])
  .meta({ id: "SignInResponse" });
export type SignInResponse = z.infer<typeof SignInResponse>;

export const RefreshBody = z
  .object({ refreshToken: z.string().min(1).max(512).optional() })
  .strict()
  .nullish()
  .meta({ id: "RefreshBody" });

export const PasswordResetBody = z
  .object({
    email: Email.optional(),
    code: OtpCode.optional(),
    tokenHash: TokenHash.optional(),
    newPassword: Password,
    mfaCode: TotpCode.optional().describe("Needed when the account has an authenticator app."),
  })
  .strict()
  .refine((b) => (b.tokenHash !== undefined) !== (b.email !== undefined && b.code !== undefined), {
    message: "Send either email and code, or tokenHash",
  })
  .meta({ id: "PasswordResetBody" });
export type PasswordResetBody = z.infer<typeof PasswordResetBody>;

export const MfaEnrolResponse = z
  .object({
    factorId: FactorId,
    otpauthUri: z.string().describe("otpauth:// URI for the QR code. Shown once."),
    secret: z.string().describe("The same secret for manual entry. Shown once."),
  })
  .meta({ id: "MfaEnrolResponse" });

/** `factorId` is optional: the account's verified TOTP factor is used. Enrolment must send the new factor's id. */
export const MfaChallengeBody = z
  .object({ factorId: FactorId.optional() })
  .strict()
  .nullish()
  .meta({ id: "MfaChallengeBody" });
export const MfaChallengeResponse = z
  .object({ factorId: FactorId, challengeId: z.uuid() })
  .meta({ id: "MfaChallengeResponse" });

/** Without `challengeId` the API opens the challenge itself (the usual step-up call: just `{ code }`). */
export const MfaVerifyBody = z
  .object({ factorId: FactorId.optional(), challengeId: z.uuid().optional(), code: TotpCode })
  .strict()
  .meta({ id: "MfaVerifyBody" });
export type MfaVerifyBody = z.infer<typeof MfaVerifyBody>;

// Query schemas stay inline (no `id`): the OpenAPI exporter cannot $ref a named schema in a query.
export const GoogleStartQuery = z.object({ next: z.string().max(512).optional() });
export const GoogleCallbackQuery = z.object({
  code: z.string().min(1).max(512).optional(),
  error: z.string().max(200).optional(),
  error_code: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});
