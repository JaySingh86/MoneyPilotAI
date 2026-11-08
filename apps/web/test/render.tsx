import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { AuthProvider } from "../lib/auth/AuthProvider";
import { StepUpProvider } from "../lib/auth/StepUp";
import type { AuthAdapter } from "../lib/auth/types";
import { createMockAuthAdapter } from "../mocks/mock-auth-adapter";
import type { MockAuthAdapter } from "../mocks/mock-auth-adapter";
import { initFromLocation, setScenario, state } from "../mocks/state";
import type { Scenario } from "../mocks/model";

/** Resets the mock API and renders `ui` inside the app's providers with the fake Cognito session. */
export function renderApp(
  ui: ReactElement,
  options: { scenario?: Scenario; signedIn?: boolean; adapter?: AuthAdapter } = {},
): { adapter: MockAuthAdapter; queryClient: QueryClient } {
  state.faults.clear();
  state.bootstrapCalls = 0;
  state.delayMs = 0;
  initFromLocation(window.location);
  setScenario(options.scenario ?? "base");
  const adapter = createMockAuthAdapter({ signedIn: options.signedIn ?? true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider adapter={options.adapter ?? adapter}>
        <StepUpProvider>{ui}</StepUpProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { adapter, queryClient };
}
