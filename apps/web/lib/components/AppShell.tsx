"use client";

import { Avatar, AvatarStack, Button, IconButton, SidebarNav } from "@mp/ui";
import type { LinkComponent, NavGroup } from "@mp/ui";
import {
  Calendar,
  Compass,
  LayoutGrid,
  Lock,
  Mail,
  Menu,
  MessageCircle,
  Repeat,
  ShieldCheck,
  SquareCheck,
  Target,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useSummary } from "../api/hooks";
import { useRenewalsSummary } from "../lists/hooks";
import { useAuth } from "../auth/AuthProvider";
import { useOwners } from "../owners";
import styles from "./shell.module.css";

const NavLink: LinkComponent = ({ href, ...rest }) => <Link href={href} {...rest} />;

/** Sidebar order and icons: DESIGN_SPEC §2.4 and §3, as the canvas draws them. */
function groups(pathname: string, tasksDue: number, reviewQueue: number): NavGroup[] {
  const current = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  return [
    {
      items: [
        { href: "/overview", label: "Overview", icon: LayoutGrid, current: current("/overview") },
        { href: "/calendar", label: "Calendar", icon: Calendar, current: current("/calendar") },
        { href: "/bills", label: "Bills & recurring", icon: Repeat, current: current("/bills") },
        {
          href: "/renewals",
          label: "Subscriptions & renewals",
          icon: ShieldCheck,
          current: current("/renewals"),
        },
        { href: "/goals", label: "Goals & planned", icon: Target, current: current("/goals") },
        {
          href: "/tasks",
          label: "Tasks",
          icon: SquareCheck,
          current: current("/tasks"),
          count: tasksDue,
          countLabel: `${tasksDue} due this week`,
        },
        { href: "/ask", label: "Ask MoneyPilot", icon: MessageCircle, current: current("/ask") },
        {
          href: "/imports",
          label: "Email & imports",
          icon: Mail,
          current: current("/imports"),
          count: reviewQueue,
          countLabel: `${reviewQueue} to review`,
        },
      ],
    },
    {
      label: "Household",
      items: [
        {
          href: "/settings/household",
          label: "Members & privacy",
          icon: Lock,
          current: current("/settings/household"),
        },
      ],
    },
  ];
}

function Brand() {
  return (
    <div className={styles.brand}>
      <span className={styles.logo} aria-hidden="true">
        <Compass size={20} strokeWidth={2} />
      </span>
      <span>
        <span className={styles.wordmark}>MoneyPilot</span>
        <span className={styles.tagline}>Household planner</span>
      </span>
    </div>
  );
}

function HouseholdBadge({ compact = false }: { compact?: boolean }) {
  const owners = useOwners();
  const summary = useSummary();
  if (!owners || !summary.data) return null;
  const members = owners.members;
  const names = members.map((m) => m.name).join(" & ");
  const plan = summary.data.entitlements.plan === "family_plus" ? "Family Plus" : "Free";
  return (
    <div className={styles.household} data-testid="household">
      <AvatarStack label={names} ring="surface">
        {members.map((m) => (
          <Avatar key={m.id} name={m.name} role={m.role} size={28} decorative />
        ))}
      </AvatarStack>
      {!compact && (
        <span className={styles.householdText}>
          <span className={styles.householdName}>{summary.data.household.name}</span>
          <span className={styles.householdMeta}>{`${names} · ${plan}`}</span>
        </span>
      )}
    </div>
  );
}

/** The card pinned to the sidebar's bottom edge: contextual per page, as the canvas draws it. */
function ContextCard({ pathname }: { pathname: string }) {
  const summary = useSummary();
  const renewals = useRenewalsSummary();
  const queued = summary.data?.badges.reviewQueue ?? 0;
  if (pathname.startsWith("/overview")) {
    return (
      <div className={styles.sources}>
        <p className={styles.sourcesTitle}>Data sources</p>
        <p className={styles.sourcesText}>CSV import and the Gmail connection. Bank connection: off.</p>
        {queued > 0 && (
          <Link href="/imports" className={styles.sourcesLink}>
            {`Review ${queued} items found in email`}
          </Link>
        )}
      </div>
    );
  }
  if (pathname.startsWith("/calendar")) {
    // The words are the default reminder policy as the canvas draws it. They must come from
    // `GET …/reminder-rules` once WP-15 adds it (Q-161), and "Change defaults" opens its editor
    // (Q-165); until then the copy is fixed and the control is disabled. See Q-167.
    return (
      <div className={styles.sources}>
        <p className={styles.sourcesTitle}>Reminders</p>
        <p className={styles.sourcesText}>
          Email + push, 3 days before and on the due date. Each owner gets their own.
        </p>
        <button type="button" className={styles.sourcesLinkDisabled} disabled title="Coming soon">
          Change defaults
        </button>
      </div>
    );
  }
  if (pathname.startsWith("/renewals") && renewals.data && renewals.data.count > 0) {
    const { count, foundAutomatically: found } = renewals.data;
    return (
      <div className={styles.sources}>
        <p className={styles.sourcesTitle}>Found automatically</p>
        <p className={styles.sourcesText}>
          {found === count
            ? `All ${count} came from your email or bank CSV. None were typed by hand.`
            : `${found} of ${count} came from your email or bank CSV. The rest were typed by hand.`}
        </p>
      </div>
    );
  }
  return null;
}

function SidebarFooter({ pathname }: { pathname: string }) {
  const { signOut } = useAuth();
  return (
    <div className={styles.footer}>
      <ContextCard pathname={pathname} />
      <Button variant="text" size="compact" className={styles.signOut} onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}

function Sidebar({ className }: { className?: string }) {
  const pathname = usePathname();
  const summary = useSummary();
  const badges = summary.data?.badges;
  return (
    <SidebarNav
      className={className}
      linkComponent={NavLink}
      header={
        <>
          <Brand />
          <HouseholdBadge />
        </>
      }
      groups={groups(pathname, badges?.tasksDue ?? 0, badges?.reviewQueue ?? 0)}
      footer={<SidebarFooter pathname={pathname} />}
    />
  );
}

function Drawer({ onClose }: { onClose: () => void }) {
  const pathname = usePathname();
  const first = useRef(pathname);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Close after following a link.
  useEffect(() => {
    if (pathname !== first.current) onClose();
  }, [pathname, onClose]);
  return (
    <div className={styles.overlay}>
      <div className={styles.drawer} role="dialog" aria-modal="true" aria-label="Menu">
        <div className={styles.drawerHeader}>
          <IconButton icon={X} label="Close menu" onClick={onClose} autoFocus />
        </div>
        <Sidebar />
      </div>
      <button
        type="button"
        className={styles.scrim}
        aria-label="Close menu"
        tabIndex={-1}
        onClick={onClose}
      />
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    document.querySelector<HTMLElement>("[data-menu-button]")?.focus();
  }, []);
  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skipLink}>
        Skip to content
      </a>
      <div className={styles.sidebarSlot}>
        <div className={styles.sidebarStick}>
          <Sidebar />
        </div>
      </div>
      <div>
        <header className={styles.topBar}>
          <Brand />
          <div className={styles.topBarEnd}>
            <HouseholdBadge compact />
            <IconButton
              icon={Menu}
              label="Open menu"
              data-menu-button=""
              onClick={() => setOpen(true)}
              aria-expanded={open}
            />
          </div>
        </header>
        <main id="main" className={styles.content} tabIndex={-1}>
          <div className={styles.page}>{children}</div>
        </main>
      </div>
      {open && <Drawer onClose={close} />}
    </div>
  );
}
