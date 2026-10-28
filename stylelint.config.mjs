// Stylelint for UI CSS (WP-10, ARCHITECTURE §8, CLAUDE.md hard rule 6): packages/ui and apps/web.
// Mirrors the ESLint token rule for CSS files. Tokens are required for color, type, spacing,
// radius, shadow and motion timing. Component dimensions DESIGN_SPEC §4 gives in px but has no
// token for (switch track 52×32, calendar cell min-height 112, 1 px borders) may use px on
// width, height, border and outline properties.
// A spec or canvas value with no token (for example "padding 3") needs a stylelint-disable
// comment with a reason; disables without a description fail the lint (Q-040).

const NO_LENGTH = ["px", "rem", "em", "pt", "pc", "vw", "vh", "%"];
const NO_ABSOLUTE = ["px", "rem", "em", "pt", "pc"];
const NO_TIME = ["ms", "s"];

/** @type {import("stylelint").Config} */
export default {
  ignoreFiles: [
    "**/node_modules/**",
    "**/dist/**",
    "**/.next/**",
    "**/storybook-static/**",
    "design/**",
    // Token files are the one place raw values live.
    "**/tokens/**",
  ],
  reportDescriptionlessDisables: true,
  reportNeedlessDisables: true,
  reportInvalidScopeDisables: true,
  rules: {
    "color-no-hex": true,
    "color-named": "never",
    "function-disallowed-list": ["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch"],
    "declaration-property-unit-disallowed-list": [
      {
        "font-size": NO_LENGTH,
        font: NO_LENGTH,
        "line-height": NO_LENGTH,
        "letter-spacing": NO_ABSOLUTE,
        "/^padding/": NO_LENGTH,
        "/^margin/": NO_LENGTH,
        "/^(gap|row-gap|column-gap)$/": NO_LENGTH,
        "/radius$/": ["px", "rem", "em", "pt"],
        "box-shadow": NO_LENGTH,
        // Positioning uses token spacing or percentages, never a raw px offset.
        "/^(top|right|bottom|left|inset)$/": NO_ABSOLUTE,
        // Motion timing comes from --mp-duration (0 ms under prefers-reduced-motion).
        "/^(transition|animation)(-duration|-delay)?$/": NO_TIME,
      },
    ],
    "declaration-property-value-allowed-list": [
      {
        // Only the loaded weights (DESIGN_SPEC §2.2 uses 400 to 800).
        "font-weight": ["/^(400|500|600|700|800)$/"],
        // Sizes come from the type scale; `font` and `font-size` take a --mp-type-* token.
        font: ["/^(var\\(--mp-type-|inherit$)/"],
        "font-size": ["/^var\\(--mp-/"],
        "line-height": ["/^var\\(--mp-/"],
        "letter-spacing": ["/^var\\(--mp-tracking-/"],
      },
    ],
    "declaration-property-value-disallowed-list": [
      {
        // Typography goes through --mp-font-*; no ad-hoc families.
        "font-family": ["/^(?!var\\(--mp-font-)/"],
      },
    ],
  },
};
