// Wire types for the review queue, applied changes, sender rules (WP-14), CSV imports (WP-16), billing
// (WP-25), automation stats and households (all from @mp/contracts), and for the endpoints that have no
// contract yet: email connections (WP-21), forwarding address, activity and sharing (WP-20, WP-24). The
// assumed shapes are marked "ASSUMED" and tracked on their owner packages (Q-173, Q-177).

import type { components } from "@mp/contracts/client";

type Schemas = components["schemas"];
export type ExtractedFields = Schemas["ExtractedFields"];
export type ReviewItem = Schemas["ReviewItem"];
export type ReviewState = ReviewItem["state"];
export type AppliedChange = Schemas["AppliedChange"];
export type ReviewDecision = Schemas["ReviewDecision"];
export type SenderRule = Schemas["SenderRule"];
export type ItemCategory = NonNullable<ExtractedFields["category"]>;
export type EditFields = Schemas["EditReviewItem"]["fields"];
export type Import = Schemas["Import"];
export type CreatedImport = Schemas["CreatedImport"];
export type ImportUpload = CreatedImport["upload"];
export type ColumnMapping = Schemas["ImportColumnMapping"];
export type AutomationStats = Schemas["AutomationStats"];
export type BillingState = Schemas["BillingState"];

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

// ASSUMED shapes -------------------------------------------------------------------------------

/** ASSUMED (WP-21, BACKEND_PLAN §8.2 "List (masked)"). */
export interface EmailConnection {
  id: string;
  provider: "gmail" | "outlook";
  ownerUserId: string;
  /** Already masked by the API: `sam•••@gmail.com`. */
  maskedAddress: string;
  status: "connected" | "paused" | "error";
  lastCheckedAt: string | null;
  backfillMonths: number;
  matchedCount: number;
  usedCount: number;
}

/**
 * ASSUMED (WP-21, confirmed in Q-173): `POST /email-connections/:provider/start { returnTo }` returns `{ authUrl }`.
 * `returnTo` is an enum, never a URL; the callback redirects to `{returnTo}?connected=<provider>` or
 * `?connect_error=<code>`.
 */
export interface StartConnectionResponse {
  authUrl: string;
}

/** ASSUMED: the forwarding address card (`rotate` is BACKEND_PLAN §8.2). */
export interface ForwardingInfo {
  address: string;
  receivedCount: number;
}

/** The import the person just made, kept in client state for the Bank CSV row (there is no "latest" endpoint, Q-174). */
export interface CsvImportSummary {
  id: string;
  filename: string;
  importedAt: string;
}

export interface ActivityEntry {
  id: string;
  /** "Imported checking-oct.csv": server-written, no amounts. */
  action: string;
  actorName: string;
  at: string;
}

/** ASSUMED: the "What {partner} can see from your data" switches, per signed-in member. */
export interface SharingPreferences {
  billsFromEmail: boolean;
  tasks: boolean;
  connectedAddress: boolean;
}

/** ASSUMED: WP-24 `POST …/exports` and `POST …/deletion`. */
export interface ExportRequest {
  id: string;
  status: "queued";
}

export interface DeletionRequest {
  scheduledFor: string;
}

/** The income items that can set the payday (the primary income select). */
export interface IncomeOption {
  id: string;
  name: string;
  /** Server text: "every other Friday". */
  scheduleLabel: string;
}
