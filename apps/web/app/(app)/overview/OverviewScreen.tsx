"use client";

import { Button, ErrorBanner, IconButton, Loading, Skeleton } from "@mp/ui";
import { Bell, Plus, Search, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { usePlan, useSummary } from "../../../lib/api/hooks";
import type { PlanResponse } from "../../../lib/api/planning-types";
import { PageHeader } from "../../../lib/components/PageHeader";
import { overlineDate, longWeekdayShortDate, shortDateWithYear } from "../../../lib/format/dates";
import { useOwners } from "../../../lib/owners";
import type { Owners } from "../../../lib/owners";
import { CoverTheGap } from "./Cover";
import { Decisions } from "./Decisions";
import type { DrawerFocus } from "./Decisions";
import { DueTable } from "./DueTable";
import { BillsTile, Hero, IncomeTile } from "./Kpis";
import { MathDrawer } from "./MathDrawer";
import { Runway } from "./Runway";
import { Goals, Tasks } from "./Side";
import styles from "./overview.module.css";

function headerTitle(days: number): string {
  if (days === 0) return "Payday is today. Here’s the plan.";
  return `${days} ${days === 1 ? "day" : "days"} to payday. Here’s the plan.`;
}

function Skeletons() {
  return (
    <Loading label="Loading your plan">
      <Skeleton shape="block" height="160px" />
      <Skeleton shape="block" height="320px" />
      <Skeleton shape="block" height="240px" />
    </Loading>
  );
}

export function OverviewScreen() {
  const plan = usePlan();
  const summary = useSummary();
  const owners = useOwners();
  const [drawer, setDrawer] = useState<DrawerFocus | null>(null);

  const failed = plan.isError || summary.isError;
  const retry = () => {
    void plan.refetch();
    void summary.refetch();
  };
  if (!plan.data || !owners) {
    // Nothing cached yet: say that nothing is shown.
    return (
      <>
        <PageHeader overline="Overview" title="Here’s the plan." />
        {failed ? (
          <ErrorBanner title="We couldn’t load your plan." onRetry={retry}>
            Nothing was changed. No numbers are shown until it loads.
          </ErrorBanner>
        ) : (
          <Skeletons />
        )}
      </>
    );
  }
  return (
    <Loaded
      plan={plan.data}
      owners={owners}
      householdName={summary.data?.household.name ?? ""}
      drawer={drawer}
      setDrawer={setDrawer}
      refreshFailed={failed ? retry : null}
    />
  );
}

function Loaded({
  plan,
  owners,
  householdName,
  drawer,
  setDrawer,
  refreshFailed,
}: {
  plan: PlanResponse;
  owners: Owners;
  householdName: string;
  drawer: DrawerFocus | null;
  setDrawer: (focus: DrawerFocus | null) => void;
  /** Set when a refresh failed while the last loaded plan is still on screen. */
  refreshFailed: (() => void) | null;
}) {
  const router = useRouter();
  const openMath = () => setDrawer({ kind: "math" });
  const source = plan.dataSource;
  return (
    <>
      {refreshFailed && (
        <ErrorBanner title="We couldn’t refresh your plan." onRetry={refreshFailed}>
          The numbers below are the last ones we loaded.
        </ErrorBanner>
      )}
      <PageHeader
        overline={overlineDate(plan.asOf)}
        title={headerTitle(plan.window.daysToPayday)}
        subtitle={`Income, bills and goals for the ${householdName} through ${longWeekdayShortDate(plan.window.to)}.`}
        actions={
          <>
            <label className={styles.search}>
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                className={styles.searchInput}
                placeholder="Search bills, goals, #tags"
                aria-label="Search bills and goals"
              />
            </label>
            <IconButton icon={Bell} label="Notifications" />
            <Button variant="secondary" inHeader icon={Upload} onClick={() => router.push("/imports")}>
              Import CSV
            </Button>
            <Button icon={Plus} onClick={() => router.push("/bills")}>
              Add bill or income
            </Button>
          </>
        }
      />

      <div className={styles.kpiRow}>
        <div className={styles.hero}>
          <Hero plan={plan} onMath={openMath} />
        </div>
        <BillsTile plan={plan} owners={owners} />
        <IncomeTile plan={plan} owners={owners} />
      </div>

      <div className={styles.body}>
        <div className={styles.main}>
          <Runway plan={plan} />
          {plan.state === "shortfall" && <CoverTheGap plan={plan} owners={owners} />}
          <DueTable plan={plan} owners={owners} />
        </div>
        <div className={styles.side}>
          <Decisions plan={plan} owners={owners} onOpen={setDrawer} />
          <Goals goals={plan.goals} asOf={plan.asOf} />
          <Tasks plan={plan} owners={owners} />
        </div>
      </div>

      <p className={styles.footer}>
        {source.isSample ? "Sample data · " : ""}
        {`Updated from ${source.label} ${shortDateWithYear(source.updatedOn)} · All amounts in USD`}
      </p>

      {drawer && <MathDrawer plan={plan} focus={drawer} onClose={() => setDrawer(null)} />}
    </>
  );
}
