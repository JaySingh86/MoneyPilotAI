// Email templates. Every piece of user text is escaped for the part it lands in: HTML escape in the HTML part,
// as-is in the plain-text part (which is not markup), and one sanitized line in the subject. Subjects never carry
// amounts (BACKEND_PLAN §7.6): callers pass the title, which the planners build without money. Copy never says
// "pay": the action is "Mark as paid" in the app (hard rule 5).
//
// Colors and type come from `emailTheme` (design/tokens.json, Q-136); no value is hand-written here.
import { escapeHtml, singleLine, unescapeHtml } from "./escape";
import { emailTheme as th } from "./theme";
import type { EmailMessage } from "./email/types";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Kinds a person can switch off. The rest (proposal, security, system) always get through. */
export const MUTABLE_KINDS = ["reminder", "review", "task", "digest"] as const;

const FOOTER_TEXT = "MoneyPilot shows your plan. It never moves money.";

function page(
  titleHtml: string,
  paragraphsHtml: string[],
  action: { label: string; url: string } | null,
  footerHtml: string,
): string {
  const paragraphs = paragraphsHtml
    .map((p) => `<p style="margin:0 0 ${th.space.md};${th.body};color:${th.text}">${p}</p>`)
    .join("");
  const button = action
    ? `<p style="margin:${th.space.lg} 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:${th.space.sm} ${th.space.md};${th.button};background:${th.brand};color:${th.onBrand};border-radius:${th.radius};text-decoration:none">${escapeHtml(action.label)}</a></p>`
    : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${titleHtml}</title></head>` +
    `<body style="margin:0;padding:${th.space.lg};background:${th.pageBg}">` +
    `<div style="max-width:${th.maxWidth};margin:0 auto;padding:${th.space.lg};background:${th.cardBg};border:1px solid ${th.border};border-radius:${th.radius}">` +
    `<h1 style="margin:0 0 ${th.space.md};${th.heading};color:${th.text}">${titleHtml}</h1>${paragraphs}${button}` +
    `<p style="margin:${th.space.lg} 0 0;${th.small};color:${th.textMuted}">${footerHtml}</p></div></body></html>`
  );
}

/** Joins the app origin and an app-relative path. Anything that is not `/…` is dropped (no off-site links). */
export function appLink(appUrl: string, path: string | null | undefined): string {
  const base = appUrl.replace(/\/+$/, "");
  return path && /^\/(?!\/)[A-Za-z0-9/_?=&.%-]*$/.test(path) ? `${base}${path}` : base;
}

export interface NotificationEmailInput {
  kind: string;
  title: string;
  body: string;
  deepLink?: string | null;
  appUrl: string;
}

/** An in-app notification as an email: its title is the subject, its body the message. */
export function renderNotificationEmail(input: NotificationEmailInput): RenderedEmail {
  const url = appLink(input.appUrl, input.deepLink);
  const subject = singleLine(input.title, 150);
  const mutable = (MUTABLE_KINDS as readonly string[]).includes(input.kind);
  const settingsUrl = appLink(input.appUrl, "/settings/notifications");
  const footerText = mutable
    ? `${FOOTER_TEXT}\nTurn these emails off in Notifications settings: ${settingsUrl}`
    : FOOTER_TEXT;
  const footerHtml = mutable
    ? `${escapeHtml(FOOTER_TEXT)}<br><a href="${escapeHtml(settingsUrl)}">Turn these emails off in Notifications settings</a>`
    : escapeHtml(FOOTER_TEXT);
  return {
    subject,
    text: `${input.title}\n\n${input.body}\n\nOpen MoneyPilot: ${url}\n\n${footerText}\n`,
    html: page(
      escapeHtml(input.title),
      [escapeHtml(input.body)],
      { label: "Open MoneyPilot", url },
      footerHtml,
    ),
  };
}

export interface InviteEmailInput {
  /** May be HTML-escaped already by the API; see {@link unescapeHtml}. */
  inviterFirstName: string;
  householdName: string;
  /** Link to `/invite?token=…`. */
  link: string;
}

export function renderInviteEmail(input: InviteEmailInput): RenderedEmail {
  const inviter = unescapeHtml(input.inviterFirstName);
  const household = unescapeHtml(input.householdName);
  const subject = singleLine(`${inviter} invited you to MoneyPilot`, 100);
  const intro = `${inviter} invited you to join ${household} on MoneyPilot, to plan bills, paydays and goals together.`;
  const expiry =
    "This invitation expires in 7 days. If you were not expecting it, you can ignore this email.";
  return {
    subject,
    text: `${intro}\n\nAccept the invitation: ${input.link}\n\n${expiry}\n\n${FOOTER_TEXT}\n`,
    html: page(
      escapeHtml(`Join ${household} on MoneyPilot`),
      [escapeHtml(intro), escapeHtml(expiry)],
      { label: "Accept the invitation", url: input.link },
      escapeHtml(FOOTER_TEXT),
    ),
  };
}

/** Builds an {@link EmailMessage} from a rendered email. */
export function toMessage(to: string, rendered: RenderedEmail): EmailMessage {
  return { to, subject: rendered.subject, text: rendered.text, html: rendered.html };
}
