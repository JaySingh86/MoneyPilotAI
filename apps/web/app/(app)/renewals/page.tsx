import type { Metadata } from "next";
import { RenewalsScreen } from "./RenewalsScreen";

export const metadata: Metadata = { title: "Subscriptions & renewals" };

export default function RenewalsPage() {
  return <RenewalsScreen />;
}
