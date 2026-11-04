import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import { expectNoAxeViolations } from "../test/axe";
import { BILLS_BEFORE_PAYDAY } from "../testing/bills-before-payday";
import { BILL_COLUMNS } from "../testing/bill-columns";
import { Table } from "./Table";

const golden = fixture.expected.billsBeforePayday;

function renderBills(selectedKey?: string) {
  return render(
    <Table
      caption="Due before payday"
      columns={BILL_COLUMNS}
      rows={BILLS_BEFORE_PAYDAY}
      rowKey={(r) => r.id}
      selectedKey={selectedKey}
      total={{ label: "Total due before Nov 6", cents: golden.totalCents }}
    />,
  );
}

describe("Table", () => {
  it("is a captioned table with column headers and row headers", () => {
    renderBills();
    const table = screen.getByRole("table", { name: "Due before payday" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Due", "Bill", "Owner", "Status", "Amount"]);
    expect(within(table).getByRole("rowheader", { name: /^Rent\s*Monthly$/ })).toBeTruthy();
  });

  it("shows the golden 8 bills and $4,792.99 total with right-aligned 600 amounts", () => {
    renderBills();
    const rows = screen.getAllByRole("row");
    // header + 8 bills + total
    expect(rows).toHaveLength(golden.count + 2);
    expect(screen.getByText("$4,792.99").className).toContain("total");
    const estimate = screen.getByText("~$142.00");
    expect(estimate.closest("td")?.className).toContain("end");
    expect(estimate.closest("td")?.className).toContain("amount");
  });

  it("tints the selected row", () => {
    renderBills("b-power");
    const row = screen.getByText("Electricity").closest("tr");
    expect(row?.className).toContain("selected");
  });

  it("renders the empty state when there are no rows", () => {
    render(
      <Table
        caption="Bills"
        columns={BILL_COLUMNS}
        rows={[]}
        rowKey={(r) => r.id}
        empty={<p>Nothing due</p>}
      />,
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Nothing due")).toBeTruthy();
  });

  it("has no axe violations", async () => {
    const { container } = renderBills("b-rent");
    await expectNoAxeViolations(container);
  });
});

describe("Table scroll region", () => {
  const original = {
    scrollWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth"),
    clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
  };
  afterEach(() => {
    for (const key of ["scrollWidth", "clientWidth"] as const) {
      const d = original[key];
      if (d) Object.defineProperty(HTMLElement.prototype, key, d);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  });
  const size = (scrollWidth: number, clientWidth: number) => {
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get: () => scrollWidth,
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => clientWidth,
    });
  };
  const table = () => (
    <Table
      caption="Due before payday"
      columns={BILL_COLUMNS}
      rows={BILLS_BEFORE_PAYDAY}
      rowKey={(r) => r.id}
    />
  );

  it("is not a tab stop when everything fits", () => {
    size(600, 600);
    render(table());
    expect(screen.queryByRole("region", { name: "Due before payday" })).toBeNull();
  });

  it("becomes a focusable, named region when it overflows (scrollWidth > clientWidth)", () => {
    size(700, 300);
    render(table());
    const region = screen.getByRole("region", { name: "Due before payday" });
    expect(region.tabIndex).toBe(0);
  });
});
