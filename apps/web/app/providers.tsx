"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { AuthProvider } from "../lib/auth/AuthProvider";
import { StepUpProvider } from "../lib/auth/StepUp";
import { createAmplifyAdapter } from "../lib/auth/amplify-adapter";
import type { AuthAdapter } from "../lib/auth/types";
import { COGNITO, MOCK_MODE } from "../lib/config";

interface Boot {
  adapter: AuthAdapter;
  /** Dev toolbar for the mock API; only ever set in mock mode. */
  DevBar: ComponentType | null;
}

async function boot(): Promise<Boot> {
  // `process.env.NODE_ENV` is inlined by Next, so in a production bundle this block is dead code and
  // the mock API, its engine and MSW are not shipped (lib/config.ts).
  if (process.env.NODE_ENV !== "production" && MOCK_MODE) {
    const { startMock } = await import("../mocks/start");
    const { MockBar } = await import("../mocks/MockBar");
    const { auth } = await startMock();
    return { adapter: auth, DevBar: MockBar };
  }
  return { adapter: createAmplifyAdapter(COGNITO), DevBar: null };
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
      }),
  );
  const [ready, setReady] = useState<Boot | null>(null);
  useEffect(() => {
    let cancelled = false;
    void boot().then((b) => {
      if (!cancelled) setReady(b);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) return null;
  const { adapter, DevBar } = ready;
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider adapter={adapter}>
        <StepUpProvider>{children}</StepUpProvider>
        {DevBar && <DevBar />}
      </AuthProvider>
    </QueryClientProvider>
  );
}
