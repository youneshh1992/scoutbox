# M24F.4 — Minimal product rules

These rules govern every screen of the five applications from M24F.4 onward. They
extend the M24F.3 one-line rule (`M24F3_MINIMALISM_RULES.md`) from density to
structure: what a root screen is allowed to be made of, and where everything else
goes. They are enforced by `e2e/m24f4MinimalismAudit.test.mjs` (source),
`e2e/m24f4PlayerMinimalLive.test.mjs` and `e2e/m24f4PortalMinimalLive.test.mjs`
(rendered), and reviewed in `M24F4_ALL_APP_SCREEN_AUDIT.md`.

## 1. Three levels

| Level | What it holds | Form |
| --- | --- | --- |
| L1 — root | The identity of the screen, the one current action, the primary facts, the ways in | Rows: PRIMARY line + at most ONE secondary line + a chevron / Open / View |
| L2 — after one tap | The detail of a row: the list, the record, the form, the actions | A page or a Disclosure under the row, with its own back control |
| L3 — technical / history / policy | Provenance, policy versions, limitations that are not safeguarding, machine strings | A further row ("About …", "History", "View terms") |

A root screen never shows L2 content. A row never carries more than one secondary
line. Information is never removed; it moves down one level and keeps its test id.

## 2. Text budgets (visible UI words on the root)

| Surface | Budget | Measured by |
| --- | --- | --- |
| Player root (Home, a Football tab, a Profile section, Explore, an Opportunity category) | 80–120 words; the live suite allows up to 130 (Home) / 150 (Passport) | `m24f4PlayerMinimalLive` |
| Portal root (a sidebar destination) | 120–180 words; list roots up to 300, search grids up to 420 | `m24f4PortalMinimalLive` |
| Paragraphs (text runs over 140 characters) on a root | 0 — except the accepted sentences below | both live suites + the audit |

Accepted long sentences on a root: a legal or consent statement that must be read
in full before an act; a safeguarding statement; an error; the one governing
sentence of a screen that tests protect (the Director Dashboard principle, the
Nobody Missed "not a score" line, the Second Look "does not judge" line). Each one
is named in the audit's fix column.

## 3. Rows

- 80 % or more of navigation and settings rows carry **no** sub-note. A sub-note is
  allowed only when it is a value (a count, a state, a date), never an explanation.
- A row that leads somewhere ends in a chevron (`›`), the word **Open**, **View** or
  **Details**. Never "Click here", never a bordered button for navigation.
- Timestamps are human: "Now", "2m", "Yesterday", "3 Oct", "3 Oct · 20:45". Seconds
  never appear (`time.ts` / `design-system/time.ts`). Dates the server sends as
  ISO are rendered through `humanDate`.
- An action that is the one thing to do on the screen is the only bright primary
  button. Secondary actions are tertiary or text (`.linklike`, `DetailLink`).

## 4. Borders, cards, pills

- No border around static text. Read-mode values are text (the Grassroots radar
  line, a squad name, a status word). An input border appears only while editing.
- Cards are exceptional: a search-results grid, a hero (the Box Cam visual, the
  latest clip), a sheet. Never card-in-card. A section is a hairline, not a box.
- Pills are for a state the eye must find at a glance: at most three on a card,
  one on a row. Everything else is a quiet line (`.badges-quiet`, `Muted`).
- Hover and focus states tint the row (`--sb-wash`) and draw a 2 px focus ring; no
  giant borders.

## 5. Typography and imagery

- Inter is the computed face on every screen of every application. The only
  exceptions: the ScoutBox wordmark (Albert Sans) and machine strings (share
  URLs, the environment line) in monospace. `-apple-system`, Arial, Helvetica and
  Albert Sans are never a primary face.
- Zero emoji in product UI. State glyphs (✓ ✕ ○ ➤ ▲) are typographic, not pictographic.
- Imagery leads where real or demo-safe imagery exists: avatars from initials,
  club crests, the first frame of a clip, the Box Cam visual. No stock images;
  a missing image is a quiet frame with the mark of its kind, never a fake photo.

## 6. Numbers and visuals

- Every count, rate, percentage and median on screen is the server's. A visual
  (ring, bar) is drawn from those numbers and prints them beside itself. The client
  never derives a score, a rank or a rate of its own.
- A withheld figure, an empty period and a zero stay distinguishable in words.
- Charts are bars and rings in one ScoutBox colour (`--sb-green-text` on light,
  the same token on dark); no rainbow, no 3D, no card per metric.

## 7. Copy

- Zero paragraphs on roots. One sentence at most under a heading, and only where it
  changes what the reader does.
- Technical copy (provenance words, policy versions, provider notes, record ids)
  lives at L3 behind "About …".
- Safeguarding copy is compressed to one sentence plus "Learn more": "You control
  who can contact you. Learn more".
- Bottom navigation: five items at most. Category and tab bars: five at most.

## 8. What stays as it was

Explore (the Player's opportunity board and fit), the Profile sections (Overview,
Performance, Journey), the M24E sign-out and scroll model, the Grassroots light and
dark schemes, the Agent gold navigation, the ™ spacing and the max-5 navigation are
kept. Only budget, Inter, accessibility and obvious clutter were touched on them.

## 9. Where the rules are enforced

| Rule | Gate |
| --- | --- |
| Home header (no greeting / date / "View your Passport" / "Verified clubs can see you"; Joined only from a real date) | `m24f4MinimalismAudit` 1, `m24f4PlayerMinimalLive` Home |
| Roots carry no helper strings; Combine names only; Box Cam session-led; Offer document; Evidence media-led | `m24f4MinimalismAudit` 2, `m24f4PlayerMinimalLive` |
| No seconds, Inter only, zero emoji | `m24f4MinimalismAudit` 3, both live suites, `m24fVisualAudit` |
| Radar read mode without an input border; squad rows without a name chip | `m24f4MinimalismAudit` 4, `m24f4PortalMinimalLive` |
| Nobody Missed as a coverage tool; Director Dashboard executive layer with every limitation | `m24f4MinimalismAudit` 5, `m24f4PortalMinimalLive`, `m18Live`, `m20Live` |
| Every crawled screen classified, no failing screen without a fix or an accepted reason | `m24f4MinimalismAudit` 6 against `M24F4_ALL_APP_SCREEN_AUDIT.md` |
