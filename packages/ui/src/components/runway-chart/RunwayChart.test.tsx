import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import { expectNoAxeViolations } from "../test/axe";
import { RunwayChart, RunwayMini, runwayScale } from "./RunwayChart";
import { fixtureCushionCents, fixtureToday, normalRunway, shortfallRunway } from "../testing/fixture-runway";

function renderChart(data: typeof normalRunway) {
  return render(
    <RunwayChart
      days={data.days}
      lowestDate={data.lowestDate}
      cushionCents={fixtureCushionCents}
      today={fixtureToday}
      id="runway"
    />,
  );
}

const bars = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-runway-bar]")];

describe("runwayScale (DESIGN_SPEC §4.1)", () => {
  it("runs from 0 to the max balance rounded up to the next $1,000", () => {
    expect(runwayScale(normalRunway.days)).toEqual({ maxCents: 600000, minCents: 0 });
  });

  it("reserves space below $0 on the same scale when a balance is negative", () => {
    expect(runwayScale(shortfallRunway.days)).toEqual({ maxCents: 500000, minCents: -100000 });
  });

  it("keeps an exact $1,000 maximum and never collapses an empty range", () => {
    expect(runwayScale([{ balanceCents: 300000 }]).maxCents).toBe(300000);
    expect(runwayScale([{ balanceCents: 0 }])).toEqual({ maxCents: 100000, minCents: 0 });
  });
});

describe("RunwayChart with the fixture runway (normal)", () => {
  it("draws one bar per day from today through payday, inclusive", () => {
    const { container } = renderChart(normalRunway);
    expect(bars(container)).toHaveLength(11);
    expect(bars(container).map((b) => b.dataset.date)).toEqual(
      Object.keys(fixture.expected.runwayEndOfDayCents),
    );
  });

  it("labels every bar with its value and colors paydays and the single lowest day", () => {
    const { container } = renderChart(normalRunway);
    const kinds = bars(container).map((b) => [b.dataset.date, b.dataset.kind, b.dataset.value]);
    expect(kinds).toEqual([
      ["2026-10-27", "balance", "$3,400"],
      ["2026-10-28", "balance", "$3,400"],
      ["2026-10-29", "balance", "$3,011"],
      ["2026-10-30", "payday", "$5,911"],
      ["2026-10-31", "balance", "$5,816"],
      ["2026-11-01", "balance", "$3,666"],
      ["2026-11-02", "balance", "$2,403"],
      ["2026-11-03", "balance", "$2,261"],
      ["2026-11-04", "balance", "$1,577"],
      ["2026-11-05", "lowest", "$1,507"],
      ["2026-11-06", "payday", "$4,657"],
    ]);
  });

  it("scales bar heights against a $6,000 axis, inside the 230 px plot", () => {
    const { container } = renderChart(normalRunway);
    const share = (b: HTMLElement | undefined) =>
      b?.querySelector<HTMLElement>("[data-bar]")?.style.getPropertyValue("--h");
    // 340000 / 600000 of --plot-h, which is 230 px minus the headroom for value labels.
    expect(share(bars(container)[0])).toBe("0.5667");
    expect(share(bars(container)[9])).toBe("0.2512");
    const plot = container.querySelector<HTMLElement>("[class~='plot']");
    expect(plot?.className).not.toContain("hasNegative");
  });

  it("puts the lowest-point tooltip on the lowest bar only", () => {
    renderChart(normalRunway);
    expect(screen.getAllByText("Lowest · $1,507")).toHaveLength(1);
  });

  it("shows the date and event under each bar", () => {
    const { container } = renderChart(normalRunway);
    const labels = [...container.querySelectorAll("[data-runway-label]")].map((l) => l.textContent);
    expect(labels).toEqual([
      "Oct 27Today",
      "28—",
      "29Car −389",
      "30Pay +2,900",
      "31Phone −95",
      "Nov 1Rent −2,150",
      "2Daycare & TV −1,263",
      "3Power ~−142",
      "4Insurance −684",
      "5Internet −70",
      "6Pay +3,150",
    ]);
  });

  it("draws the cushion line at $500 and a chart.axis baseline", () => {
    const { container } = renderChart(normalRunway);
    const cushion = container.querySelector<HTMLElement>("[data-runway-cushion]");
    expect(cushion?.parentElement?.style.getPropertyValue("--cushion")).toBe("0.0833");
    expect(container.querySelector("[data-runway-axis]")?.getAttribute("data-negative")).toBe("false");
    expect(screen.getByText("$500 cushion")).toBeTruthy();
  });

  it("gives screen readers a table with every day", () => {
    renderChart(normalRunway);
    const table = screen.getByRole("table", { name: /projected end-of-day balance/i });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(12);
    expect(rows[10]?.textContent).toBe("Thu, Nov 5$1,507Internet −$70.00Lowest");
  });

  it("matches the structural snapshot", () => {
    const { container } = renderChart(normalRunway);
    expect(container.firstChild).toMatchSnapshot();
  });

  it("has no axe violations", async () => {
    const { container } = renderChart(normalRunway);
    await expectNoAxeViolations(container);
  });
});

describe("RunwayChart with the fixture shortfall scenario", () => {
  it("hangs negative bars below a solid $0 axis with values in attention text", () => {
    const { container } = renderChart(shortfallRunway);
    const negative = bars(container).filter((b) => b.dataset.negative === "true");
    expect(negative.map((b) => [b.dataset.date, b.dataset.kind, b.dataset.value])).toEqual([
      ["2026-11-04", "negative", "−$223"],
      ["2026-11-05", "lowest", "−$293"],
    ]);
    expect(container.querySelector("[data-runway-axis]")?.getAttribute("data-negative")).toBe("true");
  });

  it("scales the space below $0 the same way as above it", () => {
    const { container } = renderChart(shortfallRunway);
    const regions = container.querySelector<HTMLElement>("[data-runway-bar]");
    const pos = regions?.querySelector<HTMLElement>("[data-region='positive']");
    const neg = regions?.querySelector<HTMLElement>("[data-region='negative']");
    // $5,000 above and $1,000 below on a $6,000 range.
    expect(pos?.style.getPropertyValue("--region")).toBe("0.8333");
    expect(neg?.style.getPropertyValue("--region")).toBe("0.1667");
    const lowestBar = bars(container)[9]?.querySelector<HTMLElement>("[data-bar]");
    expect(lowestBar?.style.getPropertyValue("--h")).toBe("0.0488");
    // Room under the axis for the value label and tooltip, so nothing reaches the date row.
    expect(container.querySelector("[class~='plot']")?.className).toContain("hasNegative");
  });

  it("puts the negative lowest tooltip under its value, clear of the cushion line", () => {
    const { container } = renderChart(shortfallRunway);
    const column = bars(container)[9];
    const negative = column?.querySelector("[data-region='negative']");
    expect(negative?.textContent).toBe("−$293Lowest · −$293");
    expect(column?.querySelector("[data-region='positive']")?.textContent).toBe("");
  });

  it("labels the lowest day and its event", () => {
    renderChart(shortfallRunway);
    expect(screen.getByText("Lowest · −$293")).toBeTruthy();
    expect(screen.getByText("Repair −1,800")).toBeTruthy();
  });

  it("matches the structural snapshot", () => {
    const { container } = renderChart(shortfallRunway);
    expect(container.firstChild).toMatchSnapshot();
  });

  it("has no axe violations", async () => {
    const { container } = renderChart(shortfallRunway);
    await expectNoAxeViolations(container);
  });
});

describe("RunwayMini (mobile hero)", () => {
  it("is decorative and draws one bar per day", () => {
    const { container } = render(
      <RunwayMini days={shortfallRunway.days} lowestDate={shortfallRunway.lowestDate} />,
    );
    const root = container.firstElementChild;
    expect(root?.getAttribute("aria-hidden")).toBe("true");
    expect(root?.querySelectorAll("[data-mini-bar]")).toHaveLength(11);
    expect(root?.querySelectorAll("[data-mini-bar][data-negative='true']")).toHaveLength(2);
    expect(container.firstChild).toMatchSnapshot();
  });
});
