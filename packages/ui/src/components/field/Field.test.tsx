import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { Checkbox, SelectField, TextField } from "./Field";

describe("TextField", () => {
  it("labels the input and uses a decimal keypad for money", () => {
    render(<TextField label="Amount" money />);
    const input = screen.getByLabelText("Amount");
    expect(input.getAttribute("inputmode")).toBe("decimal");
  });

  it("links the error and keeps what the user typed", async () => {
    const { rerender } = render(<TextField label="Amount" money defaultValue="" />);
    const input = screen.getByLabelText("Amount") as HTMLInputElement;
    await userEvent.type(input, "15o.00");
    rerender(<TextField label="Amount" money defaultValue="" error="Enter an amount like 151.37" />);
    expect(input.value).toBe("15o.00");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("textbox", { description: "Enter an amount like 151.37" })).toBe(input);
  });

  it("has no axe violations", async () => {
    const { container } = render(<TextField label="Task" hint="Short and specific" error="Add a title" />);
    await expectNoAxeViolations(container);
  });
});

describe("SelectField", () => {
  it("is a labelled native select", async () => {
    const { container } = render(
      <SelectField
        label="Owner"
        defaultValue="both"
        options={[
          { value: "sam", label: "Sam" },
          { value: "both", label: "Both" },
        ]}
      />,
    );
    expect((screen.getByRole("combobox", { name: "Owner" }) as HTMLSelectElement).value).toBe("both");
    await expectNoAxeViolations(container);
  });
});

describe("Checkbox", () => {
  it("uses the title as its label and strikes through when done", async () => {
    const { container } = render(
      <Checkbox label="Renew registration" checked strikeWhenChecked onChange={() => {}} />,
    );
    const box = screen.getByRole("checkbox", { name: "Renew registration" });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Renew registration").className).toContain("done");
    await expectNoAxeViolations(container);
  });
});
