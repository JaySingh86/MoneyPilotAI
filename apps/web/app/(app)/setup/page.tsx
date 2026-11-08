import type { Metadata } from "next";
import { SetupScreen } from "./SetupScreen";

export const metadata: Metadata = { title: "Household setup" };

export default function SetupPage() {
  return <SetupScreen />;
}
