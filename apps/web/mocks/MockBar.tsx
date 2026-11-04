"use client";

import { SegmentedControl } from "@mp/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Scenario } from "./model";
import styles from "./mock-bar.module.css";
import { setScenario, state } from "./state";

const OPTIONS = [
  { value: "base", label: "On track" },
  { value: "shortfall", label: "Shortfall" },
  { value: "empty", label: "New household" },
] as const;

/**
 * Dev toolbar, shown only in mock mode: says the data is mocked and switches the scenario the mock
 * API serves. Hide it with `?devbar=0` (the screenshot tests do).
 */
export function MockBar() {
  const queryClient = useQueryClient();
  const [scenario, setLocal] = useState<Scenario>(state.scenario);
  const [hidden] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("devbar") === "0",
  );
  if (hidden) return null;
  return (
    <aside className={styles.bar} aria-label="Mock data controls">
      <span className={styles.label}>Mock data</span>
      <SegmentedControl
        label="Scenario"
        value={scenario}
        options={OPTIONS}
        onChange={(value) => {
          setScenario(value);
          setLocal(value);
          void queryClient.invalidateQueries();
        }}
      />
    </aside>
  );
}
