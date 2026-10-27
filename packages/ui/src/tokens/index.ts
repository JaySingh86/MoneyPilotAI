// Design tokens for code (WP-04). Values come from design/tokens.json; web styles should
// prefer `cssVar` so they follow design/tokens.css (and a future dark theme).
// `cssVar.size.focusRing` is the full outline shorthand (`2px solid` brand.default), while
// `tokens.size.focusRing` is only the ring width; use the latter with your own outline style.
export { cssVar, tokens } from "./tokens.generated";
export type { CssVar, Tokens } from "./tokens.generated";
