// Push channel (FCM; APNs is reached through FCM). P1, mobile phase (BACKEND_PLAN §7.6): only the interface
// exists today, so the dispatcher can already treat `push` as a channel. Nothing implements it yet.

export interface PushMessage {
  /** FCM registration token from `devices`. */
  deviceToken: string;
  /** No amounts (lock-screen privacy), same rule as email subjects. */
  title: string;
  body: string;
  /** App-relative deep link. */
  deepLink?: string | undefined;
}

export interface PushChannel {
  send(message: PushMessage): Promise<{ providerMessageId: string }>;
}

/** What is wired until the mobile phase lands: it refuses, so nothing reports a push as sent. */
export const unavailablePushChannel: PushChannel = {
  async send() {
    throw new Error("The push channel is not available yet (mobile phase).");
  },
};
