// A fake sign-in for mock mode (`pnpm dev:mock`) and tests. Dev only: it is loaded through a dynamic
// import that is dropped from production bundles (lib/config.ts), and it never touches a network.
//
// Scripted behaviour so the sign-in screens can be exercised without AWS:
// - password `wrong` fails; password `mfa` asks for a TOTP code (`123456`); anything else signs in;
// - sign-up and password reset codes are `123456`.
import { AuthError } from "../lib/auth/types";
import type { AuthAdapter, AuthSession, SignInStep } from "../lib/auth/types";
import { MOCK_USER } from "./identity";
import { wp23 } from "./wp23-data";

const STORAGE_KEY = "mp.mock.auth";
const GOOD_CODE = "123456";

function readSignedIn(initial: boolean): boolean {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    return stored === null ? initial : stored === "in";
  } catch {
    return initial;
  }
}

function writeSignedIn(value: boolean): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, value ? "in" : "out");
  } catch {
    // Private mode: the session lives only in memory.
  }
}

export interface MockAuthAdapter extends AuthAdapter {
  /** Simulates the session refreshing the tokens in the background. */
  simulateTokenRefresh(): void;
}

export function createMockAuthAdapter(options: { signedIn?: boolean } = {}): MockAuthAdapter {
  let signedIn = readSignedIn(options.signedIn ?? true);
  let pendingTotp = false;
  const listeners = new Set<() => void>();
  const emit = (): void => listeners.forEach((l) => l());
  const session: AuthSession = {
    accessToken: "mock-access-token",
    email: MOCK_USER.email,
    firstName: MOCK_USER.firstName,
  };
  const finish = (): SignInStep => {
    signedIn = true;
    writeSignedIn(true);
    emit();
    return { step: "done" };
  };
  const requireCode = (code: string): void => {
    if (code !== GOOD_CODE) throw new AuthError("invalid_code", "invalid code");
  };

  const adapter: MockAuthAdapter = {
    kind: "mock",
    async getSession() {
      return signedIn ? session : null;
    },
    async signIn(_email, password) {
      if (password === "wrong") throw new AuthError("invalid_credentials", "invalid credentials");
      if (password === "mfa") {
        pendingTotp = true;
        return { step: "totp" };
      }
      return finish();
    },
    async confirmTotp(code) {
      if (!pendingTotp) throw new AuthError("unknown", "no sign-in in progress");
      requireCode(code);
      pendingTotp = false;
      return finish();
    },
    async signUp() {
      return { step: "confirm_sign_up" };
    },
    async confirmSignUp(_email, code) {
      requireCode(code);
    },
    async resendSignUpCode() {},
    async requestPasswordReset() {},
    async confirmPasswordReset(_email, code) {
      requireCode(code);
    },
    async signInWithGoogle() {
      finish();
    },
    async stepUp(code) {
      requireCode(code);
      // A fresh MFA time: the mock API stops answering 403 `mfa_required` (`?mfa=required` scenario).
      wp23.requireStepUp = false;
    },
    async setUpTotp() {
      return {
        sharedSecret: "JBSWY3DPEHPK3PXP",
        setupUri: "otpauth://totp/MoneyPilot:sam?secret=JBSWY3DPEHPK3PXP&issuer=MoneyPilot",
        async confirm(code: string) {
          requireCode(code);
          wp23.mfa.sam = true;
        },
      };
    },
    async signOut() {
      signedIn = false;
      writeSignedIn(false);
    },
    onTokensChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    simulateTokenRefresh: emit,
  };
  return adapter;
}
