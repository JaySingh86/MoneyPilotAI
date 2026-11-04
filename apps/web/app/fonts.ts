// The two typefaces, self-hosted (DESIGN_SPEC §2.2): Manrope 600/700/800 for display and amounts,
// Inter 400/500/600 for text. Latin subsets of the variable fonts, SIL Open Font License. Serving
// them from our own origin keeps Google out of the page's `font-src` and `style-src`.
import localFont from "next/font/local";

export const inter = localFont({
  src: "./fonts/inter-latin-variable.woff2",
  weight: "400 600",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

export const manrope = localFont({
  src: "./fonts/manrope-latin-variable.woff2",
  weight: "600 800",
  display: "swap",
  fallback: ["Inter", "system-ui", "sans-serif"],
});
