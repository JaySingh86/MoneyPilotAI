/// <reference types="vite/client" />
// Runs axe on every Storybook story (every component state) in jsdom. The Storybook a11y addon
// runs the same engine in a real browser, where color contrast is also checked.
import { composeStories } from "@storybook/react-vite";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "./axe";

// Native interactive elements and explicit tab stops. Radio cards use a roving tabindex
// (one tab stop per group), so tabindex="-1" radios are reached with arrow keys instead.
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled]):not([tabindex='-1'])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex='0']",
].join(", ");

type StoriesModule = Parameters<typeof composeStories>[0];

const modules = import.meta.glob<StoriesModule>("../**/*.stories.tsx", { eager: true });

describe("every story", () => {
  it("covers every component folder", () => {
    const folders = new Set(Object.keys(modules).map((p) => p.split("/")[1]));
    expect([...folders].sort()).toEqual([
      "avatar",
      "button",
      "calendar",
      "card",
      "field",
      "filter-pills",
      "kpi-tile",
      "list-row",
      "math-breakdown",
      "navigation",
      "progress-bar",
      "radio-card",
      "review-queue",
      "runway-chart",
      "segmented-control",
      "states",
      "status-chip",
      "stepper",
      "switch",
      "table",
    ]);
  });
});

for (const [path, mod] of Object.entries(modules)) {
  const stories = composeStories(mod) as Record<string, ComponentType>;
  describe(path, () => {
    for (const [name, Story] of Object.entries(stories)) {
      it(`${name} has no axe violations`, async () => {
        const { container } = render(<Story />);
        await expectNoAxeViolations(container);
      });

      it(`${name}: every interactive element is reachable with Tab, in order`, async () => {
        const { container } = render(<Story />);
        const expected = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const reached: Element[] = [];
        for (let i = 0; i < expected.length; i++) {
          await userEvent.tab();
          if (document.activeElement) reached.push(document.activeElement);
        }
        expect(reached).toEqual(expected);
      });
    }
  });
}
