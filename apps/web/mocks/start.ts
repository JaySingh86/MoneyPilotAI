// Starts the mock API in the browser. Imported dynamically, and only when MOCK_MODE is on.
import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";
import { createMockAuthAdapter } from "./mock-auth-adapter";
import type { MockAuthAdapter } from "./mock-auth-adapter";
import { initFromLocation, setFault, setScenario, state } from "./state";

export interface MockHandle {
  auth: MockAuthAdapter;
}

declare global {
  interface Window {
    /** Test and dev hook; exists only in mock mode. */
    __mpMock?: {
      state: typeof state;
      setScenario: typeof setScenario;
      setFault: typeof setFault;
      auth: MockAuthAdapter;
    };
  }
}

let started: Promise<MockHandle> | null = null;

export function startMock(): Promise<MockHandle> {
  started ??= (async () => {
    initFromLocation(window.location);
    const worker = setupWorker(...handlers);
    await worker.start({ onUnhandledRequest: "bypass", quiet: true });
    const auth = createMockAuthAdapter();
    window.__mpMock = { state, setScenario, setFault, auth };
    return { auth };
  })();
  return started;
}
