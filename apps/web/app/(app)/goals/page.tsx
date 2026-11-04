import type { Metadata } from "next";
import { GoalsScreen } from "./GoalsScreen";

export const metadata: Metadata = { title: "Goals & planned expenses" };

export default function GoalsPage() {
  return <GoalsScreen />;
}
