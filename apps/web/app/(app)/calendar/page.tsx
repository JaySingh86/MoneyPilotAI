import type { Metadata } from "next";
import { CalendarScreen } from "./CalendarScreen";

export const metadata: Metadata = { title: "Calendar" };

export default function CalendarPage() {
  return <CalendarScreen />;
}
