// Labeled METADATA corpus for the prefilter (WP-19 acceptance: precision >= 95%, recall >= 98%).
// Fully synthetic: fictional senders on .example domains, templated subjects, seeded PRNG so it is stable.
// label = "would a household want this message read by the extractor" (bill, statement, renewal, receipt,
// price change, enrollment deadline, payment confirmation).
//
// Limits (see QUESTIONS Q-061): labels are the author's judgement and subjects are synthetic. The numbers
// this corpus gives are a regression gate, not a measurement of real-inbox accuracy.

export interface MetadataSample {
  from: string;
  subject: string;
  labels: string[];
  listId: string | null;
  label: boolean;
  note?: string;
}

export const CORPUS_WATCHED_DOMAINS = [
  "lakeside-auto.example",
  "northgate-home.example",
  "evergreen-life.example",
  "pinecrest-power.example",
  "brightwave.example",
];

export const CORPUS_IGNORED_DOMAINS = ["shopmart-deals.example", "socialgram.example", "bigretail.example"];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const BILLERS = [
  { name: "Sunrise Water", domain: "sunrise-water.example" },
  { name: "Cedar Fiber", domain: "cedarfiber.example" },
  { name: "Harbor Gas", domain: "harbor-gas.example" },
  { name: "Maple Mobile", domain: "maplemobile.example" },
  { name: "Orchard Dental", domain: "orcharddental.example" },
  { name: "Summit Health Plan", domain: "summit-health.example" },
  { name: "Redwood Bank", domain: "redwoodbank.example" },
  { name: "Juniper Storage", domain: "juniper-storage.example" },
  { name: "Atlas Auto Club", domain: "atlas-auto.example" },
  { name: "Willow Childcare", domain: "willowchildcare.example" },
];

const BILL_LOCALS = ["billing", "statements", "no-reply", "noreply", "accounts", "payments", "service"];
const MKT_LOCALS = ["marketing", "offers", "deals", "news", "hello", "team", "promo", "info"];

const POSITIVE_SUBJECTS: ((m: string, n: number, co: string) => string)[] = [
  (m) => `Your ${m} statement is ready`,
  (_m, n) => `Your bill is ready: invoice #${10000 + n}`,
  (_m, n) => `Invoice #${20000 + n} from the billing team`,
  (m) => `Payment due ${m} 15: amount due $43.00`,
  (_m, _n, co) => `Your receipt from ${co}`,
  (m) => `Your policy renews in ${m}`,
  () => `Premium notice for your policy`,
  () => `Action required: your plan will auto-renew`,
  (m) => `Your subscription renews on ${m} 3`,
  (m) => `Open enrollment ends ${m} 30`,
  () => `A price change to your plan is coming`,
  () => `Payment received: thank you`,
  () => `Your annual membership renewal`,
  (m) => `Autopay scheduled for ${m} 10`,
  () => `Heads up: your rate is changing next month`,
  (m) => `${m} billing statement available`,
  () => `Reminder: payment due in 3 days`,
  () => `Fwd: Your statement is ready`,
  () => `Your new premium and renewal date`,
  () => `Your payment confirmation`,
];

const WATCHED_SUBJECTS = [
  "Your update for this month",
  "Important information about your account",
  "A note about your coverage",
  "Your documents are ready",
  "Here is your latest summary",
];

const NEGATIVE_SUBJECTS: ((n: number) => string)[] = [
  (n) => `${20 + (n % 5) * 10}% off everything this weekend`,
  () => `Flash sale: ends tonight`,
  () => `New arrivals you will love`,
  () => `Your weekly digest`,
  () => `Join our webinar on retirement planning`,
  () => `Invitation: team lunch on Friday`,
  () => `Your order has shipped`,
  () => `Verify your email address`,
  () => `Security alert: new sign-in to your account`,
  () => `Newsletter: October edition`,
  () => `Enter our giveaway to win a trip`,
  () => `Introducing our new app`,
  () => `Happy birthday from all of us`,
  () => `Save up to 30% on car insurance: get a quote`,
  () => `Last chance: 20% off premium upgrade`,
  () => `Webinar: understanding your policy options`,
  () => `Exclusive offer just for you`,
  () => `Limited time: free shipping on all orders`,
  () => `You have 3 new connections`,
  () => `Don't miss our biggest sale of the year`,
  () => `Rate your recent visit`,
  () => `We have updated our privacy policy`,
  () => `Your cart is waiting`,
  () => `Weekend deals: coupon inside`,
];

const SOCIAL_SUBJECTS = [
  "Alex commented on your photo",
  "Priya sent you a friend request",
  "You were mentioned in a post",
  "5 people liked your update",
];

export function buildMetadataCorpus(seed = 20261028): MetadataSample[] {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const out: MetadataSample[] = [];

  // Positives from unknown billers (keyword path).
  for (let i = 0; i < 220; i++) {
    const biller = pick(BILLERS);
    out.push({
      from: `"${biller.name}" <${pick(BILL_LOCALS)}@${rnd() < 0.3 ? "mail." : ""}${biller.domain}>`,
      subject: pick(POSITIVE_SUBJECTS)(pick(MONTHS), i, biller.name),
      labels: rnd() < 0.7 ? ["INBOX", "CATEGORY_UPDATES"] : ["INBOX"],
      listId: null,
      label: true,
    });
  }
  // Positives from watched senders with arbitrary subjects (watched-domain path).
  for (let i = 0; i < 90; i++) {
    const d = pick(CORPUS_WATCHED_DOMAINS);
    out.push({
      from: `Notifications <${pick(BILL_LOCALS)}@${rnd() < 0.5 ? "billing." : ""}${d}>`,
      subject: rnd() < 0.5 ? pick(WATCHED_SUBJECTS) : pick(POSITIVE_SUBJECTS)(pick(MONTHS), i, "Company"),
      labels: ["INBOX", "CATEGORY_UPDATES"],
      listId: null,
      label: true,
    });
  }
  // Realistic unavoidable misses; they count against recall on purpose.
  out.push({
    from: "Care Team <service@mystery-co.example>",
    subject: "Important information about your account",
    labels: ["INBOX"],
    listId: null,
    label: true,
    note: "vague subject, unknown sender",
  });
  out.push({
    from: "Cedar Fiber <billing@cedarfiber.example>",
    subject: "Your October statement is ready",
    labels: ["INBOX", "CATEGORY_PROMOTIONS"],
    listId: null,
    label: true,
    note: "bill mis-filed under promotions by the provider",
  });

  // Negatives: marketing from unknown and ignored senders.
  for (let i = 0; i < 230; i++) {
    const biller = pick(BILLERS);
    const ignored = rnd() < 0.2;
    const domain = ignored ? pick(CORPUS_IGNORED_DOMAINS) : biller.domain;
    out.push({
      from: `"${ignored ? "Deals" : biller.name}" <${pick(MKT_LOCALS)}@${domain}>`,
      subject: pick(NEGATIVE_SUBJECTS)(i),
      labels: rnd() < 0.55 ? ["INBOX", "CATEGORY_PROMOTIONS"] : ["INBOX"],
      listId: rnd() < 0.5 ? `<promo.${domain}>` : null,
      label: false,
    });
  }
  // Marketing from WATCHED senders (promotions label): must still be dropped.
  for (let i = 0; i < 40; i++) {
    const d = pick(CORPUS_WATCHED_DOMAINS);
    out.push({
      from: `Offers <${pick(MKT_LOCALS)}@${d}>`,
      subject: pick(NEGATIVE_SUBJECTS)(i),
      labels: ["INBOX", "CATEGORY_PROMOTIONS"],
      listId: `<offers.${d}>`,
      label: false,
      note: "watched sender, promotions label",
    });
  }
  // Social.
  for (let i = 0; i < 40; i++) {
    out.push({
      from: `Socialgram <notify@${rnd() < 0.5 ? "socialgram.example" : "chatter.example"}>`,
      subject: pick(SOCIAL_SUBJECTS),
      labels: ["INBOX", "CATEGORY_SOCIAL"],
      listId: null,
      label: false,
    });
  }
  // Personal mail.
  for (let i = 0; i < 40; i++) {
    out.push({
      from: `Taylor Kim <taylor.kim@mailbox${i % 3}.example>`,
      subject: pick([
        "Dinner on Saturday?",
        "Photos from the trip",
        "Re: soccer carpool",
        "Can you pick up the kids",
        "Fwd: funny video",
      ]),
      labels: ["INBOX"],
      listId: null,
      label: false,
    });
  }
  return out;
}
