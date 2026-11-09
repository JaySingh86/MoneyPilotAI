// The fixture inbox corpus (WP-22 acceptance): seven synthetic messages for the Rivera household, with the extraction a
// correct model would return for each. Fictional companies only (every domain ends in `.example`). Tests only: it is
// used with the fake mailbox and the fake model transport, so nothing here touches a network or a real inbox.
//
// What the corpus produces on the Email & imports board (DESIGN_SPEC §5.1, canvas): the board's 4 items to review plus the
// streaming price rise (rule 14, Q-238), and 3 changes applied automatically.
//
//   to review                                           why a person looks first
//   1 renters renewal, price up ($149 to $168)          a price increase is a decision
//   2 electricity statement, $151.37                    first message from this sender for the bill
//   3 health plan, benefit election deadline            a decision, not an update
//   4 antivirus renewal                                 a new item
//   5 streaming price rise, $19.99 to $22.99            a price change never auto-applies (rule 14)
//   applied automatically                               the household has seen the sender before
//   5 internet bill, same amount and date as expected   identical notice
//   6 car insurance, same premium and date              identical notice
//   7 water and trash, same amount and date             identical notice
//
// The extraction for each message is what the fake model returns; its quotes are copied from the body, so they pass
// the verbatim-evidence rule against the REDACTED text (a policy number appears there in its masked form).
import type { ExtractionResult } from "@mp/ai/extract";
import { buildEmail } from "@mp/email/testing";

export interface InboxMessage {
  key: string;
  providerMessageId: string;
  /** UTC instant. */
  receivedAt: string;
  from: string;
  subject: string;
  /** RFC 822 bytes the fake mailbox serves for it. */
  raw: string;
  /** A phrase that appears only in this message's body: the fake model answers by it. */
  marker: string;
  extraction: ExtractionResult;
}

/** Nothing in any message body is meant to be stored anywhere; every body carries this so tests can look for it. */
export const BODY_SENTINEL = "zq-unique-body-sentinel";

const authResults = (domain: string): string =>
  `mx.google.com; spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=${domain}`;

const blank: ExtractionResult = {
  doc_type: "irrelevant",
  provider_name: null,
  category: null,
  insurance_type: null,
  amount_due_cents: null,
  previous_amount_cents: null,
  due_date: null,
  renewal_date: null,
  cancel_by_date: null,
  decision_by_date: null,
  frequency: null,
  auto_renews: null,
  account_last4: null,
  evidence: [],
};

function message(input: {
  key: string;
  domain: string;
  fromName: string;
  subject: string;
  receivedAt: string;
  text: string;
  marker: string;
  extraction: Partial<ExtractionResult>;
  /** Leave the receiver's Authentication-Results header out (an unauthenticated sender). */
  noAuth?: boolean;
}): InboxMessage {
  return {
    key: input.key,
    providerMessageId: `fx-${input.key}`,
    receivedAt: input.receivedAt,
    from: `${input.fromName} <billing@${input.domain}>`,
    subject: input.subject,
    marker: input.marker,
    raw: buildEmail({
      from: `${input.fromName} <billing@${input.domain}>`,
      subject: input.subject,
      text: `${input.text}\n\n${BODY_SENTINEL}\n`,
      ...(input.noAuth ? {} : { headers: { "Authentication-Results": authResults(input.domain) } }),
    }),
    extraction: { ...blank, ...input.extraction },
  };
}

export const RENTERS = message({
  key: "renters",
  domain: "northgate-home.example",
  fromName: "Northgate Home Insurance",
  subject: "Your renewal offer for policy 5530194821",
  receivedAt: "2026-10-24T14:02:00Z",
  marker: "Northgate Home Insurance renewal offer",
  text:
    "Northgate Home Insurance renewal offer\n\nHello Sam,\nYour renters insurance renews on January 9, 2027.\n" +
    "New premium: $168.00 per year (was $149.00).\nPolicy 5530194821.\n",
  extraction: {
    doc_type: "renewal_notice",
    provider_name: "Northgate Home Insurance",
    category: "insurance",
    insurance_type: "renters",
    amount_due_cents: 16800,
    previous_amount_cents: 14900,
    renewal_date: "2027-01-09",
    frequency: "yearly",
    account_last4: "4821",
    evidence: [
      { field: "amount_due_cents", quote: "New premium: $168.00 per year" },
      { field: "previous_amount_cents", quote: "was $149.00" },
      { field: "renewal_date", quote: "renews on January 9, 2027" },
      { field: "frequency", quote: "per year" },
    ],
  },
});

export const ELECTRICITY = message({
  key: "electricity",
  domain: "citypowerlight.example",
  fromName: "City Power & Light",
  subject: "Your October statement is ready",
  receivedAt: "2026-10-26T13:10:00Z",
  marker: "City Power & Light statement",
  text:
    "City Power & Light statement\n\nYour October statement is ready.\nAmount due: $151.37\nDue date: 11/03/2026\n" +
    "Account ending 0937\n",
  extraction: {
    doc_type: "statement",
    provider_name: "City Power & Light",
    category: "utilities",
    amount_due_cents: 15137,
    due_date: "2026-11-03",
    account_last4: "0937",
    evidence: [
      { field: "amount_due_cents", quote: "Amount due: $151.37" },
      { field: "due_date", quote: "Due date: 11/03/2026" },
    ],
  },
});

export const HEALTH = message({
  key: "health",
  domain: "benefits-portal.example",
  fromName: "Benefits Portal",
  subject: "Make your 2027 benefit elections by Nov 13",
  receivedAt: "2026-10-22T15:30:00Z",
  marker: "Health plan benefits open enrollment",
  text:
    "Health plan benefits open enrollment\n\nMake your 2027 benefit elections by November 13, 2026.\n" +
    "Your current plan costs $248.00 per month and rolls over if you pick nothing.\n",
  extraction: {
    doc_type: "enrollment_deadline",
    provider_name: "Health plan benefits",
    category: "insurance",
    insurance_type: "health",
    amount_due_cents: 24800,
    decision_by_date: "2026-11-13",
    frequency: "monthly",
    evidence: [
      { field: "amount_due_cents", quote: "Your current plan costs $248.00 per month" },
      { field: "decision_by_date", quote: "elections by November 13, 2026" },
      { field: "frequency", quote: "per month" },
    ],
  },
});

export const ANTIVIRUS = message({
  key: "antivirus",
  domain: "antivirus-billing.example",
  fromName: "Antivirus Billing",
  subject: "Your subscription renews on Dec 1",
  receivedAt: "2026-10-25T16:45:00Z",
  marker: "Antivirus subscription renewal",
  text:
    "Antivirus subscription renewal\n\nYour Antivirus subscription renews automatically on December 1, 2026.\n" +
    "Price: $49.99 per year.\n",
  extraction: {
    doc_type: "renewal_notice",
    provider_name: "Antivirus",
    category: "subscription",
    amount_due_cents: 4999,
    renewal_date: "2026-12-01",
    frequency: "yearly",
    auto_renews: true,
    evidence: [
      { field: "amount_due_cents", quote: "Price: $49.99 per year" },
      { field: "renewal_date", quote: "renews automatically on December 1, 2026" },
      { field: "frequency", quote: "per year" },
      { field: "auto_renews", quote: "renews automatically" },
    ],
  },
});

export const INTERNET = message({
  key: "internet",
  domain: "metrointernet.example",
  fromName: "Metro Internet",
  subject: "Your bill is ready",
  receivedAt: "2026-10-21T13:00:00Z",
  marker: "Metro Internet monthly bill",
  text: "Metro Internet monthly bill\n\nAmount due: $70.00\nDue date: November 5, 2026\n",
  extraction: {
    doc_type: "bill",
    provider_name: "Metro Internet",
    category: "utilities",
    amount_due_cents: 7000,
    due_date: "2026-11-05",
    evidence: [
      { field: "amount_due_cents", quote: "Amount due: $70.00" },
      { field: "due_date", quote: "Due date: November 5, 2026" },
    ],
  },
});

export const CAR_INSURANCE = message({
  key: "car-insurance",
  domain: "lakeside-auto.example",
  fromName: "Lakeside Auto Insurance",
  subject: "Your auto policy renews on November 4, 2026",
  receivedAt: "2026-10-20T13:00:00Z",
  marker: "Lakeside Auto Insurance auto policy",
  text: "Lakeside Auto Insurance auto policy\n\nPremium due: $684.00\nPayment due: November 4, 2026\nPolicy ending 4410\n",
  extraction: {
    doc_type: "renewal_notice",
    provider_name: "Lakeside Auto Insurance",
    category: "insurance",
    insurance_type: "auto",
    amount_due_cents: 68400,
    due_date: "2026-11-04",
    account_last4: "4410",
    evidence: [
      { field: "amount_due_cents", quote: "Premium due: $684.00" },
      { field: "due_date", quote: "Payment due: November 4, 2026" },
    ],
  },
});

export const WATER = message({
  key: "water",
  domain: "lakeviewwater.example",
  fromName: "Lakeview Water",
  subject: "Your water and trash bill",
  receivedAt: "2026-10-23T13:00:00Z",
  marker: "Lakeview Water and trash bill",
  text: "Lakeview Water and trash bill\n\nAmount due: $96.00\nDue date: November 18, 2026\n",
  extraction: {
    doc_type: "bill",
    provider_name: "Lakeview Water",
    category: "utilities",
    amount_due_cents: 9600,
    due_date: "2026-11-18",
    evidence: [
      { field: "amount_due_cents", quote: "Amount due: $96.00" },
      { field: "due_date", quote: "Due date: November 18, 2026" },
    ],
  },
});

/** The streaming bundle announces a price rise, $19.99 to $22.99 (a monthly subscription: Q-134 reminder; rule 14: never applied). */
export const STREAMING_PRICE_CHANGE = message({
  key: "streaming",
  domain: "streamingbundle.example",
  fromName: "Streaming Bundle",
  subject: "Your plan price is changing",
  receivedAt: "2026-10-26T10:00:00Z",
  marker: "Streaming Bundle price change",
  text: "Streaming Bundle price change\n\nStreaming Bundle plan price: your new price is $22.99 per month, up from $19.99.\n",
  extraction: {
    doc_type: "price_change",
    provider_name: "Streaming Bundle",
    category: "subscription",
    amount_due_cents: 2299,
    previous_amount_cents: 1999,
    frequency: "monthly",
    evidence: [
      { field: "amount_due_cents", quote: "your new price is $22.99 per month" },
      { field: "previous_amount_cents", quote: "up from $19.99" },
      { field: "frequency", quote: "per month" },
    ],
  },
});

/**
 * The Email & imports board's messages: five to review (the board's four, plus the streaming price rise, which DESIGN_SPEC §6
 * rule 14 keeps out of auto-apply, Q-238) and three applied automatically (Internet and the car insurance as on the board,
 * water and trash in place of the streaming row).
 */
export const BOARD_INBOX: readonly InboxMessage[] = [
  RENTERS,
  ELECTRICITY,
  HEALTH,
  ANTIVIRUS,
  INTERNET,
  CAR_INSURANCE,
  WATER,
  STREAMING_PRICE_CHANGE,
];

/** The provider facts the household's items carry in this corpus (the fixture has them for the renewals only). */
export const ITEM_FACTS: Readonly<Record<string, { domain: string; name: string; last4?: string }>> = {
  "r-renters": { domain: "northgate-home.example", name: "Northgate Home Insurance", last4: "4821" },
  "b-power": { domain: "citypowerlight.example", name: "City Power & Light", last4: "0937" },
  "r-health": { domain: "benefits-portal.example", name: "Health plan benefits" },
  "b-internet": { domain: "metrointernet.example", name: "Metro Internet" },
  "b-carins": { domain: "lakeside-auto.example", name: "Lakeside Auto Insurance", last4: "4410" },
  "r-moto": { domain: "lakeside-auto.example", name: "Lakeside Auto Insurance" },
  "b-water": { domain: "lakeviewwater.example", name: "Lakeview Water" },
  "b-stream": { domain: "streamingbundle.example", name: "Streaming Bundle" },
};

/** The items the household has already had an applied change from, by sender (so the sender is not first-seen). */
export const TRUSTED_SENDERS: Readonly<Record<string, string>> = {
  "b-internet": "metrointernet.example",
  "b-carins": "lakeside-auto.example",
  "b-water": "lakeviewwater.example",
};
