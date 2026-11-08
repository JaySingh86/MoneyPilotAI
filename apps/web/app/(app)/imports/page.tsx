import type { Metadata } from "next";
import { ImportsScreen } from "./ImportsScreen";

export const metadata: Metadata = { title: "Email & imports" };

export default function ImportsPage() {
  return <ImportsScreen />;
}
