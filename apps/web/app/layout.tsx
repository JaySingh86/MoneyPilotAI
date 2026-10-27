import type { ReactNode } from "react";

export const metadata = {
  title: "MoneyPilot",
  description: "Household planning: what's coming before payday and what to decide together.",
};

// WP-04 adds the token stylesheet; WP-17 builds the app shell.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
