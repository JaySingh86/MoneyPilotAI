// Plans, features and the entitlement map (BACKEND_PLAN §7.10, DESIGN feature plan §10).
//
// Which feature is Free and which is Family Plus is an open owner decision (BACKEND_PLAN §17 item 5, Q-150),
// so the split is data, not code: `DEFAULT_FEATURE_TIERS` holds the spec's current text and a deployment can
// pass its own `EntitlementConfig`. Nothing outside this file should hard-code "this is a Plus feature".

export const PLANS = ["free", "family_plus"] as const;
export type Plan = (typeof PLANS)[number];

/** Gated capabilities, named after the §7.10 list. Add new ones here and in the default map. */
export const FEATURES = [
  "partnerSharing",
  "goals",
  "reminders",
  "emailConnections",
  "renewalAlerts",
  "unlimitedItems",
] as const;
export type Feature = (typeof FEATURES)[number];

export type Tier = "free" | "plus";

export interface EntitlementConfig {
  /** `plus` features need Family Plus to write; on Free they are read-only. */
  tiers: Readonly<Record<Feature, Tier>>;
  /** How many items a Free household may keep when `unlimitedItems` is Plus. `null`: not decided (Q-151). */
  freeItemLimit: number | null;
}

/** BACKEND_PLAN §7.10: Plus is partner sharing*, unlimited items, goals, reminders, Gmail/Outlook, renewal alerts. */
export const DEFAULT_FEATURE_TIERS: Readonly<Record<Feature, Tier>> = {
  partnerSharing: "plus", // *open decision (§17 item 5)
  goals: "plus",
  reminders: "plus",
  emailConnections: "plus", // open decision (§17 item 5)
  renewalAlerts: "plus",
  unlimitedItems: "plus",
};

export const DEFAULT_ENTITLEMENT_CONFIG: EntitlementConfig = {
  tiers: DEFAULT_FEATURE_TIERS,
  freeItemLimit: null,
};

/** Two adults per household on every plan today (the existing summary contract). */
export const MAX_ADULTS = 2;

export interface FeatureAccess {
  /** Always true: a downgrade never hides data (BACKEND_PLAN §7.10). */
  read: true;
  /** False on a Plus feature while the household is on Free: it is read-only. */
  write: boolean;
}

export interface Entitlements {
  plan: Plan;
  maxAdults: number;
  features: Record<Feature, FeatureAccess>;
  limits: { items: number | null };
}

export function entitlementsForPlan(
  plan: Plan,
  config: EntitlementConfig = DEFAULT_ENTITLEMENT_CONFIG,
): Entitlements {
  const features = {} as Record<Feature, FeatureAccess>;
  for (const feature of FEATURES) {
    features[feature] = { read: true, write: plan === "family_plus" || config.tiers[feature] === "free" };
  }
  const itemsCapped = config.tiers.unlimitedItems === "plus" && plan === "free";
  return {
    plan,
    maxAdults: MAX_ADULTS,
    features,
    limits: { items: itemsCapped ? config.freeItemLimit : null },
  };
}

/** True when `feature` may be created or changed on `plan`. */
export function canWrite(
  plan: Plan,
  feature: Feature,
  config: EntitlementConfig = DEFAULT_ENTITLEMENT_CONFIG,
): boolean {
  return entitlementsForPlan(plan, config).features[feature].write;
}
