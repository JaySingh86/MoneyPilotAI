import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "../test/axe";
import { Avatar, AvatarStack, OwnerDot } from "./Avatar";

describe("Avatar", () => {
  it("shows the initial and is named by the person", () => {
    render(<Avatar name="jordan" role="partnerB" size={24} />);
    const avatar = screen.getByRole("img", { name: "jordan" });
    expect(avatar.textContent).toBe("J");
    expect(avatar.className).toContain("partnerB");
    expect(avatar.className).toContain("size24");
  });

  it("can be decorative when the name is written next to it", () => {
    const { container } = render(<Avatar name="Sam" role="partnerA" decorative />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("stacks avatars under one name", async () => {
    const { container } = render(
      <AvatarStack label="Sam and Jordan">
        <Avatar name="Sam" role="partnerA" decorative />
        <Avatar name="Jordan" role="partnerB" decorative />
      </AvatarStack>,
    );
    expect(screen.getByRole("img", { name: "Sam and Jordan" })).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});

describe("OwnerDot", () => {
  it("is decorative and colored by role", () => {
    const { container } = render(<OwnerDot role="both" />);
    const dot = container.firstElementChild;
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.className).toContain("dot-both");
  });
});
