// merchant_norm (BACKEND_PLAN §7.7 step 3): lowercase, strip store numbers, dates and reference ids, then map
// through an alias table. The result only contains [a-z0-9 ], so it is safe in any export.

const NOISE_WORDS = new Set([
  "ach",
  "debit",
  "credit",
  "pos",
  "purchase",
  "recurring",
  "autopay",
  "auto",
  "pay",
  "web",
  "online",
  "ppd",
  "ccd",
  "card",
  "checkcard",
  "withdrawal",
  "deposit",
  "id",
  "the",
]);

/** First match wins. Keeps the brand, drops the processor prefix and trailing codes. */
const ALIASES: readonly (readonly [RegExp, string])[] = [
  [/^(netflix|nflx)\b/, "netflix"],
  [/^spotify\b/, "spotify"],
  [/^(amzn|amazon)\b/, "amazon"],
  [/^(apple com|itunes|apple)\b/, "apple"],
  [/^(google|goog)\b/, "google"],
  [/^(sq|tst|pp|paypal)\b/, ""],
];

const REF_PHRASE = /\b(?:ref|reference|conf|confirmation|trace|trn|auth|txn|id)[:#\s-]*[a-z0-9]*\d[a-z0-9]*/g;
const DATE_LIKE = /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g;
const STORE_NO = /(?:#|\bstore\s|\bstr\s|\bno\.?\s)\s*\d+/g;

/** Up to this many words are kept: trailing city or state tokens vary and would split one merchant in two. */
const MAX_WORDS = 4;

export function normalizeMerchant(description: string): string {
  let s = description.toLowerCase();
  s = s.replace(DATE_LIKE, " ").replace(REF_PHRASE, " ").replace(STORE_NO, " ");
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  let words = s
    .split(" ")
    .filter((w) => w !== "" && !NOISE_WORDS.has(w) && !/^\d+$/.test(w) && !/\d{4,}/.test(w));
  let joined = words.join(" ");
  for (const [pattern, brand] of ALIASES) {
    if (pattern.test(joined)) {
      if (brand === "") {
        // A payment-processor prefix (Square, Toast, PayPal): the merchant follows it.
        words = words.slice(1);
        joined = words.join(" ");
        continue;
      }
      return brand;
    }
  }
  const out = words.slice(0, MAX_WORDS).join(" ").slice(0, 60).trim();
  return out === "" ? "unknown" : out;
}

/** A display name made only from the normalized merchant: it never contains imported punctuation. */
export function displayName(merchantNorm: string): string {
  return merchantNorm
    .split(" ")
    .map((w) => (w === "" ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .slice(0, 80);
}
