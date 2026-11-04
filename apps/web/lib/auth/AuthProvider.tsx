"use client";

import type { ApiClient } from "@mp/contracts/client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createClient } from "../api/client";
import type { TokenProvider } from "../api/client";
import { FIRST_NAME_MAX, bootstrapUser, browserTimeZone } from "./bootstrap";
import type { Me } from "./bootstrap";
import type { AuthAdapter, AuthSession } from "./types";

export type AuthStatus = "loading" | "signed_out" | "needs_name" | "signed_in" | "failed";

export interface AuthContextValue {
  status: AuthStatus;
  session: AuthSession | null;
  me: Me | null;
  adapter: AuthAdapter;
  api: ApiClient;
  getToken: TokenProvider;
  /** Reloads the session and syncs the user. Call after a sign-in step finishes. */
  refresh: () => Promise<void>;
  /** The first-sign-in form: remembers the name and bootstraps again. */
  submitFirstName: (firstName: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

export function AuthProvider({ adapter, children }: { adapter: AuthAdapter; children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const nameOverride = useRef<string | null>(null);

  const getToken = useCallback<TokenProvider>(
    async () => (await adapter.getSession())?.accessToken ?? null,
    [adapter],
  );
  const api = useMemo(() => createClient(getToken), [getToken]);

  /** Loads the session, then `POST /me/bootstrap`. Overlapping calls share one request. */
  const sync = useCallback((): Promise<void> => {
    inFlight.current ??= (async () => {
      try {
        const current = await adapter.getSession();
        setSession(current);
        if (!current) {
          setMe(null);
          setStatus("signed_out");
          return;
        }
        const result = await bootstrapUser(api, {
          firstName: nameOverride.current ?? current.firstName,
          timezone: browserTimeZone(),
        });
        if (result.kind === "ok") {
          setMe(result.me);
          setStatus("signed_in");
        } else {
          setStatus(result.kind === "needs_name" ? "needs_name" : "failed");
        }
      } catch {
        setStatus("failed");
      } finally {
        inFlight.current = null;
      }
    })();
    return inFlight.current;
  }, [adapter, api]);

  useEffect(() => {
    void sync();
    // After a sign-in and after every token refresh, so email and MFA changes sync promptly.
    return adapter.onTokensChanged(() => void sync());
  }, [adapter, sync]);

  const submitFirstName = useCallback(
    async (firstName: string) => {
      nameOverride.current = firstName.trim().slice(0, FIRST_NAME_MAX);
      await sync();
    },
    [sync],
  );

  const signOut = useCallback(async () => {
    await adapter.signOut();
    setMe(null);
    setSession(null);
    setStatus("signed_out");
  }, [adapter]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, session, me, adapter, api, getToken, refresh: sync, submitFirstName, signOut }),
    [status, session, me, adapter, api, getToken, sync, submitFirstName, signOut],
  );
  return <AuthContext value={value}>{children}</AuthContext>;
}
