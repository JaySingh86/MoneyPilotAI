import type { Metadata } from "next";
import { TasksScreen } from "./TasksScreen";

export const metadata: Metadata = { title: "Household tasks" };

export default function TasksPage() {
  return <TasksScreen />;
}
