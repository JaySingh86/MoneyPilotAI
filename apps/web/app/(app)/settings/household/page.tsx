import type { Metadata } from "next";
import { HouseholdScreen } from "./HouseholdScreen";

export const metadata: Metadata = { title: "Members & privacy" };

export default function HouseholdSettingsPage() {
  return <HouseholdScreen />;
}
