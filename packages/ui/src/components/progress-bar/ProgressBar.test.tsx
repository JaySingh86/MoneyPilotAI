import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("is a named progressbar with its value", () => {
    render(<ProgressBar title="Lake Tahoe trip" percent={48} tone="partnerA" caption="$1,150 of $2,400" />);
    const bar = screen.getByRole("progressbar", { name: "Lake Tahoe trip" });
    expect(bar.getAttribute("aria-valuenow")).toBe("48");
    expect(bar.getAttribute("aria-valuetext")).toBe("48%");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("48%");
    expect(bar.firstElementChild?.className).toContain("partnerA");
  });

  it("clamps the fill to the track", () => {
    render(<ProgressBar title="Over" percent={120} />);
    const bar = screen.getByRole("progressbar", { name: "Over" });
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("100%");
  });

  it("has no axe violations", async () => {
    const { container } = render(<ProgressBar title="Emergency fund" percent={64} />);
    await expectNoAxeViolations(container);
  });
});
