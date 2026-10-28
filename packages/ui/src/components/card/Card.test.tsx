import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import { expectNoAxeViolations } from "../test/axe";
import { AttentionCard, Card, HeroCard } from "./Card";

const { expected } = fixture;
const shortfall = fixture.scenarios.shortfall.expected;

describe("Card", () => {
  it("is a region named by its title", () => {
    render(
      <Card title="Due before payday" subtitle="8 bills">
        body
      </Card>,
    );
    expect(screen.getByRole("region", { name: "Due before payday" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Due before payday" })).toBeTruthy();
  });

  it("has no axe violations", async () => {
    const { container } = render(<Card title="Goals">body</Card>);
    await expectNoAxeViolations(container);
  });
});

describe("HeroCard", () => {
  it("shows safe to spend floored to whole dollars (golden $1,007)", () => {
    render(<HeroCard label="Safe to spend until Fri, Nov 6" amountCents={expected.safeToSpendCents} />);
    expect(screen.getByText(expected.safeToSpendDisplay)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Safe to spend until Fri, Nov 6" })).toBeTruthy();
  });

  it("puts the per-day line in the top-right status slot", () => {
    render(
      <HeroCard
        label="Safe to spend until Fri, Nov 6"
        amountCents={expected.safeToSpendCents}
        status="≈ $100 a day for 10 days"
      />,
    );
    expect(screen.getByText("≈ $100 a day for 10 days").className).toContain("heroStatus");
  });

  it("warns in development when the default variant gets a negative amount", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<HeroCard label="Safe to spend" amountCents={-79299} />);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("shortfall variant: label, decision chip and shortfall rounded up (golden $793 short)", () => {
    const { container } = render(
      <HeroCard variant="shortfall" paydayLabel="Fri, Nov 6" amountCents={shortfall.safeToSpendCents} />,
    );
    expect(screen.getByRole("heading", { name: "Short before Fri, Nov 6" })).toBeTruthy();
    expect(screen.getByText("Needs a decision")).toBeTruthy();
    expect(screen.getByText(shortfall.heroDisplay)).toBeTruthy();
    expect(container.querySelector("[data-variant='shortfall']")).toBeTruthy();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <HeroCard
        variant="shortfall"
        paydayLabel="Fri, Nov 6"
        amountCents={shortfall.safeToSpendCents}
        breakdown={<a href="#math">See the math</a>}
      />,
    );
    await expectNoAxeViolations(container);
  });
});

describe("AttentionCard", () => {
  it("carries its label in text, not color alone", async () => {
    const { container } = render(
      <AttentionCard label="Needs a decision · Jordan" title="Car insurance renews Nov 4">
        <p>Body</p>
      </AttentionCard>,
    );
    expect(screen.getByText("Needs a decision · Jordan")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Car insurance renews Nov 4" })).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});
