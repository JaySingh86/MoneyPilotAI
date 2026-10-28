import type { StorybookConfig } from "@storybook/react-vite";

// Storybook requires a default export here (CSF config), an allowed exception to the
// no-default-exports convention.
const config: StorybookConfig = {
  stories: ["../src/components/**/*.stories.tsx"],
  addons: ["@storybook/addon-a11y"],
  framework: { name: "@storybook/react-vite", options: {} },
  core: { disableTelemetry: true },
};

export default config;
