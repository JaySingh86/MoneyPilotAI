// Household logic: create, read, patch, summary, invites, leave. Routes are thin; SQL is in repo.ts.
// Authorization is the database's job (RLS): a non-member reads nothing, so every "household not found"
// below is also what a stranger sees. No amounts or emails go into errors, logs or audit metadata.
import { randomBytes, randomUUID } from "node:crypto";
import {
  AppError,
  MAX_ADULTS,
  type AcceptInviteResponse,
  type CreateHouseholdBody,
  type Household,
  type HouseholdSummary,
  type Invite,
  type PatchHouseholdBody,
} from "@mp/contracts";
import type { ApiDb, ApiContext, Tx } from "@mp/db";
import { assertVersion } from "../../lib/if-match";
import type { InviteSender } from "../../auth/runtime";
import { recordAudit, type RequestMeta } from "../identity/audit";
import { isUniqueViolation, pgErrorOf, INSUFFICIENT_PRIVILEGE } from "../identity/db-errors";
import * as repo from "./repo";

export interface CallerContext {
  userId: string;
  authSubject: string;
}

/**
 * Hooks that other modules fill in as they land. Leaving a household reassigns the leaver's items to the
 * remaining member and revokes their email connection (BACKEND_PLAN §6); both are stubbed until WP-06
 * (items) and WP-21 (email connections) exist. Hooks run inside the leave transaction.
 */
export interface LeaveHooks {
  reassignOwnedItems(
    tx: Tx,
    input: { householdId: string; fromUserId: string; toUserId: string },
  ): Promise<void>;
  revokeEmailConnections(tx: Tx, input: { householdId: string; userId: string }): Promise<void>;
}

export const noopLeaveHooks: LeaveHooks = {
  async reassignOwnedItems() {},
  async revokeEmailConnections() {},
};

/** Invites one user may create per rolling 24 hours (BACKEND_PLAN §6). */
export const DAILY_INVITE_LIMIT = 5;

const ALREADY_IN_HOUSEHOLD = "You already belong to a household. Leave it first.";
const ONE_ACTIVE_INDEX = "household_members_one_active_uq";

/** HTML-escapes user-controlled text handed to the invite sender (names are untrusted display text). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const FORWARDING_TOKEN_ATTEMPTS = 6;

/** `rivera-7k2`: a slug of the household name plus 3 random base32 characters (BACKEND_PLAN §6). */
export function forwardingToken(name: string, random: Buffer = randomBytes(3)): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  const suffix = Array.from(random.subarray(0, 3), (b) => BASE32[b % 32]).join("");
  return `${slug === "" ? "household" : slug}-${suffix}`;
}

function toHousehold(row: repo.HouseholdRow): Household {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    currency: row.currency,
    cushionCents: row.cushionCents,
    primaryIncomeItemId: row.primaryIncomeItemId,
    plan: row.plan,
    forwardingToken: row.forwardingToken,
    deletionScheduledFor: row.deletionScheduledFor?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toInvite(row: repo.InviteRow): Invite {
  return {
    id: row.id,
    email: row.email,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

const notFound = () => new AppError("not_found", 404, "Household not found.");

/** The reasons `app_accept_invite` raises (errcode 42501, message = reason) mapped to problems. */
function inviteProblem(reason: string, maskedEmail?: string | null): AppError {
  switch (reason) {
    case "invite_not_found":
      return new AppError("not_found", 404, "This invitation was not found.");
    case "invite_expired":
      return new AppError("conflict", 409, "This invitation has expired. Ask for a new one.");
    case "invite_revoked":
      return new AppError("conflict", 409, "This invitation was cancelled. Ask for a new one.");
    case "invite_accepted":
      return new AppError("conflict", 409, "This invitation was already used.");
    case "invite_mismatch":
      return new AppError(
        "forbidden",
        403,
        maskedEmail
          ? `This invitation was sent to ${maskedEmail}. Sign in with that email address to accept it.`
          : "This invitation was sent to a different email address. Sign in with that address to accept it.",
      );
    case "invite_already_member":
      return new AppError("conflict", 409, "You are already in this household.");
    case "invite_household_full":
      return new AppError("conflict", 409, "This household already has two adults.");
    case "invite_household_deleting":
      return new AppError("conflict", 409, "This household is scheduled for deletion.");
    default:
      return new AppError("forbidden", 403, "This invitation cannot be accepted.");
  }
}

export class HouseholdService {
  constructor(
    private readonly db: ApiDb,
    private readonly inviteSender: InviteSender,
    private readonly hooks: LeaveHooks = noopLeaveHooks,
  ) {}

  private ctx(caller: CallerContext, householdId: string | null): ApiContext {
    return { userId: caller.userId, authSubject: caller.authSubject, householdId };
  }

  async create(caller: CallerContext, body: CreateHouseholdBody, meta: RequestMeta): Promise<Household> {
    for (let attempt = 1; attempt <= FORWARDING_TOKEN_ATTEMPTS; attempt++) {
      const id = randomUUID();
      try {
        return await this.db.withHouseholdTx(this.ctx(caller, id), async (tx) => {
          if (await repo.hasActiveMembership(tx, caller.userId)) {
            throw new AppError("conflict", 409, ALREADY_IN_HOUSEHOLD);
          }
          const timezone = body.timezone ?? (await repo.findUserTimezone(tx, caller.userId));
          if (!timezone) throw new AppError("not_found", 404, "Account not found.");
          await repo.insertHousehold(tx, {
            id,
            name: body.name,
            timezone,
            cushionCents: body.cushionCents,
            forwardingToken: forwardingToken(body.name),
            createdBy: caller.userId,
          });
          await repo.insertCreatorMember(tx, id, caller.userId);
          await recordAudit(tx, {
            householdId: id,
            actorUserId: caller.userId,
            action: "household.created",
            entityType: "household",
            entityId: id,
            meta,
          });
          const created = await repo.getHousehold(tx, id);
          if (!created) throw new AppError("internal_error", 500, "Could not create the household.");
          return toHousehold(created);
        });
      } catch (err) {
        // Two concurrent creates by one user: the unique index lets only one win.
        if (isUniqueViolation(err, ONE_ACTIVE_INDEX))
          throw new AppError("conflict", 409, ALREADY_IN_HOUSEHOLD);
        // A forwarding-token collision (rare): retry with a new random suffix.
        if (
          isUniqueViolation(err, "households_forwarding_token_key") &&
          attempt < FORWARDING_TOKEN_ATTEMPTS
        ) {
          continue;
        }
        throw err;
      }
    }
    throw new AppError("internal_error", 500, "Could not create the household.");
  }

  async get(caller: CallerContext, householdId: string): Promise<Household> {
    return this.db.withHouseholdTx(this.ctx(caller, householdId), async (tx) => {
      const row = await repo.getHousehold(tx, householdId);
      if (!row) throw notFound();
      return toHousehold(row);
    });
  }

  /** `expected` is the version the client edited (If-Match). A stale version is 409 with the current row. */
  async patch(
    caller: CallerContext,
    householdId: string,
    expected: number,
    patch: PatchHouseholdBody,
    meta: RequestMeta,
  ): Promise<Household> {
    return this.db.withHouseholdTx(this.ctx(caller, householdId), async (tx) => {
      const current = await repo.getHousehold(tx, householdId);
      if (!current) throw notFound();
      assertVersion(expected, toHousehold(current));
      if (
        patch.primaryIncomeItemId !== undefined &&
        !(await repo.isLiveIncomeItem(tx, householdId, patch.primaryIncomeItemId))
      ) {
        throw new AppError("validation_failed", 400, "The request has invalid fields.", {
          fields: [
            {
              in: "body",
              path: "primaryIncomeItemId",
              message: "Choose an income item that belongs to this household",
            },
          ],
        });
      }
      const updated = await repo.updateHousehold(tx, householdId, expected, patch);
      if (!updated) {
        // Lost a race between the read and the update: report the latest row.
        const latest = await repo.getHousehold(tx, householdId);
        if (!latest) throw notFound();
        assertVersion(expected, toHousehold(latest));
        throw new AppError("conflict", 409, "This was changed by someone else. Review the latest version.");
      }
      await recordAudit(tx, {
        householdId,
        actorUserId: caller.userId,
        action: "household.updated",
        entityType: "household",
        entityId: householdId,
        metadata: { fields: Object.keys(patch) },
        meta,
      });
      return toHousehold(updated);
    });
  }

  async summary(caller: CallerContext, householdId: string): Promise<HouseholdSummary> {
    return this.db.withHouseholdTx(this.ctx(caller, householdId), async (tx) => {
      const household = await repo.getHousehold(tx, householdId);
      if (!household) throw notFound();
      const members = await repo.listActiveMembers(tx, householdId);
      const open = await repo.findOpenInvite(tx, householdId);
      return {
        household: toHousehold(household),
        members: members.map((m) => ({
          userId: m.userId,
          firstName: m.firstName,
          lastName: m.lastName,
          colorRole: m.colorRole,
          isCreator: m.isCreator,
          joinedAt: m.joinedAt.toISOString(),
        })),
        openInvite: open ? toInvite(open) : null,
        // Stubbed until the review queue, tasks and proposals modules land.
        badges: { reviewQueue: 0, tasksDue: 0, proposalsPending: 0 },
        entitlements: { plan: household.plan, maxAdults: MAX_ADULTS },
        // Stubbed until WP-21 (email connections).
        connections: { emailConnections: 0 },
      };
    });
  }

  // ===== Invites =====

  async createInvite(
    caller: CallerContext,
    householdId: string,
    rawEmail: string,
    meta: RequestMeta,
  ): Promise<Invite> {
    const email = rawEmail.trim().toLowerCase();
    const token = randomBytes(32).toString("base64url");
    const created = await this.db.withHouseholdTx(this.ctx(caller, householdId), async (tx) => {
      const household = await repo.getHousehold(tx, householdId);
      if (!household) throw notFound();
      if (household.deletionScheduledFor) {
        throw new AppError("conflict", 409, "This household is scheduled for deletion.");
      }
      await repo.lockInvites(tx, householdId);
      const members = await repo.listActiveMembers(tx, householdId);
      if (members.length >= MAX_ADULTS) {
        throw new AppError("conflict", 409, "This household already has two adults.");
      }
      if (members.some((m) => m.email.toLowerCase() === email)) {
        throw new AppError("conflict", 409, "That person is already in this household.");
      }
      if ((await repo.countRecentInvitesBy(tx, caller.userId)) >= DAILY_INVITE_LIMIT) {
        throw new AppError(
          "rate_limited",
          429,
          "You have sent the most invitations allowed today. Try again tomorrow.",
          {
            headers: { "retry-after": "3600" },
          },
        );
      }
      await repo.revokeExpiredInvites(tx, householdId);
      if (await repo.findOpenInvite(tx, householdId)) {
        throw new AppError("conflict", 409, "An invitation is already pending. Cancel it to send a new one.");
      }
      const invite = await repo.insertInvite(tx, {
        id: randomUUID(),
        householdId,
        email,
        tokenHash: repo.hashInviteToken(token),
        invitedBy: caller.userId,
      });
      await recordAudit(tx, {
        householdId,
        actorUserId: caller.userId,
        action: "invite.created",
        entityType: "invite",
        entityId: invite.id,
        meta,
      });
      const inviterFirstName = (await repo.findUserFirstName(tx, caller.userId)) ?? "A partner";
      return { invite, householdName: household.name, inviterFirstName };
    });

    try {
      await this.inviteSender.send({
        to: created.invite.email,
        token,
        householdName: escapeHtml(created.householdName),
        inviterFirstName: escapeHtml(created.inviterFirstName),
        expiresAt: created.invite.expiresAt,
      });
    } catch (err) {
      // Do not leave an unsendable invite blocking the next attempt.
      await this.db
        .withHouseholdTx(this.ctx(caller, householdId), (tx) =>
          repo.revokeInvite(tx, householdId, created.invite.id),
        )
        .catch(() => undefined);
      throw new AppError("internal_error", 502, "We could not send the invitation email. Try again.", {
        cause: err,
      });
    }
    return toInvite(created.invite);
  }

  async revokeInvite(
    caller: CallerContext,
    householdId: string,
    inviteId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.db.withHouseholdTx(this.ctx(caller, householdId), async (tx) => {
      if (!(await repo.getHousehold(tx, householdId))) throw notFound();
      const outcome = await repo.revokeInvite(tx, householdId, inviteId);
      if (outcome === "missing") throw new AppError("not_found", 404, "Invitation not found.");
      if (outcome === "accepted")
        throw new AppError("conflict", 409, "This invitation was already accepted.");
      await recordAudit(tx, {
        householdId,
        actorUserId: caller.userId,
        action: "invite.revoked",
        entityType: "invite",
        entityId: inviteId,
        meta,
      });
    });
  }

  /**
   * Accept by token. Lookup first (`app_invite_lookup`) so a signed-in user with the wrong email learns which
   * address to sign in with (masked); then `app_accept_invite`, which re-checks everything atomically and writes
   * the membership and the `invite.accepted` audit event.
   */
  async acceptInvite(caller: CallerContext, token: string): Promise<AcceptInviteResponse> {
    const tokenHash = repo.hashInviteToken(token);
    return this.db.withHouseholdTx(this.ctx(caller, null), async (tx) => {
      const lookup = await repo.lookupInvite(tx, tokenHash);
      if (!lookup) throw inviteProblem("invite_not_found");
      switch (lookup.status) {
        case "accepted":
          throw inviteProblem("invite_accepted");
        case "revoked":
          throw inviteProblem("invite_revoked");
        case "expired":
          throw inviteProblem("invite_expired");
        case "mismatch":
          throw inviteProblem("invite_mismatch", lookup.maskedEmail);
        case "valid":
          break;
      }
      if (await repo.hasActiveMembership(tx, caller.userId)) {
        throw new AppError("conflict", 409, ALREADY_IN_HOUSEHOLD);
      }
      try {
        return { householdId: await repo.acceptInvite(tx, tokenHash) };
      } catch (err) {
        if (isUniqueViolation(err, ONE_ACTIVE_INDEX))
          throw new AppError("conflict", 409, ALREADY_IN_HOUSEHOLD);
        const pg = pgErrorOf(err);
        if (pg?.code === INSUFFICIENT_PRIVILEGE && pg.message?.startsWith("invite_")) {
          throw inviteProblem(pg.message);
        }
        throw err;
      }
    });
  }

  // ===== Leave =====

  async leave(caller: CallerContext, householdId: string, meta: RequestMeta): Promise<void> {
    await this.db.withHouseholdTx(this.ctx(caller, householdId), async (tx) => {
      const members = await repo.listActiveMembers(tx, householdId);
      if (!members.some((m) => m.userId === caller.userId)) throw notFound();
      const remaining = members.filter((m) => m.userId !== caller.userId);
      const successor = remaining[0];
      if (!successor) {
        throw new AppError("conflict", 409, "You are the only member. Delete the household instead.");
      }
      await this.hooks.reassignOwnedItems(tx, {
        householdId,
        fromUserId: caller.userId,
        toUserId: successor.userId,
      });
      await this.hooks.revokeEmailConnections(tx, { householdId, userId: caller.userId });
      // Their pending invites would otherwise stay usable after they are gone; the creator role passes
      // to the remaining member. Both need current membership, so they run before it ends.
      await repo.revokePendingInvitesBy(tx, householdId, caller.userId);
      await repo.transferCreator(tx, householdId);
      // Before ending the membership: the audit insert policy needs the actor to still be a member.
      await recordAudit(tx, {
        householdId,
        actorUserId: caller.userId,
        action: "member.left",
        entityType: "household",
        entityId: householdId,
        meta,
      });
      if (!(await repo.endMembership(tx, householdId, caller.userId))) throw notFound();
    });
  }
}
