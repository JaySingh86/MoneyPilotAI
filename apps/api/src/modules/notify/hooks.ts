// Notification hooks other API modules call inside their own transaction (Q-115, Q-087). They write in-app
// notifications only; the dispatcher in apps/worker emails the person afterwards if their preferences allow.
//
// Copy rules: no amounts anywhere (these also become email subjects), no "pay" wording, and a first name is the
// only user text (stored plain; escaped on output by the email templates and by the web app).
import { sql } from "drizzle-orm";
import { insertNotification, type Tx } from "@mp/db";

interface Who {
  householdId: string;
  /** The signed-in member who did the thing. */
  userId: string;
}

async function firstName(tx: Tx, userId: string): Promise<string> {
  const res = await tx.execute<{ first_name: string }>(
    sql`select first_name from users where id = ${userId}`,
  );
  return res.rows[0]?.first_name ?? "Your partner";
}

/** Every other active member of the household. */
async function otherMembers(tx: Tx, householdId: string, userId: string): Promise<string[]> {
  const res = await tx.execute<{ user_id: string }>(sql`select user_id from household_members
    where household_id = ${householdId} and left_at is null and user_id <> ${userId} order by joined_at`);
  return res.rows.map((r) => r.user_id);
}

/** BACKEND_PLAN §7.3 step 2: the other member gets a `proposal` notification. */
export async function notifyProposalCreated(tx: Tx, who: Who, proposalId: string): Promise<void> {
  const name = await firstName(tx, who.userId);
  for (const recipient of await otherMembers(tx, who.householdId, who.userId)) {
    await insertNotification(tx, {
      householdId: who.householdId,
      userId: recipient,
      kind: "proposal",
      dedupeKey: `proposal.created:${proposalId}:${recipient}`,
      title: `${name} asked you to approve a change`,
      body: "Open MoneyPilot to see what changes, then approve or decline. Nothing happens until you decide.",
      deepLink: "/",
    });
  }
}

export type ProposalOutcome = "approved" | "rejected" | "superseded";

/** The proposer hears how it ended (§7.3, ARCHITECTURE §4.5 "notify Sam" on supersede). */
export async function notifyProposalDecided(
  tx: Tx,
  who: Who,
  proposal: { id: string; proposedBy: string },
  outcome: ProposalOutcome,
): Promise<void> {
  if (proposal.proposedBy === who.userId) return;
  const name = await firstName(tx, who.userId);
  const copy: Record<ProposalOutcome, { title: string; body: string }> = {
    approved: {
      title: `${name} approved your request`,
      body: "The change is in your plan now. Open MoneyPilot to see the updated numbers.",
    },
    rejected: {
      title: `${name} declined your request`,
      body: "Nothing changed. You can talk it over and ask again.",
    },
    superseded: {
      title: "Your request is out of date",
      body: "Your plan changed before it could be approved, so nothing was applied. You can ask again.",
    },
  };
  await insertNotification(tx, {
    householdId: who.householdId,
    userId: proposal.proposedBy,
    kind: "proposal",
    dedupeKey: `proposal.decided:${proposal.id}`,
    title: copy[outcome].title,
    body: copy[outcome].body,
    deepLink: "/",
  });
}
