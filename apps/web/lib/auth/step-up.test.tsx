// Step-up (ADR-018): concurrent calls share one dialog and all retry once after one code.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { renderApp } from "../../test/render";
import { useStepUp } from "./StepUp";
import { AuthError, authMessage } from "./types";

function Probe({ calls, onDone }: { calls: { n: number }; onDone: (results: string[]) => void }) {
  const withStepUp = useStepUp();
  const make = (name: string) => {
    let attempts = 0;
    return () =>
      withStepUp(async () => {
        attempts += 1;
        calls.n += 1;
        if (attempts === 1) throw new ApiError(403, "mfa_required", "needs a code");
        return name;
      });
  };
  return <button onClick={() => void Promise.all([make("a")(), make("b")()]).then(onDone)}>Run both</button>;
}

describe("step-up dialog", () => {
  it("opens one dialog for two concurrent mfa_required failures and retries both once", async () => {
    const calls = { n: 0 };
    let results: string[] = [];
    renderApp(<Probe calls={calls} onDone={(r) => (results = r)} />);
    await userEvent.click(await screen.findByRole("button", { name: "Run both" }));
    const dialogs = await screen.findAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    await userEvent.type(within(dialogs[0] as HTMLElement).getByLabelText("6-digit code"), "123456");
    await userEvent.click(within(dialogs[0] as HTMLElement).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(results).toEqual(["a", "b"]));
    expect(calls.n).toBe(4); // each ran twice: the refused attempt and one retry
  });
});

describe("step-up copy", () => {
  it("says plainly when the 2-step check is not wired yet", () => {
    expect(authMessage(new AuthError("step_up_unavailable", "x"))).toBe(
      "The 2-step check isn’t available yet in this environment.",
    );
  });
});
