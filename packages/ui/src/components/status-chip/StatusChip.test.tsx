import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { Badge, StatusChip } from "./StatusChip";

describe("StatusChip", () => {
  it.each(["ok", "income", "attention", "info", "estimate", "release"] as const)(
    "renders the %s variant with text",
    (variant) => {
      render(<StatusChip variant={variant}>Label</StatusChip>);
      expect(screen.getByText("Label").className).toContain(variant);
    },
  );

  it("has no axe violations", async () => {
    const { container } = render(<StatusChip variant="estimate">Estimate ±$30</StatusChip>);
    await expectNoAxeViolations(container);
  });
});

describe("Badge", () => {
  it("gives screen readers the meaning of the count", () => {
    const { container } = render(<Badge count={4} label="4 to review" />);
    expect(container.textContent).toBe("44 to review");
    expect(screen.getByText("4").getAttribute("aria-hidden")).toBe("true");
  });
});
