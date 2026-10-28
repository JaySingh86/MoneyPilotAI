import { computePlan } from "../plan";
import { riveraInput } from "../testing";
import { flags } from "./flags";
import { computeFullPlan } from "./full-plan";

describe("computeFullPlan", () => {
  it("is the core plan plus flags, decisions and (on track) no shortfall options", () => {
    const input = riveraInput();
    const full = computeFullPlan(input);
    const { flags: coreFlags, ...core } = computePlan(input);
    expect(full).toMatchObject(core);
    expect(coreFlags).toEqual([]);
    expect(full.flags).toEqual(flags(input));
    expect(full.decisions).toHaveLength(3);
    expect(full.shortfallOptions).toEqual([]);
  });

  it("keeps stale_balance first", () => {
    const input = riveraInput();
    input.startingBalance = { cents: 340000, asOf: "2026-10-01" };
    expect(computeFullPlan(input).flags[0]?.code).toBe("stale_balance");
  });

  it("is deterministic", () => {
    expect(computeFullPlan(riveraInput({ scenario: "shortfall" }))).toEqual(
      computeFullPlan(riveraInput({ scenario: "shortfall" })),
    );
  });
});
