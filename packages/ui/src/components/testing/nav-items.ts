// The app's navigation per DESIGN_SPEC §2.4 (icons) and §3 (order), matching the canvas sidebar.
// Used by stories and tests; apps/web may build its own from the same labels.
import {
  Calendar,
  Compass,
  House,
  LayoutGrid,
  Lock,
  Mail,
  MessageCircle,
  Repeat,
  ShieldCheck,
  SquareCheck,
  Target,
} from "lucide-react";
import type { NavGroup, NavItem } from "../navigation/Navigation";

export const SIDEBAR_GROUPS: readonly NavGroup[] = [
  {
    items: [
      { href: "/", label: "Overview", icon: LayoutGrid },
      { href: "/calendar", label: "Calendar", icon: Calendar },
      { href: "/bills", label: "Bills & recurring", icon: Repeat },
      { href: "/renewals", label: "Subscriptions & renewals", icon: ShieldCheck },
      { href: "/goals", label: "Goals & planned", icon: Target },
      { href: "/tasks", label: "Tasks", icon: SquareCheck },
      { href: "/ask", label: "Ask MoneyPilot", icon: MessageCircle },
      { href: "/imports", label: "Email & imports", icon: Mail },
    ],
  },
  {
    label: "Household",
    items: [{ href: "/settings/household", label: "Members & privacy", icon: Lock }],
  },
];

/** Mobile tabs, in order: Today (compass), Calendar, Ask, Renewals, Household (§3.2). */
export const TABS: readonly NavItem[] = [
  { href: "/", label: "Today", icon: Compass },
  { href: "/calendar", label: "Calendar", icon: Calendar },
  { href: "/ask", label: "Ask", icon: MessageCircle },
  { href: "/renewals", label: "Renewals", icon: ShieldCheck },
  { href: "/settings/household", label: "Household", icon: House },
];
