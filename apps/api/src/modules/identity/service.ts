// Identity logic: bootstrap from verified claims, the profile. Routes are thin; SQL is in repo.ts.
import { AppError, type BootstrapBody, type Me, type PatchMeBody } from "@mp/contracts";
import type { ApiDb } from "@mp/db";
import type { AuthUser } from "../../auth/provider";
import { recordAudit, type RequestMeta } from "./audit";
import { isUniqueViolation } from "./db-errors";
import * as repo from "./repo";

const DEFAULT_TIMEZONE = "America/New_York";

function toMe(user: repo.UserRow, memberships: repo.MembershipRow[]): Me {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    timezone: user.timezone,
    mfaEnabled: user.mfaEnabled,
    createdAt: user.createdAt.toISOString(),
    memberships: memberships.map((m) => ({
      householdId: m.householdId,
      householdName: m.householdName,
      colorRole: m.colorRole,
      isCreator: m.isCreator,
      joinedAt: m.joinedAt.toISOString(),
    })),
  };
}

export class IdentityService {
  constructor(private readonly db: ApiDb) {}

  /**
   * Creates the caller's `users` row on first call and syncs email and MFA from the verified token on
   * every call (ADR-017). The email comes only from `identity`, which is built from verified claims; the
   * request body has no email field. Refuses unless the token's `email_verified` claim is true.
   */
  async bootstrap(identity: AuthUser, body: BootstrapBody, meta: RequestMeta): Promise<Me> {
    if (!identity.emailVerified || identity.email === null) {
      throw new AppError("forbidden", 403, "Verify your email address, then sign in again.");
    }
    const email = identity.email;

    const result = await this.db
      .withHouseholdTx({ userId: null, authSubject: identity.subject }, async (tx) => {
        let user = await repo.findUserBySubject(tx, identity.subject);
        let created = false;
        if (user?.deletedAt) throw new AppError("unauthorized", 401, "This account has been deleted.");
        if (!user) {
          if (body.firstName === undefined) {
            throw new AppError("validation_failed", 400, "Tell us your first name to finish setting up.", {
              fields: [{ in: "body", path: "firstName", message: "Required the first time" }],
            });
          }
          const inserted = await repo.insertUser(tx, {
            authSubject: identity.subject,
            email,
            firstName: body.firstName,
            lastName: body.lastName ?? null,
            timezone: body.timezone ?? DEFAULT_TIMEZONE,
          });
          // A concurrent bootstrap for the same subject may have won; then read its row.
          user = inserted ?? (await repo.findUserBySubject(tx, identity.subject));
          created = inserted !== undefined;
        }
        if (!user) throw new AppError("internal_error", 500, "Could not set up the account.");
        // Mirror the verified email and MFA flag. The database refuses any other subject.
        await repo.syncAuthUser(tx, identity.subject, email, identity.mfaEnabled);
        const fresh = await repo.findUserBySubject(tx, identity.subject);
        if (!fresh) throw new AppError("internal_error", 500, "Could not set up the account.");
        return { user: fresh, created };
      })
      .catch((err: unknown) => {
        if (isUniqueViolation(err, "users_email_key")) {
          throw new AppError("conflict", 409, "An account with this email address already exists.");
        }
        throw err;
      });

    // The audit policy needs app.user_id, which only exists once the row is committed.
    const profile = await this.db.withHouseholdTx(
      { userId: result.user.id, authSubject: identity.subject },
      async (tx) => {
        if (result.created) {
          await recordAudit(tx, {
            householdId: null,
            actorUserId: result.user.id,
            action: "user.created",
            entityType: "user",
            entityId: result.user.id,
            meta,
          });
        }
        return toMe(result.user, await repo.listMemberships(tx, result.user.id));
      },
    );
    return profile;
  }

  async getMe(userId: string, authSubject: string): Promise<Me> {
    return this.db.withHouseholdTx({ userId, authSubject }, async (tx) => {
      const user = await repo.findUserById(tx, userId);
      if (!user || user.deletedAt) throw new AppError("not_found", 404, "Account not found.");
      return toMe(user, await repo.listMemberships(tx, userId));
    });
  }

  async patchMe(userId: string, authSubject: string, patch: PatchMeBody, meta: RequestMeta): Promise<Me> {
    return this.db.withHouseholdTx({ userId, authSubject }, async (tx) => {
      const user = await repo.updateProfile(tx, userId, patch);
      if (!user) throw new AppError("not_found", 404, "Account not found.");
      await recordAudit(tx, {
        householdId: null,
        actorUserId: userId,
        action: "user.updated",
        entityType: "user",
        entityId: userId,
        metadata: { fields: Object.keys(patch) },
        meta,
      });
      return toMe(user, await repo.listMemberships(tx, userId));
    });
  }
}
