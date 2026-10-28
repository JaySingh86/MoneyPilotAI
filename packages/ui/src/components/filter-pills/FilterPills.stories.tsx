import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { FilterPills } from "./FilterPills";

type Category = "all" | "insurance" | "subscriptions" | "memberships" | "vehicle";
// Renewals category counts for the fixture household: 9 renewals plus 7 monthly subscriptions.
const CATEGORIES = [
  { value: "all", label: "All", count: 16 },
  { value: "insurance", label: "Insurance", count: 5 },
  { value: "subscriptions", label: "Subscriptions", count: 8 },
  { value: "memberships", label: "Memberships", count: 2 },
  { value: "vehicle", label: "Vehicle & home", count: 1 },
] as const;

function Demo({ initial = "all", withCounts = true }: { initial?: Category; withCounts?: boolean }) {
  const [value, setValue] = useState<Category>(initial);
  const options = withCounts ? CATEGORIES : CATEGORIES.map(({ value: v, label }) => ({ value: v, label }));
  return <FilterPills label="Category" options={options} value={value} onChange={setValue} />;
}

const meta = {
  title: "Components/FilterPills",
  component: Demo,
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const OtherSelected: Story = { args: { initial: "insurance" } };
export const WithoutCounts: Story = { args: { withCounts: false } };
