# MoneyPilot AI: Design Specification v1.1 (MVP)

Palette: **Harbor** (navy brand, teal and plum partners, green income, amber for decisions). It replaced Pine in v1.1. Only token values changed; component and screen specs did not.

This is the implementation contract for the web app (Next.js) and the mobile app (React Native). If you build every screen from this spec and the tokens, the result should match the proposed design pixel for pixel. That applies whether a person or a coding agent is building it.

| Source | What it holds |
|---|---|
| [Design canvas](https://claude.ai/artifact/DCvQYH42FUdWu6dwf2iiZ7) | Clickable mockups of every screen, plus the visual spec board (“Design specification v1.0”). It is private until shared. |
| `design/tokens.json` | Every color, font, size, space, radius, shadow and motion value (W3C design-token format). |
| `design/tokens.css` | The same tokens as CSS custom properties (`--mp-*`) for the web app. |
| `design/fixtures/rivera-household.json` | The golden sample household from the mockups, with the numbers each screen must show. |
| This file | Component specs, screen specs, calculation rules, content rules, accessibility and design QA. |

**Precedence:** the canvas wins over this file, and this file wins over code. If something is missing or ambiguous, ask before guessing. Change the canvas, `tokens.json`, `tokens.css` and this file in the same PR.

---

## 1. Non-negotiable rules

1. **No raw values.** Every color, font size, space, radius and shadow comes from a token. Lint for hex literals outside `design/`.
2. **Never move money.** There are no “Pay”, “Transfer” or “Send money” actions. Use “Mark as paid” and “Ask [partner] to approve”.
3. **Rules calculate, AI explains.** Every number on screen comes from deterministic code (§6). AI text only describes those results, and it always appears with its sources and a “See the math” or “How was this calculated?” link.
4. **Amber means “needs a decision”** and nothing else. Don’t use the `attention.*` tokens for errors, branding or decoration.
5. **Each partner keeps one color everywhere.** The household creator is `partnerA` (teal) and the invited partner is `partnerB` (plum). Items owned by both use `both.mark` (brand navy). Colors come from the member’s role, never from their name.
6. **Status is never shown by color alone.** Chips always carry text, owners show an initial, and the lowest bar has a label.
7. **Light theme only in MVP.** Use semantic token names so a dark theme can be added later without touching components.

---

## 2. Foundations

The exact values are in `design/tokens.json`. This section covers how to use them.

### 2.1 Color roles
| Role | Tokens | Use |
|---|---|---|
| Canvas & surfaces | `bg.canvas`, `bg.surface`, `bg.subtle`, `bg.muted`, `bg.track` | Page background is canvas. Cards, sidebar and bars are surface. Math and extracted-field boxes are subtle. |
| Lines | `border.default`, `border.divider`, `border.strong`, `border.cell` | Card edge, row divider, input and secondary button border, calendar cell. |
| Text | `text.primary`, `text.secondary`, `text.muted`, `text.disabled`, `text.inverse` | Body and amounts, supporting copy, meta, disabled, on dark. |
| Brand | `brand.default`, `brand.strong`, `brand.soft`, `brand.onSoft`, `brand.tint`, `brand.onStrong*` | Primary action, hero, active nav, ok chips, selected rows and paydays. |
| Attention | `attention.*` | Needs a decision: flags, due-soon, price up. `attention.mark` is for graphics only. |
| Info | `info.*` | Neutral facts and estimates (dashed `info.border`). |
| Income | `income.*` | Money coming in: “+” amounts, income KPI values, income chips. Never used for anything else. |
| People | `partnerA.*`, `partnerB.*`, `both.mark` | Avatars, owner dots, owner bars. |
| Chart | `chart.*` | Runway chart only. |

### 2.2 Typography
- **Manrope** (600/700/800) for headings and every money amount shown as a figure. **Inter** (400/500/600) for everything else. Load only these weights.
- Every amount, date and count uses `font-variant-numeric: tabular-nums` (`fontVariant: ['tabular-nums']` in React Native).
- Scale tokens: `display-xl` 52, `display-l` 44, `amount-xl` 34, `heading-1` 32, `amount-l` 28, `heading-1m` 26, `heading-3` 22, `heading-2` 18, `heading-2m` 16, `title` 15/600, `body-l` 15, `body` 14, `small` 13, `caption` 12, `overline` 12/600 uppercase +0.08em, `micro` 11.
- Table headers: 11 px, weight 600, uppercase, +0.06em, `text.muted`.
- Display sizes (Manrope 800) use −0.02em tracking, and the two hero amounts use −0.03em.

### 2.3 Spacing, radius, elevation
- **Spacing** uses a 4 px base with 2 px half-steps: 2, 4, 6, 8, 10, 12, 14, 16, 20, 22, 24, 28, 40, 56. Nothing else.
- **Radius:** xs 6 (chart bars, calendar chips), sm 8 (segments), md 10 (buttons, inputs, nav items), lg 12 (calendar cells), xl 14 (inner cards, radio cards, mobile bottom-bar button), 2xl 16 (mobile cards), 3xl 18 (web cards, web hero), 4xl 20 (mobile hero), full (chips, pills, avatars).
- **Elevation:** the UI is flat, with surfaces separated by a 1 px `border.default`. The only shadows are `shadow.selected` (selected segment) and `shadow.overlay` (menus, dialogs, toasts).

### 2.4 Icons
- Use [Lucide](https://lucide.dev) (`lucide-react`, `lucide-react-native`) with stroke width **1.8**, round caps and joins, `currentColor`.
- Sizes: 16 inline in buttons, 18 for sidebar nav, 20 for header buttons and mobile list icons, 22 for the tab bar.
- Mapping: Overview `layout-grid` · Calendar `calendar` · Bills & recurring `repeat` · Subscriptions & renewals `shield-check` · Goals `target` · Tasks `square-check` · Ask `message-circle` · Email & imports `mail` · Import `upload` · Privacy `lock` · Notifications `bell` · Add `plus` · Search `search` · Attention `triangle-alert` · Info `info` · Back/forward `chevron-left`/`chevron-right` · Household `house` · Edit `pencil` · Send `arrow-up` · Confirmed `check`.
- The logo mark is a compass needle in a circle on a 36 px `brand.default` square (radius md). Use the SVG from the canvas until a final logo exists.
- No emoji anywhere in the UI.

### 2.5 Motion
150 ms ease-out (`cubic-bezier(0,0,0.2,1)`), animating opacity and color only. No motion when `prefers-reduced-motion` is set. There are no spinners inside cards; use skeletons (§5.3).

---

## 3. Layout

### 3.1 Web
- **Shell:** a sidebar (`size.sidebarWidth` 240, `bg.surface`, right border) next to the content area. The content area has padding of 28 at the top, `clamp(16px, 3vw, 40px)` on the sides and 40 at the bottom. Content is centered with `max-width: 1160px`.
- **Page header:** an overline (date or section), `heading-1` title, and `body-l` subtitle in `text.muted`. Actions sit on the right and wrap below on narrow widths.
- **KPI row:** CSS grid `repeat(auto-fit, minmax(240px, 1fr))` with gap 16. The hero tile spans 2 columns when there is room.
- **Body:** two columns, main and side, in a 2:1 ratio with gap 20. Main has a minimum width of 560 and side a minimum of 320. Sections inside a column are spaced 20 apart.

| Viewport | Behavior |
|---|---|
| ≥ 1200 | Sidebar plus two-column body. |
| 800–1199 | Sidebar plus a single column, with the side column stacked under the main one in source order. |
| < 800 | Top bar (logo, household switcher, menu button) with the sidebar in a drawer. Use the mobile screen patterns. |

- Wide tables go inside an `overflow-x: auto` wrapper with `min-width: 640px`. The page itself never scrolls horizontally.

### 3.2 Mobile
- Reference frame: 390 × 844. Side gutter 16, and sections spaced 14–16 apart.
- Respect safe areas, and don’t draw a status bar. The content area scrolls, while the tab bar or bottom action bar stays fixed.
- **Tab bar:** 5 equal tabs in this order: **Today, Calendar, Ask, Renewals, Household**. Icon 22, label 11, minimum height 48. Bottom padding is `max(22, safeArea.bottom)`. The active tab uses `brand.default` and weight 600, and the bar has a top border.
- **Bottom action bar** (detail and setup screens): padding 12/16, bottom padding `max(26, safeArea.bottom)`, top border, a full-width primary button (height 50, radius xl), and an optional 12 px caption under it.

---

## 4. Components

Minimum touch target is 44 × 44. A 36 px control gets an invisible hit area. The focus ring is `2px solid brand.default` with a 2 px offset, or white on `brand.strong`. Use real elements: `button`, `a`, `input`, `label`, `role="switch"`, `role="radio"`.

| Component | Spec |
|---|---|
| **Button: primary** | Web: height 40, padding-x 16, radius md, `brand.default` background, white text, `body` 600. Hover `brand.strong`. Mobile: height 46 inline or 50 in a bar, radius lg/xl, 15 px. Icons are 16 with a gap of 8. Only one primary button per region. |
| **Button: secondary** | Same size, `bg.surface`, 1 px `border.strong` (`border.default` in the page header), `text.primary`. Hover `bg.subtle`. |
| **Button: text** | Transparent, `brand.default` 600. Hover adds an underline. |
| **Button: icon** | 44 × 40 on web, 44 × 44 circle on mobile. `bg.surface` with a `border.default` border. `aria-label` is required. A notification dot is 8 px `attention.mark` with a 2 px white ring. |
| **Disabled** | `bg.track` fill, `text.disabled`, no hover. |
| **Button: destructive** | Secondary size with a 1 px `text.primary` border, and the label ends in “…” (“Delete household…”). It always opens a confirm dialog: delete needs the household name typed in, leave needs one confirm. Never red or amber. |
| **Stepper** | Two 44 × 44 secondary buttons (radius md, “−” / “+”, `aria-label` such as “Increase by $25”) around an `<output aria-live="polite">` in `amount-l`. Step $25, minimum $0. A label sits above it, linked with `aria-labelledby`. |
| **Segmented control** | The track is `bg.canvas` (or `bg.track` when it sits on the canvas), padding 3, radius md (lg on mobile). Segments: height 36, minimum width 64, radius sm, 13/600. Selected: `bg.surface` with `shadow.selected` and `text.primary`. Unselected: `text.muted` (`text.secondary` on the track). Set `aria-pressed` on each segment and `aria-label` on the group. |
| **Filter pill** | Height 36, padding-x 14, radius full, 13/600. Selected: `text.primary` fill with white text. Default: surface with a `border.strong` border. The count follows the label at 75% opacity. |
| **Status chip** | 12/600, padding 3×10, radius full. Variants: `ok` (brand.soft / brand.onSoft), `income` (income.soft / income.onSoft), `attention` (attention.soft / attention.text), `info` (info.soft / info.text), `estimate` (surface, 1 px dashed `info.border`, `info.text`), `release` (brand.default / white, plan documents only). |
| **Badge (nav count)** | 12/600, padding 1×8, radius full, attention variant. |
| **Card: standard** | Surface, 1 px `border.default`. Web: radius 3xl, padding 22. Mobile: radius 2xl, padding 14. The title is `heading-2` / `heading-2m`, with an optional `small` subtitle in `text.muted` 2 px below. |
| **Card: hero** | `brand.strong`, white text. Web: radius 3xl, padding 24. Mobile: radius 4xl, padding 20. The label is 13/500 `brand.onStrongMuted`, the amount `display-xl` / `display-l`, and the breakdown row sits on a `brand.strongDivider` top rule. Only one hero per screen. **Shortfall variant:** same colors. Label “Short before {payday}”, a “Needs a decision” chip (`attention.markOnStrong` background, `text.primary` text), amount “$X short”, and a caption naming the dates below the cushion and below $0. |
| **Card: attention** | `attention.surface`, 1 px `attention.border`, radius xl, padding 14. The header row is a 16 px triangle icon plus a 12/600 `attention.text` label (“Needs a decision · Jordan”), then a `title`, a `small` body, and actions (36 px buttons). |
| **KPI tile** | A standard card with gap 6–8: 13/500 `text.muted` label, `amount-l` value, 13 px `text.muted` caption. An optional owner split bar (height 8, radius full, segments in partner marks) goes at the bottom. |
| **Avatar** | Circle. Sizes 32 (header), 28 (lists), 24 (table), 22 (activity). The initial is 600 in the partner text color on the partner soft color. When stacked, overlap by −8 / −10 with a 2 px border in the background color. |
| **Owner dot** | 7 px circle in the partner mark color (calendar chips, legends). |
| **Progress bar** | Height 8, radius full, `bg.track` track. The first goal fills with `brand.default`, the second with `partnerA.mark`, the third with `partnerB.mark`. Label row above (title 600, percent 13/600) and caption row below (12 px muted). |
| **Switch** | Track 52×32, radius full. Knob 26 with a 3 px inset. On `brand.default`, off `control.off`. `role="switch"` with `aria-checked`. Row height at least 56, with title 500 and a 12 px muted sub-line. |
| **Radio card** | Padding 12, radius xl. Selected: 2 px `brand.default` border and `brand.tint` background. Default: 1 px `border.default`. Ring 20 (2 px border, `control.radioOff` when off) with a 10 px dot. Optional leading icon tile is 40, radius lg. `role="radio"` inside a `role="radiogroup"`. |
| **Checkbox** | Native, 18–20 px, `accent-color: brand.default`. Done tasks get a strike-through and `text.muted`. |
| **Input / select** | Height 44, padding-x 12, radius md, 1 px `border.strong`. The label sits above at 12/600 `text.secondary`, 6 px gap. Errors use an `attention.text` border and a message below. Money fields use `inputmode="decimal"`. |
| **Sidebar nav item** | Padding 10×12, radius md, gap 12, icon 18, `text.secondary`. Active: `brand.soft` background, `brand.default` 600, `aria-current="page"`. Optional count badge on the right. Group label: 11/600 uppercase. |
| **Table** | Header per §2.2. Cell padding 12×10 (10 on dense tables). `border.divider` between rows. Two-line cells: 600 title plus 12 px muted meta. Amounts are right-aligned 600. Selected row: `brand.tint`. Footer total uses `amount` Manrope 800 16. |
| **List row (mobile)** | Minimum height 56, `border.divider` between rows. Date block 40 wide (11 px muted weekday over 700 day). Title 600 with 12 px meta. Amount right-aligned, 600, tabular. The whole row is the link. |
| **Math breakdown** | `bg.subtle`, radius lg, padding 12, 13 px tabular. An “THE MATH” overline, then label/value rows. The total row is 600 with a `border.default` top rule. A gap row is 700 `attention.text`. |
| **AI answer block** | The user’s question is a right-aligned bubble (`brand.default`, white, radius 18 18 4 18). The answer is a standard card: lead sentence 16/600, math breakdown, options as radio cards, a result banner (`brand.soft` with a check icon), and actions. The footer caption (12 px muted) names the sources and says “AI wrote this summary.” |
| **Review queue item** | Inner card radius xl, padding 16. Header: 36 px mail icon tile, `title`, a tag chip (`info` “Updates existing”, `ok` “New renewal”, `attention` “Needs a decision”), and a 12 px meta line (sender · “subject” · date). Then an extracted-fields grid (`bg.subtle`, `repeat(auto-fit, minmax(150px,1fr))`, 11 px uppercase key over a 600 value), a `small` effect sentence, and actions Confirm (primary) · Edit (secondary) · Ignore (text). After an action, the item disappears and a `role="status"` banner says what changed. |
| **Runway chart** | See §4.1. |
| **Calendar cell** | See §4.2. |
| **Empty / loading / error** | See §5.3. |

### 4.1 Runway chart
- One bar per day from today through the next primary payday, inclusive. On web the plot is 230 px tall, and the y-axis runs from 0 to the maximum balance rounded up to the next $1,000.
- Bars have a max width of 44, a gap of 8 and radius `6 6 0 0`. Colors: `chart.balance`; paydays `chart.payday`; the single lowest day `chart.lowest`.
- The cushion is a 2 px dashed `chart.cushion` line at the cushion value. The baseline is 1 px `chart.axis`.
- Every bar has its value above it (11 px; 600 and colored for payday and lowest bars). Under each bar sit the date (600) and the event (11 px muted, e.g. “Rent −2,150”). The lowest bar also gets a tooltip: `text.primary` background, white 11/600 text, radius xs, reading “Lowest · $1,507”.
- The legend reads Balance · Payday · Lowest point · $500 cushion.
- **Negative balances:** draw a solid 1 px `text.primary` axis at $0, and reserve space below it scaled the same way as above it. Negative bars use `chart.lowest` with radius `0 0 6 6` and hang down from the axis. Their values (“−$293”) sit under the bar in `attention.text` 600.
- Below 620 px the chart scrolls horizontally inside its card.
- Accessibility: each bar gets an `aria-label` (“Nov 5, projected $1,507, lowest”), or provide a visually hidden table.
- The mobile hero uses a mini version: 11 bars, 48 px tall, gap 4, radius 3, `chart.barOnStrong`, with paydays in `chart.paydayOnStrong` and the lowest in `attention.markOnStrong`. It is decorative (`aria-hidden`) because the text beside it carries the meaning.

### 4.2 Calendar
- A 7-column grid (`repeat(7, minmax(0,1fr))`, gap 6) with weekday headers 11/600 +0.08em muted. Weeks start on Sunday (US).
- **Cell:** a `button`, minimum height 112, padding 8, radius lg, 1 px `border.cell`, surface background. The day number is 13/600 inside a 26 px circle. Selected: 2 px `brand.default` border with the day number filled `brand.default` and white text. Payday: `brand.tint` background plus a “PAYDAY” label (10/700 +0.06em `brand.onSoft`). Days outside the month use `bg.muted` and `text.disabled` and can’t be selected. The aria-label reads “November 4, 1 item”.
- **Event chip:** flex row, padding 3×6, radius xs, 11 px. Owner dot, then the name (ellipsis), then the amount (600, signed). Variants: income (income.soft, income.onSoft, `income.border`), bill (bg.canvas, border.default), estimate (surface, dashed `info.border`), decision (attention.soft, `attention.chipBorder`), planned (surface, `border.strong`). Show up to 3, then “+N more”. Amounts of $100 or more show as whole dollars.
- **Side panel:** the selected day as `heading-3`, then one inner card per item: title, signed amount in Manrope 800 17, kind chip, owner dot and name, and a note.
- **Owner filter:** “Sam” shows Sam’s items plus items owned by Both. The same applies for Jordan.

---

## 5. Screens

The routes below are suggestions. Each screen lists its regions in order, the data it uses, its interactions, and its golden values from the fixture. Every MVP screen is drawn, including the shortfall state. Still to draw: Notifications (web and mobile), web Ask MoneyPilot (P1; reuse the mobile Ask pattern in a side panel) and mobile settings (reuse the Members & privacy rows). Build those from these components and review them against the canvas before shipping.

### 5.1 Web

**Overview: `/`** (FR-02, FR-03, FR-04, FR-05, FR-10, Journey 2)
1. Header: overline with today’s date (“Tuesday, October 27”). Title “{N} days to payday. Here’s the plan.” Subtitle naming the household and payday. Actions: search input (180 px), notifications icon button, “Import CSV” (secondary), “Add bill or income” (primary).
2. KPI row: hero “Safe to spend until {weekday, Mon D}” spanning 2 columns, with the per-day caption, the amount, and the breakdown “Lowest projected balance $X on {date} − Cushion $Y = $Z” plus a “See the math” link. Then a “Bills before payday” tile (total, count, owner split bar and amounts), and an “Income expected” tile (next income, then the following paycheck and goal transfer).
3. Main column: the “Cash runway to payday” chart card (§4.1). Then the “Due before payday” table card with Both/Sam/Jordan segmented filter. Columns: Due (date + weekday), Bill (name + frequency), Owner (avatar + name), Status chip, Amount. A total row underneath. Filtering recalculates the total.
4. Side column: a “Decide this week” card (count chip, up to 3 suggestion cards, the first one is the attention variant, and a footer stating that rules calculate and AI explains), “Goals & planned expenses” (progress bars), and “Household tasks” (checkbox rows with owner avatar).
5. Footer caption: “Sample data · Updated from CSV import {date} · All amounts in USD”. In production, show the data-source freshness here.
- **Golden values:** safe to spend $1,007 · ≈ $100 a day · lowest $1,507 on Nov 5 · bills $4,792.99, 8 bills (Sam $1,793.99, Jordan $2,999.00) · income $2,900.00 on Fri, Oct 30 · Tahoe $250 behind · runway values per fixture.

**Calendar: `/calendar`** (FR-03)
1. Header: prev/next month icon buttons (44 circle) around the month title (`heading-1` at 30), owner segmented filter, and an “Add to calendar” primary button.
2. Legend row (12 px): Income, Bill, Estimate, Needs a decision, then the Sam, Jordan and Both dots.
3. Body: the month grid card (2fr, minimum width 640 inside a scroll wrapper) next to the side column (1fr): the selected-day card and a “November at a glance” card (income, bills with count, goals and planned expenses, then “Left for everyday spending” in `brand.default` Manrope 18, plus an estimates caption).
- Default selection is the day of the top “Decide this week” item from Overview (Nov 4 in the fixture), otherwise today.
- **Golden values:** income $9,200.00 · bills (16) −$5,590.94 · goals + planned −$800.00 · left $2,809.06.

**Subscriptions & renewals: `/renewals`** (FR-14)
1. Header: overline “Everything that renews”, title, subtitle. Actions: “Scan email now” (secondary) and “Add renewal” (primary).
2. KPI row of 4 tiles: Yearly cost (hero style, not spanning), “Big renewals, next 90 days”, “Price increases” (`attention.text` value), and “Could save” (`brand.default` value, the sum of items the household marked as possibly unused).
3. Renewal radar card: a 90-day track (4 px, `bg.track`) with dots placed by day offset (attention dots for decisions and price-ups, `chart.balance` dots otherwise) and labels for Today, month starts and the end date. Under it, an auto-fit grid (minimum 190) of cards for yearly and 6-month items in the window. Items that need a decision use the attention card.
4. Body: a table card (2fr) with category filter pills (All, Insurance, Subscriptions, Memberships, Vehicle & home, each with a count). Columns: Name (button + provider), Cost (+ frequency), Next renewal (date + relative), Owner avatar, Found in (Email / Bank CSV / Email + CSV / Added by hand), Status chip. Rows are sorted by the next action date. The detail aside (1fr) shows the selected item: category overline, `heading-3` name, provider, `amount-l` cost with frequency, then a definition list (Next renewal, Act by, Owner, Auto-renews, Cost per year, Found in), a note box (`bg.subtle`), “Mark as reviewed” and “Edit reminders” buttons, and a “See what we read from email” link.
- **Golden values:** $6,787.27 · 16 items · about $566 a month · $1,040.99 · 4 payments + 1 plan decision · +$55 / yr · $181.87 / yr.

**Email & imports: `/imports`** (FR-07, FR-13)
1. Header: title “Let your inbox fill in the bills” and subtitle. The automation stat tile shows `amount-l` “92%” in `brand.default` with caption “found automatically this month · 23 from email & CSV · 2 typed by hand”.
2. Main column: the “Review what we found” card (count chip, status banner, empty state, review queue items) and the “Applied automatically” card (rows with an Undo text button).
3. Side column: “Connected sources” (one block per member’s email connection with status chip, scan stats, and Pause/Disconnect. If a partner isn’t connected, show “Only {name} can connect it” and a “Remind {name} to connect” button. Then the forwarding address in a code box with Copy, then Bank CSV with “Upload new”). Below that, the “What MoneyPilot reads” card (hero colors, 5 bullets, “Manage watched senders (N)”).
- The nav badge shows the number of items still in the queue.
- **Golden values:** 4 to review. Confirming the electricity item shows “Electricity set to $151.37. Safe to spend is now $998.”

**Bills & recurring: `/bills`** (FR-02, FR-09)
1. Header: overline “Everything that repeats”, title, subtitle with counts. Actions: “Import CSV” (secondary) and “Add bill or income” (primary).
2. KPI row of 4: Bills per month on average (yearly and quarterly bills divided by their months), Income per month on average (`income.text`; biweekly × 26 ÷ 12), Left after bills, Estimates to confirm (`info.text`).
3. Body: a table card (2fr) with type pills (All, Bills, Income, Subscriptions, Estimates, each with a count) and the owner segmented control. Columns: Name (button + category), Schedule, Next (date + relative), Owner avatar, Status chip, Amount (income in `income.text` with “+”). Rows are sorted by the next date. The detail aside (1fr) shows a category overline, `heading-3` name, `amount-l` amount with schedule, a definition list (Next, Owner, Reminders, Found in, Last time), an estimate explainer box for estimated bills (history chips plus the rule text), a note box, and “Mark as paid” / “Mark as received” plus Edit.
- **Golden values:** $4,956.94 · $9,725.00 · $4,768.06 · 2 estimates · 18 rows (16 bills, 2 incomes). Electricity is selected by default: ~$142.00, history Aug $118 / Sep $171 / Oct $137.

**Goals & planned expenses: `/goals`** (FR-04, Journey 3)
1. Header with a “New goal” primary button.
2. KPI row: Saving each month (hero style; the sum of monthly deposits, updated live), Saved so far, and Effect on safe to spend ($0, because transfers are scheduled on payday, after the window).
3. Main column: goal cards as a radiogroup (auto-fit, minimum 230, radio-card selected style). Each card has a kind overline and percent, a `heading-2` name, a progress bar, an amounts line, and a status chip (ok or attention). Below: a “Planned expenses ahead” table (Date, Expense with owner meta, Status chip, Amount).
4. Aside: the selected goal with a **stepper** for the monthly deposit (§4), a “Use $X a month to stay on track” button (`brand.soft`) when the goal is behind, the math breakdown, “Ask Jordan to approve”, and “Ask MoneyPilot”. Changes apply only after both partners approve.
- **Golden values:** $550 · $7,970 · $0 · Emergency fund 64% “Reached in Oct 2027” · Tahoe 48% “$250 behind” (suggests $313) · Holiday gifts 53% “$380 to set aside” (suggests $190).

**Household tasks: `/tasks`** (FR-05)
1. Header with the owner segmented control (on `bg.track`).
2. Add-task form card: title input, owner select (Sam, Jordan, Both), due date, and an “Add task” primary button. The form wraps on narrow widths.
3. Group cards: “Due this week”, “Later”, “Done”. Each row has a 20 px checkbox whose label is the title, then a meta line: the due date (attention chip when due within 7 days), the linked item as a 600 link, and the source (“Added by Sam”, “Suggested by MoneyPilot”, “From email”, “Renewal reminder”). The owner avatar sits on the right (S+J for Both). Done rows are struck through. An empty group shows the dashed empty state.
4. Aside: open tasks per owner, and “Where tasks come from”.
- **Golden values:** 3 due this week, 4 later, 3 done. The nav badge shows 3.

**Members & privacy: `/settings/household`** (FR-01, privacy NFRs)
1. Household card: name, primary income select (“sets your payday”), cushion, and plan (Family Plus · $7.99/mo · Billing link).
2. Members card: 40 px avatar, name, a meta line (role, connections, 2-step status) and a “Full access” ok chip. When 2-step verification is off, show an info chip and a “Remind {name}” button that turns into “Reminder sent” (ok style).
3. Connected data card: one row per source (each email connection, the forwarding address, CSV imports, and bank connection “Not available yet”) with a status chip and an action.
4. “What {partner} can see from your data”: switch rows. Footer: the partner never sees the inbox.
5. “Your data”: Export data (secondary), Leave… (secondary), Delete household… (destructive, §4).
6. Aside: “Our promises” (hero colors, 5 bullets) and an Activity log (latest 5 entries: action at 13/600, then actor · timestamp at 12 px muted, plus “Download full log”).

**Safe-to-spend states** (canvas board “Web · Safe-to-spend states”): the on-track and shortfall heroes side by side, the runway with negative bars, and the “Ways to cover the gap” card. See §5.3.

### 5.2 Mobile

**Today** (tab 1): header (stacked avatars, “Good morning, {name}”, household name, notifications icon button) → `heading-1m` “{N} days to payday” → hero (label, `display-l` amount, per-day caption, mini runway, “Lowest: $X on {date}, minus your $Y cushion” and a “The math” link) → attention card link (the top decision) → “Before payday” card (count and total in the header, the next 4 rows, then “See all {N} bills before payday”) → Goals link card (36 px icon tile, title, a summary line such as “$550 on Nov 6 · Lake Tahoe is $250 behind”, chevron; opens Goals) → Ask prompt pill (height 52, radius full) → tab bar.

**Bill detail:** top bar (back link to the previous screen and an “Edit” text button) → frequency tag (info.soft, 11/700 uppercase, radius xs) → `heading-1m` name → `amount-xl` amount with “Due {weekday, Mon D} · in N days” → a “Marked paid by {name}” ok chip when paid → “Why it’s flagged” attention card with a scenario comparison box (only when a flag exists) → “Who pays” segmented control (Sam / Jordan / Split, with an explanatory caption; Split = 50/50, both get reminders) → Reminders card (switch rows: 3 days before, on the due date, also remind the partner, plus a delivery caption) → Activity card → bottom bar with “Mark as paid” (primary; toggles to the secondary “Undo ‘paid’”) and the caption “MoneyPilot doesn’t make payments…”.

**Ask:** top bar (back, title “Ask MoneyPilot”, subtitle “Explains your plan. Never moves money.”) → conversation using the AI answer block (§4) → suggestion pills (height 40, border.strong, radius full) → composer (input height 46 radius full on `bg.subtle`, 46 px circular send button `brand.default`). Choosing an option updates the result banner. “Ask {partner} to approve” sends the plan change to the partner. It is not applied until they approve.

**Household setup** (Journey 1, step 3 of 4): “Step 3 of 4” and “Skip for now” → a 4-segment progress bar (height 4, gap 4) → `heading-1m` title and subtitle → a completed-steps card (check circles) → a method radiogroup: **Connect your email** (default, “Recommended” chip), **Import a bank CSV**, **Enter manually**, and a disabled dashed “Connect a bank · Coming later” tile → the panel for the chosen method (email: “Continue with Google” and “Continue with Microsoft” secondary buttons at height 48, the forwarding address, and 3 privacy bullets; CSV: detected items as checkbox rows with “Review N more”; manual: name, amount and repeats fields) → privacy caption → bottom bar CTA (“Connect and scan my inbox” / “Confirm N items and build my month” / “Continue to your overview”).

**Renewals** (tab 4): `heading-1m` title and add icon button → hero (“Everything that renews, per year”, `amount-xl` total, 3-column counts) → segmented control (Coming up / Insurance / Subscriptions) → grouped list cards (group label 12/700 uppercase: month name, or “Insurance · 5 policies”, or “Monthly · $X total”). Each row is a 36 px category tile (2-letter abbreviation, category color), name, sub-line, optional attention chip, and right-aligned cost plus frequency → automation caption.

**Calendar** (tab 2): month header (44 px prev/next circles, Manrope 800 22 title) → owner segmented control (3 equal segments) → month card. In the card: a weekday-initial row, then cells that are 50 px tall buttons with the day number in a 30 px circle (filled `brand.default` when selected) and up to 3 owner dots (6 px) below it. Payday cells use `brand.tint`. A legend row ends the card. → Selected-day list (group label; rows with a 10 px owner dot, name, owner, signed amount and kind chip; flagged rows link to bill detail) → 3 summary tiles (Income, Bills · 16, Left over).

**Goals** (opened from Today’s Goals card): back link to Today and a “New goal” icon button → `heading-1m` title → hero (“Saving each month” in `amount-xl`, next transfer reminder) → goal cards (title, percent, progress, amounts and monthly deposit, status chip, and an action link when behind; “Ways to catch up” opens Ask) → planned expenses list (date blocks) → caption saying transfers are reminders.

**Today, shortfall state:** the same layout as Today, with these changes:
- The hero becomes the shortfall variant (§4). Its mini runway hangs negative bars (`attention.markOnStrong`) below a `brand.onStrongMuted` zero line.
- The top attention card becomes “Why you’re short”: a cause sentence, “Ways to cover it” radio cards, a result status line, and “Decide with Jordan” (primary).
- The before-payday list includes the new planned expense.

### 5.3 Loading, empty, error, stale
- **Loading:** skeleton blocks in `bg.track` (radius xs) that match the final layout. Show them only after 300 ms. No spinners inside cards.
- **Empty:** a dashed `border.strong` box, radius xl, padding 20–24, centered `text.muted`, with one sentence about what will appear and how. Example: “All caught up. New bills and renewals will appear here as they arrive.”
- **Error:** an attention card with `role="alert"` saying what still works, plus one retry link. Never discard what the user entered.
- **Stale data:** every number from an import or connection shows its “Updated {date}” freshness on that screen (footer caption or source card).
- **Shortfall** (safe to spend < 0). It is drawn on the “Web · Safe-to-spend states” and “Mobile · Today, shortfall state” boards, and the fixture’s `scenarios.shortfall` has the values.
  - **Hero:** the shortfall variant (§4). The breakdown reads “Lowest projected balance −$293 on Nov 5 − Cushion $500 = −$793”.
  - **Runway:** negative bars hang below a solid `text.primary` $0 axis in `chart.lowest`, with their values in `attention.text`.
  - **“Ways to cover the gap” card:** up to 3 options, each recalculated with rule 9 and shown with an effect chip (ok when safe to spend ends up ≥ 0, info otherwise), then “Decide with Jordan”. Options come in this order:
    1. Move money from the emergency fund: the smallest multiple of $100 that gives at least $50 a day, capped at the fund balance.
    2. Split the expense that caused the shortfall into two halves, before and after payday.
    3. Move the largest bill in the window that could be moved to payday.
  - Options that depend on a third party carry “Only if … allows it”.
  - **Golden values:** $793 short · options $507 / $107 / “$109 short, never below $0”.

---

## 6. Calculation & behavior rules

All of these run in tested, deterministic code. AI never produces these numbers. Use integer cents throughout.

1. **Planning window:** today through the next date of the household’s *primary income* (Settings; defaults to the largest regular paycheck), inclusive. In the fixture that is Oct 27 → Nov 6, “10 days to payday”.
2. **Projected balance (runway):** start from the latest known balance (manual entry or the most recent CSV or bank balance). For each day, apply scheduled income, bills and planned expenses dated that day, giving one end-of-day value per day. Goal transfers scheduled on the window’s final payday belong to the next window.
3. **Lowest point:** the minimum end-of-day balance in the window, excluding the final payday.
4. **Safe to spend** = lowest point − cushion (default $500, editable). Display it floored to whole dollars. If it is below 0, use the shortfall state and show the shortfall rounded **up** to whole dollars (−$792.99 → “$793 short”).
5. **Per day** = safe to spend ÷ days to payday, rounded down to the nearest $5, shown as “≈ $X a day”.
6. **Estimates:** a variable bill uses the mean of its last 3 amounts. Its range is ±(max − min) ÷ 2 rounded up to the nearest $10. It is styled as an estimate until the actual amount arrives (from email, CSV or typed in), and then it is replaced. Credit cards use the last statement balance.
7. **Paid occurrences:** if the balance source is older than the paid date, the bill still counts in the projection. Once the balance source is newer than the paid date, it no longer counts.
8. **Flags:**
   - *Not in your usual month*: frequency is every 2 months or less often, and it falls in the window.
   - *Price up*: the new amount exceeds the previous term by at least $1 and at least 2%. It shows until reviewed or for 60 days.
   - *Possible duplicate*: two or more active subscriptions in the same sub-category.
   - *Decide by*: an email gives a deadline (enrollment, cancel-by).
   - *Not automatic*: the renewal doesn’t renew itself (for example, a registration).
9. **What-if:** “Pay on {date} instead” re-runs rules 2–4 with that one occurrence moved. The UI only shows it when it changes safe to spend, and always adds “Only if your provider allows it.”
10. **Goal suggestion:** ceil((target − saved) ÷ remaining contributions) to whole dollars, with one contribution per month on the first primary payday. Options to close a gap are: raise the monthly amount, move the date to the first month that closes the gap at the current amount, or lower the target to the projected amount.
11. **Renewals:**
    - *Yearly cost* = the sum of each item’s annualized cost.
    - *Big renewals, next 90 days* = items billed every 6 months or less often, dated within 90 days.
    - *Price increases* = annualized increase.
    - *Could save* = the annual cost of items the household marked as possibly unused. It never comes from an algorithm’s guess.
    - *Shop-around date* = renewal − 30 days.
    - *Reminders* go out 30 and 7 days before plus on the day for items billed every 6 months or less often. Monthly subscriptions only get a reminder when the price changes.
12. **Reminders:** sent to the owner, or to both when the owner is Split or Both. The dedupe key is (item, occurrence date, offset). Delivery is tracked, and failures appear in Notifications.
13. **Owner filters:** a partner’s filter includes their own items plus items owned by Both.
14. **Email capture:**
    - Only the mailbox owner can connect or disconnect it. Partners see the extracted items, never the emails.
    - An item is applied automatically only when it matches a confirmed item (same sender and account last 4) with an identical amount, or with an actual amount for an estimated bill. Everything else goes to the review queue.
    - Automatic changes can be undone for 30 days and are listed under “Applied automatically”.
    - Store the extracted fields and the message ID, never the email body.
15. **Tasks:** “Due this week” means due within 7 days of today, inclusive. The Tasks nav badge counts open tasks in that group. A task can carry an auto-complete condition (for example, the actual bill amount arrives). When that happens it completes itself, and the activity log records what completed it.
16. **Goal status:**
    - *Reach month* = the month of the n-th deposit, where n = ceil(remaining ÷ monthly deposit). Deposits start on the next primary payday (Nov 6 in the fixture).
    - A goal with a target date shows “On track for {date}” or “$X behind”. A planned expense shows “$X to set aside”. Suggestions follow rule 10.
17. **Averages on Bills & recurring:** biweekly income × 26 ÷ 12. Bills paid every n months ÷ n. Estimates use their current estimate.

---

## 7. Content & formatting

| What | Rule | Example |
|---|---|---|
| Money in tables, lists and detail | en-US, $, 2 decimals | $2,150.00 |
| Money in hero and KPI tiles | Whole dollars (bill totals keep cents) | $1,007 · $4,792.99 |
| Sign | Outflows use “−” (U+2212) in mixed lists and charts. Income uses “+” in `income.text`. Bill tables have no sign. | −$389.00 · +$2,900.00 |
| Estimates | “~” prefix plus a range chip | ~$142.00 · Estimate ±$30 |
| Dates | “Nov 4” in the current year, otherwise “Jan 9, 2027”. Add the weekday where timing matters. Relative time is secondary. | Wed, Nov 4 · in 8 days |
| Masking | Last 4 digits only. Emails masked after 3 characters. | •••4821 · sam•••@gmail.com |
| Voice | Plain, short, sentence case. Offer options, never “you should”. No exclamation marks or emoji. | “Ways to close the gap” |
| Names | Use people’s first names (“Jordan’s pay”), never “Partner 2”. | |
| AI | Always say that AI wrote it and name the sources. | “Calculated by MoneyPilot’s planning rules from… AI wrote this summary.” |

---

## 8. Accessibility (WCAG 2.2 AA)
- Verified contrast (Harbor): text.primary/surface 17.2 · text.muted/surface 6.3, /canvas 5.7 · white/brand.default 8.7 · brand.onStrongMuted/brand.strong 9.4 · brand.onSoft/brand.soft 9.1 · attention.text/attention.soft 6.2 · info.text/info.soft 7.4 · income.text/surface 5.4 · income.onSoft/income.soft 5.7 · partner avatar text 6.9 (A) and 7.9 (B) · chart.balance and chart.lowest against surface 3.8 and 3.9, partner dots 5.2 and 5.5 (graphics only). Don’t introduce a new pair without checking it.
- Touch targets are at least 44, and every control shows the focus ring. Keyboard order follows the visual order. The calendar grid supports arrow-key movement.
- Icon-only buttons get an `aria-label`. Decorative SVGs get `aria-hidden`. Groups get `role="group"` with a label. Live updates use `role="status"`, and errors use `role="alert"`.
- Support 200% text zoom (web) and Dynamic Type or font scaling (mobile) without clipping amounts. Amounts may wrap below their labels.

---

## 9. Design QA checklist (every UI PR)
- [ ] Uses tokens only. No new hex, px font size, radius or shadow.
- [ ] Matches the canvas screen at 1440, 1024 and 390 widths. Attach screenshots next to the canvas frames.
- [ ] Loaded with `design/fixtures/rivera-household.json`, it shows the golden values from §5 and `expected`.
- [ ] Every amount uses tabular figures and follows §7.
- [ ] Amber appears only on decision items. Partner colors are correct.
- [ ] Loading, empty and error states exist (§5.3).
- [ ] Keyboard, focus ring, screen-reader labels and 44 px targets checked.
- [ ] No action moves money. AI text shows its sources.
