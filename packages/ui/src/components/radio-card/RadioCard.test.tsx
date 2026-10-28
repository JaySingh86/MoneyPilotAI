import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { RadioCardGroup } from "./RadioCard";

type V = "a" | "b" | "c" | "d";

function Group({ initial = "a" as V | null }) {
  const [value, setValue] = useState<V | null>(initial);
  return (
    <>
      <button type="button">before</button>
      <RadioCardGroup
        label="Ways to cover the gap"
        value={value}
        onChange={setValue}
        options={[
          { value: "a", title: "Move from the emergency fund", description: "$507 safe to spend" },
          { value: "b", title: "Split the repair" },
          { value: "c", title: "Connect a bank", disabled: true },
          { value: "d", title: "Pay car insurance on Nov 6" },
        ]}
      />
    </>
  );
}

const radio = (name: RegExp) => screen.getByRole("radio", { name });

describe("RadioCardGroup", () => {
  it("is a radiogroup of radios with one checked", () => {
    render(<Group />);
    expect(screen.getByRole("radiogroup", { name: "Ways to cover the gap" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(radio(/emergency fund/).getAttribute("aria-checked")).toBe("true");
    expect(radio(/Connect a bank/).getAttribute("aria-disabled")).toBe("true");
  });

  it("has one tab stop and moves with arrow keys, skipping disabled cards", async () => {
    render(<Group />);
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(radio(/emergency fund/));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(radio(/Split the repair/));
    expect(radio(/Split the repair/).getAttribute("aria-checked")).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(radio(/car insurance/));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(radio(/emergency fund/));
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(radio(/car insurance/));
    await userEvent.tab();
    expect(document.body).toBe(document.activeElement);
  });

  it("makes the first card the tab stop when nothing is chosen", async () => {
    render(<Group initial={null} />);
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(radio(/emergency fund/));
  });

  it("ignores clicks on a disabled card", async () => {
    render(<Group />);
    await userEvent.click(radio(/Connect a bank/));
    expect(radio(/Connect a bank/).getAttribute("aria-checked")).toBe("false");
  });

  it("draws the ring first, and can hide it", () => {
    const { container, rerender } = render(<Group />);
    expect(container.querySelector("[role='radio']")?.firstElementChild?.className).toContain("ring");
    rerender(
      <RadioCardGroup
        label="Goals"
        value="a"
        onChange={() => {}}
        hideIndicator
        options={[{ value: "a", title: "Emergency fund" }]}
      />,
    );
    expect(container.querySelector("[class~='ring']")).toBeNull();
    expect(screen.getByRole("radio", { name: "Emergency fund" })).toBeTruthy();
  });

  it("has no axe violations", async () => {
    const { container } = render(<Group />);
    await expectNoAxeViolations(container);
  });
});
