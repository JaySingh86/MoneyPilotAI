import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { EmptyState, ErrorBanner, Loading, Skeleton, StatusBanner } from "./States";

afterEach(() => {
  vi.useRealTimers();
});

describe("EmptyState", () => {
  it("states what will appear", async () => {
    const { container } = render(<EmptyState>All caught up.</EmptyState>);
    expect(screen.getByText("All caught up.")).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});

describe("Loading", () => {
  it("shows skeletons only after 300 ms", () => {
    vi.useFakeTimers();
    const { container } = render(
      <Loading label="Loading bills">
        <Skeleton />
      </Loading>,
    );
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector("[aria-hidden='true']")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(container.querySelector("[aria-hidden='true']")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(status.textContent).toBe("Loading bills");
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <Loading label="Loading" delayMs={0}>
        <Skeleton shape="block" />
      </Loading>,
    );
    await expectNoAxeViolations(container);
  });
});

describe("ErrorBanner", () => {
  it("is an alert with what still works and one retry action", async () => {
    const onRetry = vi.fn();
    const { container } = render(
      <ErrorBanner title="We couldn’t reach Gmail." onRetry={onRetry}>
        Your plan still shows what we found earlier.
      </ErrorBanner>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Your plan still shows what we found earlier.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    await expectNoAxeViolations(container);
  });
});

describe("StatusBanner", () => {
  it("announces what changed", async () => {
    const { container } = render(
      <StatusBanner>Electricity set to $151.37. Safe to spend is now $998.</StatusBanner>,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Electricity set to $151.37. Safe to spend is now $998.",
    );
    await expectNoAxeViolations(container);
  });
});
