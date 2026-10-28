import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { SidebarNav, TabBar } from "./Navigation";
import { SIDEBAR_GROUPS, TABS } from "../testing/nav-items";

const groups = SIDEBAR_GROUPS.map((g) => ({
  ...g,
  items: g.items.map((i) => ({
    ...i,
    current: i.href === "/imports",
    ...(i.href === "/imports" ? { count: 4, countLabel: "4 to review" } : {}),
  })),
}));

describe("SidebarNav", () => {
  it("is a nav landmark of links with aria-current on the active page", () => {
    render(<SidebarNav groups={groups} />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(9);
    const active = within(nav).getByRole("link", { current: "page" });
    expect(active.getAttribute("href")).toBe("/imports");
    expect(active.textContent).toBe("Email & imports44 to review");
  });

  it("names a labelled group's list", () => {
    render(<SidebarNav groups={groups} />);
    expect(screen.getByRole("list", { name: "Household" })).toBeTruthy();
  });

  it("is keyboard reachable in visual order", async () => {
    render(<SidebarNav groups={groups} />);
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe("Overview");
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe("Calendar");
  });

  it("accepts a custom link component (next/link)", () => {
    const Custom = (props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
      <a data-custom="" {...props} />
    );
    const { container } = render(<SidebarNav groups={groups} linkComponent={Custom} />);
    expect(container.querySelectorAll("[data-custom]")).toHaveLength(9);
  });

  it("has no axe violations", async () => {
    const { container } = render(<SidebarNav groups={groups} />);
    await expectNoAxeViolations(container);
  });
});

describe("TabBar", () => {
  it("has five tabs in spec order", async () => {
    const { container } = render(<TabBar items={TABS.map((t) => ({ ...t, current: t.href === "/ask" }))} />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Today", "Calendar", "Ask", "Renewals", "Household"]);
    expect(screen.getByRole("link", { current: "page" }).textContent).toBe("Ask");
    await expectNoAxeViolations(container);
  });
});
