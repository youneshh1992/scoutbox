# M24F.3 — Minimalism rules (all five applications)

These rules apply to ScoutBox Pro, Grassroots, Agent, Trust & Safety and the Player /
Guardian app. They are enforced by `e2e/m24f3DensityAudit.test.mjs` (source gate),
`e2e/m24f3MinimalLive.test.mjs` and `e2e/m24f3InboxLive.test.mjs` (browser), and
measured screen by screen in `M24F3_SCREEN_DENSITY_AUDIT.md`.

## 1. The one-line information rule

Every item on a root screen is **one primary line**, optionally **one secondary line**,
and — only when there is more to know — a **"View details"** control. Nothing else.

- A primary line is a fact: a name, a status word, a date, a count.
- A secondary line is at most one short qualifier (club · date · distance · state).
- Anything that explains, justifies, warns, cites policy or describes provenance is
  not a line. It goes behind a control.

## 2. Progressive disclosure — three levels

| Level | What it holds | How it is reached |
| --- | --- | --- |
| 1 — root | the fact and the one action that matters now | the screen itself |
| 2 — details | the full message, the breakdown, the reasons, the evidence counts | **View details / View breakdown / View evidence / View full message / Why / About …** |
| 3 — deep | the record, the thread, the document, the policy text | a link from level 2 |

Portals implement level 2 with `design-system/About.tsx`:

- `Hint` renders a page hint. Text up to **140 characters** shows in place; longer text
  folds behind an **About** control (`<details class="f-about">`). Server-provided
  notes, disclaimers and "honest" lines go through the same component, so the screen
  does not need to know how long the server's text will be.
- `About` wraps any static block that is an explanation.

The Player implements level 2 with `Disclosure` (`components/ui.tsx`) and the
row primitives `FactRow`, `PreviewRow`, `EventRow` and `DetailLink`.

## 3. What a root screen may not carry

- No paragraph (a rendered text run longer than 140 characters).
- No policy, provenance or technical language: "policy version", "projection over
  source records", "append-only ledger", "no background scheduler", "Where is this
  from?".
- No full disclaimer. One word ("Verified", "Pending") or one short line is the
  limit; the disclaimer lives behind **About**.
- No card stacks. A list is a ruled list of rows, not a column of boxes.
- No decorative pills. A pill marks a meaningful state only: Trial, Offer, Signed,
  Verified, Pending, Request.
- No machine time. Times read Now / 2m / 1h / Yesterday / Mon / 3 Oct, or
  "3 Oct · 20:45" where the minute matters. Seconds never appear. (`scoutbox-player/
  src/time.ts`, `design-system/time.ts`.)

## 4. Specific screens

- **Inbox** — conversation rows (avatar · name · one-line preview · time · unread dot);
  tabs All / Unread / Requests; Request / Trial / Offer / Signing labels with their
  accents; the trial accent is warm gold and always carries the word "Trial". Request
  detail: Accept / Decline visible; message, venue and instructions behind "View full
  message". See `M24F3_INBOX_DESIGN.md`.
- **Football Passport root** — verified status, current club, availability, evidence
  in one word, a four-row timeline preview. Disclaimer behind "About Passport";
  a conflict is one line with a Review control; counts behind "View evidence";
  provenance inside each opened timeline row; achievements as plain rows.
- **Trust Score root** — the score, the band, "Evidence confidence only", "View
  breakdown". Policy version, strengths, gaps and the demo note sit inside.
- **Opportunity board** — one row per opportunity: title / club · date · distance /
  state word. Description, requirements and Apply behind "View details".
- **Opportunity fit** — one line and "Check fit"; verdict words per dimension; the
  reasons behind "Why".
- **Safeguarding copy** — "You control who can contact you. Learn more →".

## 5. Allowed exceptions (and why)

- **Consent and confirmation wording** must be read in full before it is given
  (dual-representation consent, transaction party confirmation, legal flows). It stays
  visible.
- **Governing sentences under test contract** (the m20 dashboard principle, the m18.2
  Discover ordering statement — shortened to one line, the Agent development-provider
  notice) stay where their suites assert them.
- **Notification bodies** are content, not explanation; they render one row each and
  the acknowledgement control sits behind the row.
- **Message previews** are clipped to one line (`numberOfLines=1`); the full text opens
  in the thread.

## 6. How to keep it this way

1. Add no `<p className="pagehint">` or `<div className="notice">` with more than 140
   characters outside `Hint` / `About` — the source gate fails the build.
2. Add no `toLocaleString()` / `toLocaleTimeString()` — format through `time.ts`.
3. A new Player explanation goes in a `Disclosure`; a new row goes through
   `FactRow` / `PreviewRow` / `EventRow`.
4. Re-run the density crawl after a screen change and update
   `M24F3_SCREEN_DENSITY_AUDIT.md`; the gate refuses an unaccepted TOO DENSE row.
