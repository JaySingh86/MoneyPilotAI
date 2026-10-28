import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../button/Button";
import { EmptyState, ErrorBanner, Loading, Skeleton, StatusBanner } from "./States";

const meta = {
  title: "Components/States",
  component: EmptyState,
  args: { children: "All caught up. New bills and renewals will appear here as they arrive." },
  decorators: [(Story) => <div style={{ maxWidth: "560px" }}>{Story()}</div>],
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const EmptyWithAction: Story = {
  args: {
    children: "No tasks later this month. Add one, or MoneyPilot will suggest them from renewals.",
    action: (
      <Button variant="secondary" size="compact">
        Add task
      </Button>
    ),
  },
};

export const LoadingSkeleton: Story = {
  render: () => (
    <Loading label="Loading bills before payday" delayMs={0}>
      <Skeleton width="40%" />
      <Skeleton shape="block" />
      <Skeleton width="70%" />
      <Skeleton width="55%" />
    </Loading>
  ),
};

export const LoadingAfterDelay: Story = {
  render: () => (
    <Loading label="Loading your plan">
      <Skeleton shape="block" height="230px" />
    </Loading>
  ),
};

export const ErrorState: Story = {
  render: () => (
    <ErrorBanner title="We couldn’t reach Gmail." onRetry={() => {}}>
      Your plan still shows what we found earlier.
    </ErrorBanner>
  ),
};

export const StatusAfterChange: Story = {
  render: () => (
    <StatusBanner
      action={
        <Button variant="text" size="compact">
          Undo
        </Button>
      }
    >
      Electricity set to $151.37. Safe to spend is now $998.
    </StatusBanner>
  ),
};
