// WP-23 mock API handlers: review queue, applied changes, sender rules, email connections, CSV imports,
// household settings, invites, leave, privacy actions. Registered with one line in handlers.ts.
// Shapes follow @mp/contracts where it has them and lib/api/imports-types.ts where it does not.
import { http, HttpResponse } from "msw";
import { API_BASE_URL } from "../lib/config";
import type {
  AppliedChange,
  EmailConnection,
  Import,
  ReviewDecision,
  ReviewItem,
  SenderRule,
} from "../lib/api/imports-types";
import { HOUSEHOLD_ID, SAM_ID } from "./identity";
import {
  ACTIVITY,
  INVITE_LIMIT_PER_DAY,
  SAFE_AFTER_ELECTRICITY,
  SAFE_TO_SPEND_NOW,
  automationStats,
  csvReviewItems,
  forwarding,
  wp23,
} from "./wp23-data";
import { state } from "./state";

let createdItems = 0;
const API = `${API_BASE_URL}/v1`;
const HH = `${API}/households/:hid`;

function problem(status: number, code: string, detail: string, reason?: string): Response {
  return HttpResponse.json(
    { type: `/problems/${code}`, title: detail, status, code, detail, ...(reason ? { reason } : {}) },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

/**
 * The API's `idempotency: "required"` routes answer 400 `validation_failed` without an Idempotency-Key. The mock
 * does the same so a missing key fails a test (apps/api/src/plugins/idempotency.ts).
 */
function missingKey(request: Request): Response | null {
  return request.headers.get("idempotency-key")
    ? null
    : problem(400, "validation_failed", "The Idempotency-Key header is invalid.");
}

const notFound = () => problem(404, "not_found", "Not found.");
const webOrigin = (): string => globalThis.location?.origin ?? "http://localhost:3100";
const BASE_SAFE_TO_SPEND = SAFE_TO_SPEND_NOW;

function stamp(): string {
  return "2026-10-27T13:00:00Z";
}

function decide(
  item: ReviewItem,
  kind: "confirm" | "edit" | "ignore",
  edits?: Partial<ReviewItem["fields"]>,
): ReviewDecision {
  const fields = { ...item.fields, ...(edits ?? {}) };
  const decided: ReviewItem = {
    ...item,
    fields,
    state: kind === "ignore" ? "ignored" : kind === "edit" ? "edited" : "confirmed",
    evidenceStale: kind === "edit",
    decidedBy: SAM_ID,
    decidedAt: stamp(),
  };
  if (kind === "ignore")
    return { item: decided, appliedChange: null, plan: { safeToSpendCents: BASE_SAFE_TO_SPEND } };
  const name = decided.matchType === "new" ? (fields.providerName ?? "Item") : nameFor(item);
  const change: AppliedChange = {
    id: `6d8e0003-0000-4000-8000-0000000001${item.id.slice(-2)}`,
    origin: "email",
    entityType: decided.matchType === "decision" ? "task" : "recurring_item",
    entityId: item.matchItemId ?? item.id,
    entityName: name,
    before: decided.matchType === "new" || decided.matchType === "decision" ? null : { amountCents: null },
    after: {
      ...(fields.amountDueCents !== null ? { amountCents: fields.amountDueCents } : {}),
      ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
      ...(fields.decisionByDate ? { dueDate: fields.decisionByDate } : {}),
    },
    appliedBy: SAM_ID,
    appliedAt: stamp(),
    undoUntil: "2026-11-26T13:00:00Z",
    undoneAt: null,
    undoneBy: null,
    undoable: true,
  };
  decided.appliedChangeId = change.id;
  const edited =
    kind === "edit" &&
    edits?.amountDueCents !== undefined &&
    edits.amountDueCents !== item.fields.amountDueCents;
  // The engine's number for the electricity actual (fixture `expected`); every other item leaves it alone.
  const safe = edited ? null : item.matchItemId === "b-power" ? SAFE_AFTER_ELECTRICITY : BASE_SAFE_TO_SPEND;
  return { item: decided, appliedChange: change, plan: safe === null ? null : { safeToSpendCents: safe } };
}

function nameFor(item: ReviewItem): string {
  if (item.fields.category === "utilities") return "Electricity";
  if (item.fields.insuranceType === "renters") return "Renters insurance";
  return item.fields.providerName ?? "Item";
}

function pending(id: string): ReviewItem | undefined {
  return wp23.queue.find((i) => i.id === id);
}

function queueFor(): ReviewItem[] {
  return state.scenario === "empty" ? [] : wp23.queue;
}

function blankImport(id: string, filename: string, status: Import["status"], createdAt: string): Import {
  return {
    id,
    filename,
    status,
    columns: null,
    suggestedMapping: null,
    mapping: null,
    rowCount: null,
    addedCount: null,
    duplicateCount: null,
    rejectedCount: null,
    detectedCount: null,
    queuedCount: null,
    latestBalance: null,
    error: null,
    createdAt,
    processedAt: null,
  };
}

/** What the worker leaves behind. `needs-mapping*.csv` has unknown headers, `broken*.csv` cannot be read. */
function finishImport(imp: Import): Import {
  const processedAt = "2026-10-27T13:00:05Z";
  if (imp.filename.startsWith("broken"))
    return { ...imp, status: "failed", error: "parse_failed", processedAt };
  if (imp.filename.startsWith("needs-mapping") && imp.mapping === null)
    return {
      ...imp,
      status: "needs_mapping",
      columns: ["Posted", "Memo", "Money"],
      suggestedMapping: { date: "Posted", description: "Memo", amountSign: "outflow_negative" },
    };
  const found = csvReviewItems();
  wp23.queue = [...wp23.queue, ...found];
  return {
    ...imp,
    status: "done",
    rowCount: 214,
    addedCount: 214,
    duplicateCount: 0,
    rejectedCount: 0,
    detectedCount: found.length,
    queuedCount: found.length,
    processedAt,
  };
}

export const wp23Handlers = [
  // ---- review queue ----------------------------------------------------------------------------
  http.get(`${HH}/review-items`, () => HttpResponse.json({ data: queueFor(), nextCursor: null })),
  http.post(`${HH}/review-items/:id/:action`, async ({ params, request }) => {
    const item = pending(String(params.id));
    if (!item) return notFound();
    const action = String(params.action);
    if (action !== "confirm" && action !== "ignore" && action !== "edit") return notFound();
    let edits: Partial<ReviewItem["fields"]> | undefined;
    if (action === "edit") {
      const body = (await request.json()) as { fields?: Partial<ReviewItem["fields"]> };
      edits = body.fields;
      if (!edits || Object.keys(edits).length === 0)
        return problem(400, "validation_failed", "Send at least one field.");
    }
    wp23.queue = wp23.queue.filter((i) => i.id !== item.id);
    const decision = decide(item, action, edits);
    wp23.decided.push(decision.item);
    return HttpResponse.json(decision);
  }),

  // ---- applied changes -------------------------------------------------------------------------
  http.get(`${HH}/applied-changes`, () =>
    HttpResponse.json({
      data: state.scenario === "empty" ? [] : wp23.applied.filter((c) => c.appliedBy === null && !c.undoneAt),
      nextCursor: null,
    }),
  ),
  http.post(`${HH}/applied-changes/:id/undo`, ({ params }) => {
    const change = wp23.applied.find((c) => c.id === params.id);
    if (!change) return notFound();
    // The car insurance renewal is Jordan's item: undoing it needs Jordan's approval (BACKEND_PLAN §7.3).
    if (change.entityName === "Car insurance renewal")
      return problem(403, "approval_required", "This change is on Jordan’s item and needs their approval.");
    const undone = { ...change, undoneAt: stamp(), undoneBy: SAM_ID, undoable: false };
    wp23.applied = wp23.applied.map((c) => (c.id === change.id ? undone : c));
    return HttpResponse.json(undone);
  }),

  // ---- sender rules ----------------------------------------------------------------------------
  http.get(`${HH}/sender-rules`, () => HttpResponse.json({ data: wp23.rules })),
  http.post(`${HH}/sender-rules`, async ({ request }) => {
    const noKey = missingKey(request);
    if (noKey) return noKey;
    const body = (await request.json()) as {
      domain: string;
      rule: SenderRule["rule"];
      categoryHint?: SenderRule["categoryHint"];
    };
    const existing = wp23.rules.find((r) => r.domain === body.domain);
    const rule: SenderRule = existing
      ? { ...existing, rule: body.rule }
      : {
          id: `6d8e0004-0000-4000-8000-${String(wp23.rules.length + 1).padStart(12, "0")}`,
          domain: body.domain,
          rule: body.rule,
          categoryHint: body.categoryHint ?? null,
          createdBy: SAM_ID,
        };
    wp23.rules = existing ? wp23.rules.map((r) => (r.id === rule.id ? rule : r)) : [...wp23.rules, rule];
    return HttpResponse.json(rule, { status: existing ? 200 : 201 });
  }),

  // ---- email connections (WP-21, assumed) --------------------------------------------------------
  http.get(`${HH}/email-connections`, () => HttpResponse.json({ data: wp23.connections })),
  http.post(`${API}/email-connections/:provider/start`, async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as { returnTo?: string };
    // `returnTo` is an enum, never a URL (Q-173): anything else is refused, so the callback is no open redirect.
    if (body.returnTo !== "/imports" && body.returnTo !== "/setup")
      return problem(400, "validation_failed", "returnTo must be /imports or /setup.");
    if (wp23.requireStepUp) return problem(403, "mfa_required", "Confirm with 2-step verification first.");
    const provider = params.provider === "outlook" ? "outlook" : "gmail";
    // The API redirects the browser back to the web app after the provider's consent screen. The
    // mock skips the consent page and completes the connection here.
    const connection: EmailConnection = {
      id: `6d8e0005-0000-4000-8000-0000000000${wp23.connections.length + 2}`,
      provider,
      ownerUserId: SAM_ID,
      maskedAddress: provider === "gmail" ? "sam•••@gmail.com" : "sam•••@outlook.com",
      status: "connected",
      lastCheckedAt: new Date().toISOString(),
      backfillMonths: 13,
      matchedCount: 0,
      usedCount: 0,
    };
    wp23.connections = [...wp23.connections.filter((c) => c.ownerUserId !== SAM_ID), connection];
    return HttpResponse.json({
      authUrl: `${webOrigin()}${body.returnTo}?connected=${provider}`,
    });
  }),
  http.post(`${API}/email-connections/:id/:action`, ({ params }) => {
    const found = wp23.connections.find((c) => c.id === params.id);
    if (!found) return notFound();
    if (found.ownerUserId !== SAM_ID)
      return problem(403, "forbidden", "Only the mailbox owner can change it.");
    const status = params.action === "pause" ? "paused" : "connected";
    wp23.connections = wp23.connections.map((c) => (c.id === found.id ? { ...c, status } : c));
    return HttpResponse.json({ ...found, status });
  }),
  http.delete(`${API}/email-connections/:id`, ({ params }) => {
    const found = wp23.connections.find((c) => c.id === params.id);
    if (!found) return notFound();
    if (found.ownerUserId !== SAM_ID)
      return problem(403, "forbidden", "Only the mailbox owner can disconnect it.");
    wp23.connections = wp23.connections.filter((c) => c.id !== found.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${HH}/forwarding-address`, () => HttpResponse.json(forwarding())),
  http.post(`${HH}/forwarding-address/rotate`, () => {
    wp23.forwardingToken = "rivera-9m4";
    return HttpResponse.json(forwarding());
  }),
  http.get(`${HH}/automation-stats`, () => HttpResponse.json(automationStats())),
  http.post(`${HH}/members/:uid/reminders`, ({ params }) => {
    wp23.remindersSent.add(String(params.uid));
    return new HttpResponse(null, { status: 204 });
  }),

  // ---- accepting an invite (WP-05). The first character of the token picks the outcome in dev and tests. ---
  http.post(`${API}/invites/accept`, async ({ request }) => {
    const { token } = (await request.json()) as { token: string };
    switch (token[0]) {
      case "N":
        return problem(404, "not_found", "This invitation was not found.");
      case "E":
        return problem(409, "conflict", "This invitation has expired. Ask for a new one.", "expired");
      case "R":
        return problem(409, "conflict", "This invitation was cancelled. Ask for a new one.", "revoked");
      case "U":
        return problem(409, "conflict", "This invitation was already used.", "used");
      case "F":
        return problem(409, "conflict", "This household already has two adults.", "full");
      case "H":
        return problem(
          409,
          "conflict",
          "You already belong to a household. Leave it first.",
          "in_other_household",
        );
      case "M":
        return problem(
          403,
          "forbidden",
          "This invitation was sent to j•••@example.test. Sign in with that email address to accept it.",
          "wrong_email",
        );
      default:
        wp23.joinedByInvite = true;
        return HttpResponse.json({ householdId: HOUSEHOLD_ID });
    }
  }),

  // ---- CSV imports (WP-16 contract) ----------------------------------------------------------------
  http.post(`${HH}/imports`, async ({ request }) => {
    const body = (await request.json()) as { filename: string; sizeBytes: number };
    const id = `6d8e0008-0000-4000-8000-0000000001${String(wp23.imports.size).padStart(2, "0")}`;
    const created = "2026-10-27T13:00:00Z";
    const imp = blankImport(id, body.filename, "uploaded", created);
    wp23.imports.set(id, imp);
    return HttpResponse.json(
      {
        import: imp,
        upload: {
          method: "PUT",
          url: `${webOrigin()}/mock-upload/${id}`,
          headers: { "content-type": "text/csv" },
          fields: {},
          expiresAt: "2026-10-27T13:15:00Z",
          maxBytes: body.sizeBytes,
        },
      },
      { status: 201 },
    );
  }),
  http.put(`${webOrigin()}/mock-upload/:id`, () => new HttpResponse(null, { status: 200 })),
  // `process` answers `processing`; the next read has the result, as the worker would leave it.
  http.post(`${HH}/imports/:id/process`, ({ params }) => {
    const imp = wp23.imports.get(String(params.id));
    if (!imp) return notFound();
    const queued: Import = { ...imp, status: "processing" };
    wp23.imports.set(imp.id, queued);
    return HttpResponse.json(queued);
  }),
  http.put(`${HH}/imports/:id/mapping`, async ({ params, request }) => {
    const imp = wp23.imports.get(String(params.id));
    if (!imp) return notFound();
    if (imp.status !== "needs_mapping")
      return problem(409, "conflict", "This import does not need a mapping.");
    const mapping = (await request.json()) as NonNullable<Import["mapping"]>;
    const queued: Import = { ...imp, status: "processing", mapping };
    wp23.imports.set(imp.id, queued);
    return HttpResponse.json(queued);
  }),
  http.get(`${HH}/imports/:id`, ({ params }) => {
    const imp = wp23.imports.get(String(params.id));
    if (!imp) return notFound();
    if (imp.status !== "processing") return HttpResponse.json(imp);
    const settled = finishImport(imp);
    wp23.imports.set(imp.id, settled);
    return HttpResponse.json(settled);
  }),

  http.post(`${API}/households`, async ({ request }) => {
    const noKey = missingKey(request);
    if (noKey) return noKey;
    const body = (await request.json()) as { name: string };
    wp23.household.name = body.name;
    return HttpResponse.json(
      {
        id: HOUSEHOLD_ID,
        name: body.name,
        timezone: "America/New_York",
        currency: "USD",
        cushionCents: wp23.household.cushionCents,
        primaryIncomeItemId: null,
        plan: "free",
        forwardingToken: wp23.forwardingToken,
        deletionScheduledFor: null,
        version: 1,
        createdAt: stamp(),
        updatedAt: stamp(),
      },
      { status: 201 },
    );
  }),

  // ---- household settings (WP-05 contracts) ---------------------------------------------------
  http.post(`${HH}/items`, async ({ request }) => {
    const noKey = missingKey(request);
    if (noKey) return noKey;
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json(
      {
        ...body,
        id: `6d8e000c-0000-4000-8000-0000000000${String(++createdItems).padStart(2, "0")}`,
        householdId: HOUSEHOLD_ID,
        source: "manual",
        version: 1,
        createdAt: stamp(),
        updatedAt: stamp(),
      },
      { status: 201 },
    );
  }),
  http.patch(`${HH}`, async ({ request }) => {
    const body = (await request.json()) as {
      name?: string;
      cushionCents?: number;
      primaryIncomeItemId?: string;
    };
    if (body.name !== undefined) wp23.household.name = body.name;
    if (body.cushionCents !== undefined) wp23.household.cushionCents = body.cushionCents;
    if (body.primaryIncomeItemId !== undefined) wp23.household.primaryIncomeItemId = body.primaryIncomeItemId;
    return HttpResponse.json({
      id: HOUSEHOLD_ID,
      name: wp23.household.name,
      timezone: "America/New_York",
      currency: "USD",
      cushionCents: wp23.household.cushionCents,
      primaryIncomeItemId: wp23.household.primaryIncomeItemId,
      plan: "family_plus",
      forwardingToken: wp23.forwardingToken,
      deletionScheduledFor: wp23.deletionScheduledFor,
      version: 2,
      createdAt: "2026-10-20T14:00:00Z",
      updatedAt: stamp(),
    });
  }),
  http.post(`${HH}/invites`, async ({ request }) => {
    const noKey = missingKey(request);
    if (noKey) return noKey;
    if (wp23.invitesToday >= INVITE_LIMIT_PER_DAY)
      return problem(429, "rate_limited", "You can send 5 invites a day.");
    const body = (await request.json()) as { email: string; firstName?: string };
    wp23.invitesToday += 1;
    wp23.invite = {
      id: `6d8e0009-0000-4000-8000-0000000000${wp23.invitesToday + 1}`,
      email: body.email,
      firstName: body.firstName ?? null,
      expiresAt: "2026-11-03T14:00:00Z",
      createdAt: stamp(),
    };
    return HttpResponse.json(wp23.invite, { status: 201 });
  }),
  // "Resend": a new link on the same open invite. It counts against the same daily send quota.
  http.post(`${HH}/invites/:id/resend`, ({ params, request }) => {
    const noKey = missingKey(request);
    if (noKey) return noKey;
    if (!wp23.invite || wp23.invite.id !== params.id) return notFound();
    if (wp23.invitesToday >= INVITE_LIMIT_PER_DAY)
      return problem(429, "rate_limited", "You can send 5 invites a day.");
    wp23.invitesToday += 1;
    wp23.invite = { ...wp23.invite, expiresAt: "2026-11-03T14:00:00Z" };
    return HttpResponse.json(wp23.invite);
  }),
  http.delete(`${HH}/invites/:id`, () => {
    wp23.invite = null;
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${HH}/leave`, () => {
    if (wp23.requireStepUp) return problem(403, "mfa_required", "Confirm with 2-step verification first.");
    wp23.left = true;
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${HH}/sharing`, () => HttpResponse.json(wp23.sharing)),
  http.put(`${HH}/sharing`, async ({ request }) => {
    wp23.sharing = (await request.json()) as typeof wp23.sharing;
    return HttpResponse.json(wp23.sharing);
  }),
  http.get(`${HH}/activity`, () => HttpResponse.json({ data: ACTIVITY, nextCursor: null })),
  http.get(`${HH}/billing`, () =>
    HttpResponse.json({
      plan: "family_plus",
      status: "active",
      interval: "month",
      currentPeriodEnd: "2026-11-26T13:00:00Z",
      cancelAtPeriodEnd: false,
      isBillingOwner: true,
      available: true,
      entitlements: null,
    }),
  ),
  http.post(`${HH}/exports`, () => {
    if (wp23.requireStepUp) return problem(403, "mfa_required", "Confirm with 2-step verification first.");
    wp23.exportRequested = true;
    return HttpResponse.json(
      { id: "6d8e000b-0000-4000-8000-000000000001", status: "queued" },
      { status: 202 },
    );
  }),
  http.post(`${HH}/deletion`, () => {
    if (wp23.requireStepUp) return problem(403, "mfa_required", "Confirm with 2-step verification first.");
    wp23.deletionScheduledFor = "2026-11-03T13:00:00Z";
    return HttpResponse.json({ scheduledFor: wp23.deletionScheduledFor }, { status: 202 });
  }),
  http.delete(`${HH}/deletion`, () => {
    wp23.deletionScheduledFor = null;
    return new HttpResponse(null, { status: 204 });
  }),
];
