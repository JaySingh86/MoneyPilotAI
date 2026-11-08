// Q-136: the email templates take every color and type value from design/tokens.json; no hex is hand-written.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emailTheme } from "./theme";
import { renderNotificationEmail } from "./templates";

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z])/;

function files(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)],
  );
}

describe("email theme", () => {
  it("no file under packages/notify/src contains a hex color literal", () => {
    const offenders = files(new URL("./", import.meta.url))
      .filter((f) => /\.(ts|tsx|css|html)$/.test(f.pathname))
      .filter((f) => HEX.test(readFileSync(fileURLToPath(f), "utf8")))
      .map((f) => f.pathname);
    expect(offenders).toEqual([]);
  });

  it("the theme resolves to token values and the rendered mail uses them", () => {
    expect(emailTheme.brand).toMatch(HEX);
    const mail = renderNotificationEmail({
      kind: "reminder",
      title: "Rent is due in 3 days",
      body: "b",
      appUrl: "https://app.example.test",
    });
    expect(mail.html).toContain(`background:${emailTheme.brand}`);
    expect(mail.html).toContain(`color:${emailTheme.text}`);
    expect(mail.html).toContain("Inter");
  });

  it("links to the notification settings at /settings/notifications (Q-135)", () => {
    const mail = renderNotificationEmail({
      kind: "reminder",
      title: "t",
      body: "b",
      appUrl: "https://app.example.test",
    });
    expect(mail.text).toContain("https://app.example.test/settings/notifications");
    expect(mail.html).toContain("https://app.example.test/settings/notifications");
  });
});
