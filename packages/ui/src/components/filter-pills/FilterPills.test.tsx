import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { FilterPills } from "./FilterPills";

const options = [
  { value: "all", label: "All", count: 18 },
  { value: "bills", label: "Bills", count: 16 },
  { value: "income", label: "Income", count: 2 },
] as const;

describe("FilterPills", () => {
  it("shows the count after the label and marks the selected pill", () => {
    render(<FilterPills label="Type" options={options} value="all" onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "Type" })).toBeTruthy();
    const all = screen.getByRole("button", { name: "All 18" });
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Income 2" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("reports the chosen value", async () => {
    const onChange = vi.fn();
    render(<FilterPills label="Type" options={options} value="all" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Bills 16" }));
    expect(onChange).toHaveBeenCalledWith("bills");
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <FilterPills label="Type" options={options} value="bills" onChange={() => {}} />,
    );
    await expectNoAxeViolations(container);
  });
});
