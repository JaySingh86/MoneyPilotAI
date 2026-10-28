import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { Stepper } from "./Stepper";

function Demo({ initial }: { initial: number }) {
  const [value, setValue] = useState(initial);
  return <Stepper label="Monthly deposit" valueCents={value} onChange={setValue} />;
}

describe("Stepper", () => {
  it("steps by $25 with labelled buttons and a polite output", async () => {
    render(<Demo initial={25000} />);
    const output = screen.getByRole("status");
    expect(output.tagName).toBe("OUTPUT");
    expect(output.getAttribute("aria-live")).toBe("polite");
    expect(output.textContent).toBe("$250");
    await userEvent.click(screen.getByRole("button", { name: "Increase by $25" }));
    expect(output.textContent).toBe("$275");
    await userEvent.click(screen.getByRole("button", { name: "Decrease by $25" }));
    await userEvent.click(screen.getByRole("button", { name: "Decrease by $25" }));
    expect(output.textContent).toBe("$225");
  });

  it("stops at the $0 minimum", () => {
    render(<Demo initial={0} />);
    expect(screen.getByRole("button", { name: "Decrease by $25" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("keeps keyboard focus on the button when it reaches the limit", async () => {
    render(<Demo initial={2500} />);
    const decrease = screen.getByRole("button", { name: "Decrease by $25" });
    decrease.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("status").textContent).toBe("$0");
    expect(document.activeElement).toBe(decrease);
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("status").textContent).toBe("$0");
  });

  it("is a group named by its label", async () => {
    const { container } = render(<Demo initial={31300} />);
    expect(screen.getByRole("group", { name: "Monthly deposit" })).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});
