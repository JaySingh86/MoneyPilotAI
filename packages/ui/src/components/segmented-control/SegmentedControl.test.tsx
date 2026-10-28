import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { SegmentedControl } from "./SegmentedControl";

function Owners() {
  const [value, setValue] = useState<"both" | "sam" | "jordan">("both");
  return (
    <SegmentedControl
      label="Show bills for"
      value={value}
      onChange={setValue}
      options={[
        { value: "both", label: "Both" },
        { value: "sam", label: "Sam" },
        { value: "jordan", label: "Jordan" },
      ]}
    />
  );
}

describe("SegmentedControl", () => {
  it("is a labelled group with aria-pressed segments", () => {
    render(<Owners />);
    expect(screen.getByRole("group", { name: "Show bills for" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Both" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Sam" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("selects with the keyboard", async () => {
    render(<Owners />);
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe("Sam");
    await userEvent.keyboard(" ");
    expect(screen.getByRole("button", { name: "Sam" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Both" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("has no axe violations", async () => {
    const { container } = render(<Owners />);
    await expectNoAxeViolations(container);
  });
});
