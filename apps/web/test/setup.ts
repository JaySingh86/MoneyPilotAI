import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./server";

// Next's router hooks need an app context that unit tests don't have.
export const router = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/overview",
  useSearchParams: () => new URLSearchParams(),
}));

// jsdom has no <dialog>.showModal().
if (typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  if (typeof window !== "undefined") window.sessionStorage.clear();
});
afterAll(() => server.close());
