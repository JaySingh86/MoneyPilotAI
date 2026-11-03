// Matcher test items derived from design/fixtures/rivera-household.json (read-only). Provider domains,
// insurance subtypes and the policy last 4 all come from the fixture (Q-063).
import fixture from "../../../design/fixtures/rivera-household.json" with { type: "json" };

export interface TestItem {
  id: string;
  name: string;
  providerName: string;
  providerDomain: string | null;
  accountLast4: string | null;
  kind: string | null;
  confirmed: boolean;
}

interface FixtureRenewal {
  id: string;
  name: string;
  provider: string;
  category: string;
  providerDomain?: string;
  insuranceType?: string;
  policyLast4?: string;
}

export function riveraRenewalItems(): TestItem[] {
  const renewals = (fixture as unknown as { renewals: FixtureRenewal[] }).renewals;
  return renewals.map((r) => ({
    id: r.id,
    name: r.name,
    providerName: r.provider,
    providerDomain: r.providerDomain ?? null,
    accountLast4: r.policyLast4 ?? null,
    // Same shape as kindOf(): insurance carries its subtype, everything else is the bare category.
    kind: r.category === "insurance" && r.insuranceType ? `insurance:${r.insuranceType}` : r.category,
    confirmed: true,
  }));
}
