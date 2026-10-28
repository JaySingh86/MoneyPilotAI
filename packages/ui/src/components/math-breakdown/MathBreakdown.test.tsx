import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import { expectNoAxeViolations } from "../test/axe";
import { MathBreakdown } from "./MathBreakdown";

const { expected } = fixture;

describe("MathBreakdown", () => {
  it("lists label/value pairs under a THE MATH overline, with total and gap rows", async () => {
    const { container } = render(
      <MathBreakdown
        rows={[
          { label: "Lowest projected balance", cents: expected.lowest.balanceCents, mode: "headline" },
          { label: "Cushion", cents: -50000, mode: "headline" },
          { label: "Safe to spend", cents: expected.safeToSpendCents, mode: "headline", kind: "total" },
          { label: "Behind", cents: 25000, kind: "gap" },
        ]}
      />,
    );
    expect(screen.getByText("The math")).toBeTruthy();
    const terms = screen.getAllByRole("term").map((t) => t.textContent);
    const defs = screen.getAllByRole("definition").map((d) => d.textContent);
    expect(terms).toEqual(["Lowest projected balance", "Cushion", "Safe to spend", "Behind"]);
    expect(defs).toEqual(["$1,507", "−$500", "$1,007", "$250.00"]);
    expect(screen.getByText("Safe to spend").parentElement?.className).toContain("total");
    expect(screen.getByText("Behind").parentElement?.className).toContain("gap");
    await expectNoAxeViolations(container);
  });
});
