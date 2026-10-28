import { Temporal } from "@js-temporal/polyfill";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { ListRow, ListRows } from "./ListRow";

function renderRows() {
  return render(
    <ListRows label="Before payday">
      <ListRow
        href="/bills/rent"
        date={Temporal.PlainDate.from("2026-11-01")}
        title="Rent"
        meta="Jordan"
        amountCents={215000}
      />
      <ListRow
        href="/bills/power"
        date={Temporal.PlainDate.from("2026-11-03")}
        title="Electricity"
        meta="Sam"
        amountCents={14200}
        amountMode="estimate"
      />
    </ListRows>,
  );
}

describe("ListRow", () => {
  it("makes the whole row one link with date block, title and amount", () => {
    renderRows();
    const link = screen.getByRole("link", { name: /Rent/ });
    expect(link.getAttribute("href")).toBe("/bills/rent");
    expect(link.textContent).toBe("Sun1RentJordan$2,150.00");
    expect(screen.getByRole("link", { name: /Electricity/ }).textContent).toContain("~$142.00");
  });

  it("is a named list", async () => {
    const { container } = renderRows();
    expect(screen.getByRole("list", { name: "Before payday" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    await expectNoAxeViolations(container);
  });
});
