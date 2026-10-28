import type { Preview } from "@storybook/react-vite";
import "../../../design/tokens.css";
import "./preview.css";

const preview: Preview = {
  parameters: {
    layout: "padded",
    // The a11y addon shows axe results in the Storybook panel. Nothing here fails a build: violations
    // are enforced by `pnpm --filter @mp/ui test` (axe in jsdom on every story) and by
    // `test:visual` (axe in Chromium, color contrast on, visual/a11y.spec.ts).
    a11y: { test: "error" },
    controls: { expanded: true },
  },
};

export default preview;
