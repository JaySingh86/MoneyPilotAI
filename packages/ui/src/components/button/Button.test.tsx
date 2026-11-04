import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Bell } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { Button, IconButton } from "./Button";

describe("Button", () => {
  it("is a real button, type=button by default, reachable by keyboard", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Add bill or income</Button>);
    const button = screen.getByRole("button", { name: "Add bill or income" });
    expect(button.getAttribute("type")).toBe("button");
    await userEvent.tab();
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("applies the variant classes", () => {
    render(
      <>
        <Button>Primary</Button>
        <Button variant="secondary" inHeader>
          Secondary
        </Button>
        <Button variant="text">Text</Button>
        <Button variant="destructive" label="Delete household…" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Primary" }).className).toContain("primary");
    expect(screen.getByRole("button", { name: "Secondary" }).className).toContain("inHeader");
    expect(screen.getByRole("button", { name: "Text" }).className).toContain("text");
    expect(screen.getByRole("button", { name: "Delete household…" }).className).toContain("destructive");
  });

  it("doesn't fire when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Add
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    const { container } = render(<Button variant="secondary">Import CSV</Button>);
    await expectNoAxeViolations(container);
  });
});

describe("IconButton", () => {
  it("draws an 18 px glyph (Q-045)", () => {
    const { container } = render(<IconButton icon={Bell} label="Notifications" />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("18");
  });

  it("is named by its required label and hides the icon and dot", () => {
    const { container } = render(<IconButton icon={Bell} label="Notifications, 2 new" notification />);
    expect(screen.getByRole("button", { name: "Notifications, 2 new" })).toBeTruthy();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("[data-notification-dot]")?.getAttribute("aria-hidden")).toBe("true");
  });
});
