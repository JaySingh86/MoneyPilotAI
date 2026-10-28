import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import { expectNoAxeViolations } from "../test/axe";
import { KpiTile } from "./KpiTile";

const bills = fixture.expected.billsBeforePayday;

describe("KpiTile", () => {
  function renderBills() {
    return render(
      <KpiTile
        label="Bills before payday"
        value={{ cents: bills.totalCents, mode: "detail" }}
        caption={`${bills.count} bills`}
        split={[
          { role: "partnerA", name: "Sam", cents: bills.byOwner["m-sam"] },
          { role: "partnerB", name: "Jordan", cents: bills.byOwner["m-jordan"] },
        ]}
      />,
    );
  }

  it("shows the golden bills total with cents and the owner amounts", () => {
    renderBills();
    expect(screen.getByText("$4,792.99")).toBeTruthy();
    expect(screen.getByText("$1,793.99")).toBeTruthy();
    expect(screen.getByText("$2,999.00")).toBeTruthy();
    expect(screen.getByText("8 bills")).toBeTruthy();
  });

  it("draws a decorative split bar sized by share", () => {
    const { container } = renderBills();
    const bar = container.querySelector("[aria-hidden='true']");
    const widths = [...(bar?.children ?? [])].map((s) => (s as HTMLElement).style.width);
    expect(widths).toEqual(["37.4295%", "62.5705%"]);
  });

  it("floors headline money by default and rounds summaries to nearest when asked", () => {
    render(
      <>
        <KpiTile label="Safe" value={{ cents: 100701 }} />
        <KpiTile label="Average" value={{ cents: 972550, rounding: "nearest" }} />
      </>,
    );
    expect(screen.getByText("$1,007")).toBeTruthy();
    expect(screen.getByText("$9,726")).toBeTruthy();
  });

  it("has no axe violations", async () => {
    const { container } = renderBills();
    await expectNoAxeViolations(container);
  });
});
