import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import "../../../design/tokens.css";
import "./globals.css";
import { inter, manrope } from "./fonts";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: "MoneyPilot", template: "%s · MoneyPilot" },
  description: "Household planning: what's coming before payday and what to decide together.",
};

// Every page renders per request, so Next can put the Content-Security-Policy nonce (middleware.ts)
// on the scripts it emits.
export const dynamic = "force-dynamic";

// The tokens name the families (`--mp-font-body`, `--mp-font-display`); next/font loads them under
// generated names, so the variables are pointed at those here.
const fontVariables = {
  "--mp-font-body": `${inter.style.fontFamily}, system-ui, sans-serif`,
  "--mp-font-display": `${manrope.style.fontFamily}, ${inter.style.fontFamily}, system-ui, sans-serif`,
} as CSSProperties;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" style={fontVariables}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
