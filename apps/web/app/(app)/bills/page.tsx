import type { Metadata } from "next";
import { BillsScreen } from "./BillsScreen";

export const metadata: Metadata = { title: "Bills & recurring" };

export default function BillsPage() {
  return <BillsScreen />;
}
