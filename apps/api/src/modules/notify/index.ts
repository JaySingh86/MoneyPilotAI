// Notify module (WP-15): the notifications list, read state and email preferences under `/v1`, and the SES
// delivery-event webhook under `/webhooks`. Registered once in modules/index.ts as `...notifyModules`.
import { defineModule, WEBHOOKS_PREFIX } from "../../lib/module";
import { createCertificateLoader, type CertificateLoader } from "../../lib/webhooks";
import { runtime, type RuntimeSource } from "../../auth/runtime";
import { notifyRoutes } from "./routes";
import { sesEventsRoutes } from "./ses-events";

export interface NotifyModuleOptions {
  /** Where `SES_EVENTS_TOPIC_ARNS` (comma separated) and `AWS_REGION` come from. Default: the process environment. */
  env?: () => Record<string, string | undefined>;
  loadCertificate?: CertificateLoader;
  confirmSubscription?: (url: string) => Promise<void>;
  nowMs?: () => number;
}

/** GETs the SNS confirmation URL and checks the status only; the response body is never read. */
export async function fetchConfirm(url: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
  await res.body?.cancel();
  if (!res.ok) throw new Error("subscription confirmation failed");
}

export function createNotifyModules(source: RuntimeSource = runtime, options: NotifyModuleOptions = {}) {
  const env = options.env ?? (() => process.env);
  const loadCertificate = options.loadCertificate ?? createCertificateLoader();
  return [
    defineModule({ name: "notify", routes: notifyRoutes(() => ({ db: source().db })) }),
    defineModule({
      name: "notify-webhooks",
      prefix: WEBHOOKS_PREFIX,
      routes: sesEventsRoutes(() => ({
        db: source().db,
        allowedTopicArns: (env().SES_EVENTS_TOPIC_ARNS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        region: env().AWS_REGION,
        loadCertificate,
        confirmSubscription: options.confirmSubscription ?? fetchConfirm,
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
      })),
    }),
  ] as const;
}

export const notifyModules = createNotifyModules();
export { createDbSendQuota } from "./send-quota";
export { notifyProposalCreated, notifyProposalDecided } from "./hooks";
