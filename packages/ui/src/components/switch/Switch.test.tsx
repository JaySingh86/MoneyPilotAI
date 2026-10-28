import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { Switch, SwitchRow } from "./Switch";

function Row() {
  const [checked, setChecked] = useState(false);
  return (
    <SwitchRow title="On the due date" description="Email to Sam" checked={checked} onChange={setChecked} />
  );
}

describe("Switch", () => {
  it("is a role=switch named by its row title and described by the sub-line", () => {
    render(<Row />);
    const sw = screen.getByRole("switch", { name: "On the due date" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(sw.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Email to Sam",
    );
  });

  it("toggles with Space from the keyboard", async () => {
    render(<Row />);
    await userEvent.tab();
    await userEvent.keyboard(" ");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("works standalone with an aria-label", () => {
    render(<Switch label="Also remind Jordan" checked onChange={() => {}} />);
    expect(screen.getByRole("switch", { name: "Also remind Jordan" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("has no axe violations", async () => {
    const { container } = render(<Row />);
    await expectNoAxeViolations(container);
  });
});
