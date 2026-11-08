// A fake Supabase Auth for tests and local tooling (ADR-020): a locally generated ES256 key and its JWKS, a
// signer for access tokens shaped like Supabase's, and an in-memory GoTrue REST server behind a `fetch`
// function. There is no network and no Supabase credential anywhere. Never import this from production code.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";
import { createGoTrueClient, type GoTrueClient, type GoTrueConfig } from "../gotrue";
import type { SupabaseProviderConfig } from "../supabase";

export const FAKE_SUPABASE_URL = "https://fake-ref.supabase.co";
export const FAKE_PUBLISHABLE_KEY = "sb_publishable_fake";
export const FAKE_SECRET_KEY = "sb_secret_fake";
/** The only TOTP code the fake accepts. */
export const FAKE_TOTP_CODE = "123456";

type Amr = { method: string; timestamp: number };
type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

interface FakeFactor {
  id: string;
  type: "totp";
  status: "verified" | "unverified";
  secret: string;
}

export interface FakeUser {
  id: string;
  email: string | null;
  password: string | null;
  confirmed: boolean;
  provider: "email" | "google";
  firstName: string | null;
  factors: FakeFactor[];
}

interface FakeSession {
  sessionId: string;
  userId: string;
  amr: Amr[];
}

export interface TokenOptions {
  /** Email claim and user email. `undefined` explicitly: no email at all. Default `<subject>@example.test`. */
  email?: string | undefined;
  /** Whether the user's email is confirmed in the provider's user record. Default true. */
  emailConfirmed?: boolean;
  /** The user has a verified TOTP factor, and the token proves it (aal2 with a fresh `totp` amr). Default true. */
  totp?: boolean;
  /** Epoch seconds of the `totp` amr entry (default `nowSeconds`). `null`: aal1 even when a factor exists. */
  totpAt?: number | null;
  /**
   * Claim overrides. A key set to `undefined` is removed from the token.
   *
   * Compatibility: about fifteen suites (and unmerged branches) still pass the Cognito-era keys `email`,
   * `email_verified`, `mfa_enabled` and `mfa_verified_at` here. They are mapped to the fake provider's user
   * record and `amr` instead of becoming claims. New tests use `email`, `emailConfirmed`, `totp` and `totpAt`.
   */
  claims?: Record<string, unknown>;
  /** Epoch seconds used for iat and as the base for exp. Default: now. */
  nowSeconds?: number;
  /** Lifetime in seconds from `nowSeconds`; negative makes an expired token. Default 3600. */
  lifetimeSeconds?: number;
  kid?: string;
}

export interface MailboxEntry {
  kind: "signup" | "recovery";
  email: string;
  /** The OTP code from the email. */
  code: string;
  /** The `token_hash` from the email link. */
  tokenHash: string;
}

export interface RestCall {
  method: string;
  /** Path under `/auth/v1`, without the query string. */
  path: string;
  /** The raw body, for asserting that a password was sent (tests only; never log it). */
  body: unknown;
  hasBearer: boolean;
}

const json = (status: number, body: unknown): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const gotrueError = (status: number, errorCode: string): Response =>
  json(status, { code: status, error_code: errorCode, msg: `fake: ${errorCode}` });

export class FakeSupabase {
  readonly url = FAKE_SUPABASE_URL;
  readonly issuer = `${FAKE_SUPABASE_URL}/auth/v1`;
  readonly kid: string;
  readonly users = new Map<string, FakeUser>();
  readonly mailbox: MailboxEntry[] = [];
  readonly calls: RestCall[] = [];
  /** Makes the next REST call fail with a 500, once. */
  failNext = false;
  /**
   * Models GoTrue's own aal rules (enrolling a factor needs aal2 once one is verified). Tests turn it off to prove
   * the API enforces these rules itself and never relies on the provider for them.
   */
  enforceAal = true;
  /** Makes sign-up, resend and recover answer like Supabase's per-address email limit (429). */
  rateLimitEmails = false;
  /** Makes calls to this path (under /auth/v1) fail with a 500, until cleared. */
  failPath: string | null = null;
  private readonly sessions = new Map<string, FakeSession>();
  private readonly refreshTokens = new Map<string, string>();
  private readonly challenges = new Map<string, string>();
  private readonly oauthCodes = new Map<string, { userId: string; challenge: string }>();

  private constructor(
    private readonly privateKey: KeyPair["privateKey"],
    readonly jwks: { keys: JWK[] },
    kid: string,
  ) {
    this.kid = kid;
  }

  static async create(options: { kid?: string } = {}): Promise<FakeSupabase> {
    const kid = options.kid ?? "fake-key-1";
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
    return new FakeSupabase(privateKey, { keys: [jwk] }, kid);
  }

  get getKey(): JWTVerifyGetKey {
    return createLocalJWKSet(this.jwks);
  }

  gotrueConfig(): GoTrueConfig {
    return {
      url: this.url,
      publishableKey: FAKE_PUBLISHABLE_KEY,
      secretKey: FAKE_SECRET_KEY,
      fetch: this.fetch,
    };
  }

  gotrue(): GoTrueClient {
    return createGoTrueClient(this.gotrueConfig());
  }

  /** The config `createSupabaseProvider` needs, with the JWKS served from memory (never the network). */
  providerConfig(): SupabaseProviderConfig {
    return { url: this.url, gotrue: this.gotrue(), getKey: this.getKey };
  }

  /** The newest mailbox entry for an address (what the user would read in their inbox). */
  lastMail(email: string, kind: MailboxEntry["kind"]): MailboxEntry | undefined {
    return [...this.mailbox].reverse().find((m) => m.email === email && m.kind === kind);
  }

  // ---- Tokens ----

  private async sign(
    user: FakeUser,
    session: FakeSession,
    options: {
      nowSeconds?: number;
      lifetimeSeconds?: number;
      kid?: string;
      claims?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const aal = session.amr.some((a) => a.method === "totp") ? "aal2" : "aal1";
    const claims: Record<string, unknown> = {
      sub: user.id,
      iss: this.issuer,
      aud: "authenticated",
      role: "authenticated",
      email: user.email ?? undefined,
      phone: "",
      aal,
      amr: session.amr,
      session_id: session.sessionId,
      is_anonymous: false,
      app_metadata: { provider: user.provider, providers: [user.provider] },
      user_metadata: {
        email_verified: user.confirmed,
        ...(user.firstName ? { first_name: user.firstName } : {}),
      },
      ...options.claims,
    };
    for (const [key, value] of Object.entries(claims)) {
      if (value === undefined) delete claims[key];
    }
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: options.kid ?? this.kid, typ: "JWT" })
      .setIssuedAt(now)
      .setExpirationTime(now + (options.lifetimeSeconds ?? 3600))
      .sign(this.privateKey);
  }

  /**
   * A signed Supabase-shaped access token for `subject`, registering a matching user in the fake provider.
   * Defaults: confirmed email, a verified TOTP factor, and a TOTP proof from just now (so step-up passes).
   */
  async accessToken(subject: string, options: TokenOptions = {}): Promise<string> {
    const legacy = options.claims ?? {};
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const email =
      "email" in options
        ? options.email
        : "email" in legacy
          ? (legacy.email as string | undefined)
          : `${subject}@example.test`;
    const emailConfirmed =
      options.emailConfirmed ?? ("email_verified" in legacy ? legacy.email_verified === true : true);
    const totpFactor = options.totp ?? ("mfa_enabled" in legacy ? legacy.mfa_enabled === true : true);
    let totpAt: number | null = totpFactor ? now : null;
    if (options.totpAt !== undefined) totpAt = options.totpAt;
    else if ("mfa_verified_at" in legacy) {
      totpAt = typeof legacy.mfa_verified_at === "number" ? legacy.mfa_verified_at : null;
    }
    const user: FakeUser = {
      id: subject,
      email: email ?? null,
      password: null,
      confirmed: emailConfirmed,
      provider: "email",
      firstName: null,
      factors: totpFactor ? [{ id: `f-${subject}`, type: "totp", status: "verified", secret: "SECRET" }] : [],
    };
    this.users.set(subject, user);
    const amr: Amr[] = [{ method: "password", timestamp: now }];
    if (totpAt !== null) amr.push({ method: "totp", timestamp: totpAt });
    const session: FakeSession = { sessionId: randomUUID(), userId: subject, amr };
    this.sessions.set(session.sessionId, session);
    // The Cognito-era names were provider state, not JWT claims; they never reach the token.
    const { email: _e, email_verified: _v, mfa_enabled: _m, mfa_verified_at: _t, ...rest } = legacy;
    void [_e, _v, _m, _t];
    return this.sign(user, session, {
      nowSeconds: now,
      ...(options.lifetimeSeconds !== undefined ? { lifetimeSeconds: options.lifetimeSeconds } : {}),
      ...(options.kid !== undefined ? { kid: options.kid } : {}),
      claims: { ...(email === undefined ? { email: undefined } : {}), ...rest },
    });
  }

  // ---- OAuth (Google) ----

  /**
   * Plays Google's side: given the authorize URL the API redirected to, "signs in" `email` and returns the
   * URL Supabase would redirect the browser to (the API callback with `?code=`).
   */
  completeOAuth(authorizeUrl: string, google: { email: string; firstName?: string }): string {
    const url = new URL(authorizeUrl);
    const redirectTo = url.searchParams.get("redirect_to");
    const challenge = url.searchParams.get("code_challenge");
    if (!redirectTo || !challenge || url.searchParams.get("provider") !== "google") {
      throw new Error("FakeSupabase: not a Google authorize URL");
    }
    let user = [...this.users.values()].find((u) => u.email === google.email);
    if (!user) {
      user = {
        id: randomUUID(),
        email: google.email,
        password: null,
        confirmed: true,
        provider: "google",
        firstName: google.firstName ?? null,
        factors: [],
      };
      this.users.set(user.id, user);
    }
    const code = randomBytes(12).toString("hex");
    this.oauthCodes.set(code, { userId: user.id, challenge });
    return `${redirectTo}${redirectTo.includes("?") ? "&" : "?"}code=${code}`;
  }

  // ---- REST ----

  private async sessionJson(user: FakeUser, session: FakeSession): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    const refresh = `rt_${randomBytes(12).toString("hex")}`;
    this.refreshTokens.set(refresh, session.sessionId);
    this.sessions.set(session.sessionId, session);
    return json(200, {
      access_token: await this.sign(user, session, { nowSeconds: now }),
      refresh_token: refresh,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      user: { id: user.id, email: user.email },
    });
  }

  private newSession(user: FakeUser, method: string): FakeSession {
    return {
      sessionId: randomUUID(),
      userId: user.id,
      amr: [{ method, timestamp: Math.floor(Date.now() / 1000) }],
    };
  }

  private issueMail(kind: MailboxEntry["kind"], email: string): void {
    this.mailbox.push({
      kind,
      email,
      code: String(Math.floor(100000 + Math.random() * 900000)),
      tokenHash: randomBytes(16).toString("hex"),
    });
  }

  private async bearerUser(
    headers: Headers,
  ): Promise<{ user: FakeUser; session: FakeSession; aal: string } | null> {
    const auth = headers.get("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.getKey, { audience: "authenticated" });
      const user = this.users.get(String(payload.sub));
      const session = this.sessions.get(String(payload.session_id));
      if (!user || !session) return null;
      return { user, session, aal: String(payload.aal) };
    } catch {
      return null;
    }
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const path = url.pathname.replace(/^\/auth\/v1/, "");
    const body: Record<string, unknown> =
      typeof init?.body === "string" && init.body.length > 0
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    this.calls.push({ method, path, body, hasBearer: headers.has("authorization") });
    if (url.origin !== this.url || !url.pathname.startsWith("/auth/v1/")) {
      return gotrueError(404, "not_found");
    }
    if (this.failPath !== null && path === this.failPath) return gotrueError(500, "unexpected_failure");
    if (this.failNext) {
      this.failNext = false;
      return gotrueError(500, "unexpected_failure");
    }
    if (headers.get("apikey") !== FAKE_PUBLISHABLE_KEY) return gotrueError(401, "no_authorization");
    const str = (k: string): string | undefined =>
      typeof body[k] === "string" ? (body[k] as string) : undefined;
    const byEmail = (email: string | undefined) => [...this.users.values()].find((u) => u.email === email);

    if (this.rateLimitEmails && ["/signup", "/resend", "/recover"].includes(path)) {
      return gotrueError(429, "over_email_send_rate_limit");
    }

    if (method === "POST" && path === "/signup") {
      const email = str("email");
      const password = str("password");
      if (!email || !password) return gotrueError(422, "validation_failed");
      if (password.length < 6) return json(422, { code: 422, error_code: "weak_password", msg: "weak" });
      if (byEmail(email)) return json(200, { id: randomUUID(), email }); // obfuscated, like real GoTrue
      const meta = body.data as { first_name?: unknown } | undefined;
      const user: FakeUser = {
        id: randomUUID(),
        email,
        password,
        confirmed: false,
        provider: "email",
        firstName: typeof meta?.first_name === "string" ? meta.first_name : null,
        factors: [],
      };
      this.users.set(user.id, user);
      this.issueMail("signup", email);
      return json(200, { id: user.id, email });
    }

    if (method === "POST" && path === "/token") {
      const grant = url.searchParams.get("grant_type");
      if (grant === "password") {
        const user = byEmail(str("email"));
        if (!user || user.password === null || user.password !== str("password")) {
          return gotrueError(400, "invalid_credentials");
        }
        if (!user.confirmed) return gotrueError(400, "email_not_confirmed");
        return this.sessionJson(user, this.newSession(user, "password"));
      }
      if (grant === "refresh_token") {
        const token = str("refresh_token");
        const sessionId = token ? this.refreshTokens.get(token) : undefined;
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        const user = session ? this.users.get(session.userId) : undefined;
        if (!token || !session || !user) return gotrueError(400, "refresh_token_not_found");
        this.refreshTokens.delete(token); // rotation: a used token is dead
        return this.sessionJson(user, session);
      }
      if (grant === "pkce") {
        const code = str("auth_code");
        const entry = code ? this.oauthCodes.get(code) : undefined;
        const verifier = str("code_verifier");
        if (!code || !entry || !verifier) return gotrueError(400, "flow_state_not_found");
        this.oauthCodes.delete(code);
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const user = this.users.get(entry.userId);
        if (challenge !== entry.challenge || !user) return gotrueError(400, "bad_code_verifier");
        return this.sessionJson(user, this.newSession(user, "oauth"));
      }
      return gotrueError(400, "validation_failed");
    }

    if (method === "POST" && path === "/verify") {
      const type = str("type") === "recovery" ? "recovery" : "signup";
      const entry = [...this.mailbox]
        .reverse()
        .find(
          (m) =>
            m.kind === type &&
            (str("token_hash") !== undefined
              ? m.tokenHash === str("token_hash")
              : m.email === str("email") && m.code === str("token")),
        );
      const user = entry ? byEmail(entry.email) : undefined;
      if (!entry || !user) return gotrueError(403, "otp_expired");
      this.mailbox.splice(this.mailbox.indexOf(entry), 1); // one use
      user.confirmed = true;
      return this.sessionJson(user, this.newSession(user, "otp"));
    }

    if (method === "POST" && path === "/resend") {
      const user = byEmail(str("email"));
      if (user && !user.confirmed && user.email) this.issueMail("signup", user.email);
      return json(200, { message_id: randomUUID() });
    }

    if (method === "POST" && path === "/recover") {
      const user = byEmail(str("email"));
      if (user?.email) this.issueMail("recovery", user.email);
      return json(200, {});
    }

    if (method === "POST" && path === "/logout") {
      const who = await this.bearerUser(headers);
      if (!who) return gotrueError(401, "bad_jwt");
      const others = url.searchParams.get("scope") === "others";
      for (const [id, session] of [...this.sessions]) {
        const doomed = others
          ? session.userId === who.user.id && id !== who.session.sessionId
          : id === who.session.sessionId;
        if (!doomed) continue;
        this.sessions.delete(id);
        for (const [rt, sid] of this.refreshTokens) if (sid === id) this.refreshTokens.delete(rt);
      }
      return new Response(null, { status: 204 });
    }

    if (path === "/user" && (method === "GET" || method === "PUT")) {
      const who = await this.bearerUser(headers);
      if (!who) return gotrueError(401, "bad_jwt");
      if (method === "PUT") {
        const verified = who.user.factors.some((f) => f.status === "verified");
        if (this.enforceAal && verified && who.aal !== "aal2") return gotrueError(401, "insufficient_aal");
        const password = str("password");
        if (!password || password.length < 6) return json(422, { code: 422, error_code: "weak_password" });
        who.user.password = password;
      }
      return json(200, {
        id: who.user.id,
        email: who.user.email,
        email_confirmed_at: who.user.confirmed ? "2026-01-01T00:00:00Z" : null,
        factors: who.user.factors.map((f) => ({ id: f.id, factor_type: f.type, status: f.status })),
        user_metadata: who.user.firstName ? { first_name: who.user.firstName } : {},
      });
    }

    if (method === "POST" && path === "/factors") {
      const who = await this.bearerUser(headers);
      if (!who) return gotrueError(401, "bad_jwt");
      if (this.enforceAal && who.user.factors.some((f) => f.status === "verified") && who.aal !== "aal2") {
        return gotrueError(401, "insufficient_aal");
      }
      const factor: FakeFactor = {
        id: randomUUID(),
        type: "totp",
        status: "unverified",
        secret: randomBytes(10).toString("hex").toUpperCase(),
      };
      who.user.factors.push(factor);
      return json(200, {
        id: factor.id,
        type: "totp",
        totp: {
          qr_code: "<svg/>",
          secret: factor.secret,
          uri: `otpauth://totp/MoneyPilot:user?secret=${factor.secret}&issuer=MoneyPilot`,
        },
      });
    }

    const factorRoute = /^\/factors\/([^/]+)\/(challenge|verify)$/.exec(path);
    if (method === "POST" && factorRoute) {
      const who = await this.bearerUser(headers);
      const factor = who?.user.factors.find((f) => f.id === decodeURIComponent(factorRoute[1] ?? ""));
      if (!who || !factor) return gotrueError(who ? 404 : 401, who ? "mfa_factor_not_found" : "bad_jwt");
      if (factorRoute[2] === "challenge") {
        const id = randomUUID();
        this.challenges.set(id, factor.id);
        return json(200, { id, type: "totp", expires_at: Math.floor(Date.now() / 1000) + 300 });
      }
      const challengeId = str("challenge_id");
      if (!challengeId || this.challenges.get(challengeId) !== factor.id) {
        return gotrueError(400, "mfa_challenge_expired");
      }
      this.challenges.delete(challengeId);
      if (str("code") !== FAKE_TOTP_CODE) return gotrueError(400, "mfa_verification_failed");
      factor.status = "verified";
      // The same session is upgraded to aal2: a fresh totp entry in amr.
      who.session.amr = [
        ...who.session.amr.filter((a) => a.method !== "totp"),
        { method: "totp", timestamp: Math.floor(Date.now() / 1000) },
      ];
      return this.sessionJson(who.user, who.session);
    }

    return gotrueError(404, "not_found");
  };
}
