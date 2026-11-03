// A fake Cognito issuer for tests and local tooling (ADR-017): a locally generated RSA key, its JWKS, and
// a signer that produces access tokens shaped like Cognito's (with the pre-token-generation claims).
// There is no network and no AWS credential anywhere. Never import this from production code paths.
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { SimpleJwksCache } from "aws-jwt-verify/jwk";
import type { Jwks } from "aws-jwt-verify/jwk";
import type { CognitoConfig } from "../cognito";

export interface FakeIssuerOptions {
  region?: string;
  userPoolId?: string;
  clientId?: string;
  kid?: string;
}

export interface TokenOptions {
  /** Claim overrides. A key set to `undefined` is removed from the token. */
  claims?: Record<string, unknown>;
  /** Epoch seconds used for iat/auth_time and as the base for exp. Default: now. */
  nowSeconds?: number;
  /** Lifetime in seconds from `nowSeconds`; negative makes an expired token. Default 3600. */
  lifetimeSeconds?: number;
  /** Header `alg` for `signRaw` style attacks; normal tokens are RS256. */
  kid?: string;
}

export class FakeIssuer {
  readonly region: string;
  readonly userPoolId: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly kid: string;
  private constructor(
    private readonly privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
    readonly jwks: Jwks,
    options: Required<FakeIssuerOptions>,
  ) {
    this.region = options.region;
    this.userPoolId = options.userPoolId;
    this.clientId = options.clientId;
    this.kid = options.kid;
    this.issuer = `https://cognito-idp.${options.region}.amazonaws.com/${options.userPoolId}`;
  }

  static async create(options: FakeIssuerOptions = {}): Promise<FakeIssuer> {
    const resolved: Required<FakeIssuerOptions> = {
      region: options.region ?? "us-east-1",
      userPoolId: options.userPoolId ?? "us-east-1_TestPool1",
      clientId: options.clientId ?? "test-client-id-0123456789",
      kid: options.kid ?? "fake-key-1",
    };
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk: JWK = { ...(await exportJWK(publicKey)), kid: resolved.kid, alg: "RS256", use: "sig" };
    return new FakeIssuer(privateKey, { keys: [jwk] } as Jwks, resolved);
  }

  /** The config a `createCognitoProvider` needs, with the JWKS served from memory (never the network). */
  cognitoConfig(): CognitoConfig {
    const cache = new SimpleJwksCache({
      fetcher: {
        fetch: async () => {
          throw new Error("FakeIssuer: network access is not allowed in tests");
        },
      },
    });
    cache.addJwks(`${this.issuer}/.well-known/jwks.json`, this.jwks);
    return {
      region: this.region,
      userPoolId: this.userPoolId,
      clientId: this.clientId,
      jwksCache: cache,
    };
  }

  /** A signed Cognito-shaped access token. Defaults: verified email, MFA on, signed in just now. */
  async accessToken(subject: string, options: TokenOptions = {}): Promise<string> {
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      sub: subject,
      iss: this.issuer,
      client_id: this.clientId,
      token_use: "access",
      scope: "aws.cognito.signin.user.admin",
      auth_time: now,
      jti: crypto.randomUUID(),
      username: subject,
      email: `${subject}@example.test`,
      email_verified: true,
      mfa_enabled: true,
      mfa_verified_at: now,
      ...options.claims,
    };
    for (const [key, value] of Object.entries(claims)) {
      if (value === undefined) delete claims[key];
    }
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: options.kid ?? this.kid })
      .setIssuedAt(now)
      .setExpirationTime(now + (options.lifetimeSeconds ?? 3600))
      .sign(this.privateKey);
  }

  /** An ID token for the same user (`token_use: id`, `aud` instead of `client_id`). */
  async idToken(subject: string, options: TokenOptions = {}): Promise<string> {
    return this.accessToken(subject, {
      ...options,
      claims: {
        token_use: "id",
        client_id: undefined,
        aud: this.clientId,
        "cognito:username": subject,
        ...options.claims,
      },
    });
  }
}
