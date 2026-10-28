import type { Meta, StoryObj } from "@storybook/react-vite";
import fixture from "../../../../../design/fixtures/rivera-household.json";
import { SidebarNav, TabBar } from "./Navigation";
import { SIDEBAR_GROUPS, TABS } from "../testing/nav-items";

function withState(current: string) {
  return SIDEBAR_GROUPS.map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      current: item.href === current,
      ...(item.href === "/tasks"
        ? { count: fixture.expected.tasks.navBadge, countLabel: "3 due this week" }
        : {}),
      ...(item.href === "/imports" ? { count: 4, countLabel: "4 to review" } : {}),
    })),
  }));
}

const meta = {
  title: "Components/Navigation",
  component: SidebarNav,
  args: { groups: withState("/") },
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div style={{ height: "640px", display: "flex" }}>{Story()}</div>],
} satisfies Meta<typeof SidebarNav>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Sidebar: Story = {};
export const SidebarOtherPage: Story = { args: { groups: withState("/imports") } };

export const TabBarPreview: Story = {
  render: () => (
    <div style={{ width: "390px", marginTop: "auto" }}>
      <TabBar items={TABS.map((t) => ({ ...t, current: t.href === "/" }))} />
    </div>
  ),
};

export const TabBarOtherTab: Story = {
  render: () => (
    <div style={{ width: "390px", marginTop: "auto" }}>
      <TabBar items={TABS.map((t) => ({ ...t, current: t.href === "/renewals" }))} />
    </div>
  ),
};
