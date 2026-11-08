// The OAuth return trip: the API's callback redirects to `/imports?connected=gmail` on success or
// `/imports?connect_error=<reason>` when the person said no or the provider failed.

export type ConnectResult =
  { kind: "connected"; provider: "gmail" | "outlook"; message: string } | { kind: "error"; message: string };

const NAMES = { gmail: "Gmail", outlook: "Outlook" } as const;

export function parseConnectResult(search: string): ConnectResult | null {
  const params = new URLSearchParams(search);
  const connected = params.get("connected");
  if (connected === "gmail" || connected === "outlook") {
    return {
      kind: "connected",
      provider: connected,
      message: `${NAMES[connected]} connected. We’re looking back 13 months for bills and renewals.`,
    };
  }
  const error = params.get("connect_error");
  if (error === null) return null;
  return {
    kind: "error",
    message:
      error === "access_denied"
        ? "Access wasn’t allowed, so nothing was connected. You can try again any time."
        : "The provider didn’t finish the connection. Nothing was connected. Try again.",
  };
}
