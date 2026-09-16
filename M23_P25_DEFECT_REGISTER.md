# M23 P2.5 — Defect Register

Defects found while auditing and rebuilding the navigation and page chrome.
Each entry names the evidence, the cause, the fix and the test that now
guards it. Severity: **S1** blocks a user journey; **S2** degrades one;
**S3** is cosmetic or a test-only coupling.

| id | sev | surface | defect (as found) | root cause | fix | guard |
|---|---|---|---|---|---|---|
| D1 | S1 | Grassroots, ≤ 860px | The mobile navigation drawer opened as a **row**: sections laid out horizontally inside a 260px off-canvas panel, so most of them were unreachable without sideways scrolling inside the drawer. | Two responsive rules were both live between 861px and 900px and the 860px block was never retired when the M15-Nav drawer (900px) arrived: the older `@media (max-width: 860px)` strip turned `.sidebar` into `flex-direction: row`, and the M15-Nav drawer rule positioned that same row off-canvas. | The 860px strip rules for `body`, `#root`, `.shell`, `.sidebar`, `.main`, `.topbar`, `.content` and `.nav-badge` were deleted (content-level responsive rules kept). The drawer is a column at every width. | navLive N5/N6 (drawer `flex-direction: column`, no horizontal overflow); `drawerCheck` measurement 390px. |
| D2 | S1 | Pro + Grassroots, phone | The top bar consumed **202px** (Pro) / 157px (Grassroots) at 390px: title, five organisation pills, live pill, bell and the Report / Block button wrapped into four rows before any content. On the Inbox the first meaningful element began at 388px. | The organisation's standing badges were rendered in the top bar on every page; nothing in the bar was allowed to shrink. | `TopBar` primitive: one row, the page `h1`, a live-state dot, the bell and Report / Block (glyph-only under 640px, same accessible name). `OrgChips` moved to the sidebar account block. | navLive N5 (top bar ≤ 64px at 420px); `chromeMetrics` 202 → 54px. |
| D3 | S2 | Pro + Grassroots, desktop | Every page inside a multi-page section carried a **second navigation bar** (45px) listing the section's destinations — 15–16 tabs for Recruitment, 2,025–2,127px wide, 12–13 of them off-screen on a phone. | The M15-Nav secondary tab row listed the whole section; Recruitment had grown from 8 to 15 pages. | The strip is hidden above 900px (the sidebar accordion lists the pages, grouped). On phones it lists only the active **group** (≤ 7). | navLive N1 (no `.subnav` on desktop), N5/N9 (strip = group siblings only); navConfig (≤ 7 per group). |
| D4 | S2 | 17 screens × 2 apps | Each screen rendered an `<h2>` repeating the title the top bar already showed — 28px of duplicate chrome per page, and two headings with the same text for a screen reader. | Screens predated the M15-Nav top bar title and were never trimmed. | Removed (34 headings). The top bar `h1` is the page title; the Second Look compare title (a sub-section) stays. | navLive N1 (`.content h2` count 0, exactly one `h1`); m19Live anchors on the `h1`. |
| D5 | S2 | Recruitment Room | The Room header was **8 stacked rows / 336px** on a desktop and 653px on a phone: identity, conflict, trust block (4 lines), 8 badges, tags, a 4-control action row, a priority note, an add-tag row and a tag note — before the Room's own tabs. | Every control and every fact was given its own row. | Identity row (name · position/age/club · status/priority/health/restricted pills · Move to + Apply · Open profile), a two-line trust block that keeps the disclaimer and the no-ranking statement, and one **Room details** disclosure holding lead/owner/updated/source, priority, lead, restricted, tags. | `roomMetrics`: 336 → 141px desktop, 653 → 357px phone; m17/m18/m181/m182/m23 Live suites (status moves, badges, disclaimer) unchanged. |
| D6 | S3 | 15 screens × 2 apps | Leading explanatory prose (40–110px per page) described the page rather than stating a constraint. | Copy written for first-time visitors was shown on every visit. | Classified per page (`M23_P25_HEADER_PROPOSAL.md` §4): removed where it described the page; reduced to a one-line `.pagehint` where it states a material constraint (append-only, no direct channel, guardian routing, no scores, gate notes). Status warnings kept. | `chromeMetrics`: meaningful content at 80px on every desktop page (was 88–212). |
| D7 | S3 | Player app | Five tabs were **Home / Inbox / Profile / Upload / You** with the You tab holding 14 sections including the five football features shipped since M15 (Passport, Development, Box Cam, Combine, Trust). Upload — an action — occupied a bar slot. | Deferred follow-up recorded in `NAVIGATION_ARCHITECTURE.md` §5 (M15-Nav) and never taken. | Home / Football / Opportunities / Inbox / You; page tabs on Football and You; `+ Add evidence` action; `/profile` and `/upload` kept as routes. | navLive N7; player Live and demo suites migrated and green. |
| D8 | S3 | Grassroots nav | A one-page **Network** section and a **Team** label that did not describe what a grassroots club manages. | Section map copied from Pro. | Team → **Players**; Network folded into **Club** with Clubs & Groups visible to every role (unchanged visibility). | navConfig (coach sees Club with exactly `network`); navLive N6. |
| D9 | S3 | Palette | Search rows showed section › page only; with 22 pages under Recruitment the group was needed to tell Assessments (Evidence) from the Pipeline. | No group concept existed. | `searchNav` rows carry `groupLabel`; the palette shows section › group › page. | navLive N3. |
| D10 | S3 | Sidebar accordion (found by navLive N10 during P2.5) | Folding the **active** section with its chevron, then navigating to another page inside it, left the active page hidden in a closed accordion. | The re-open effect depended on the section id only. | Any navigation (section or page) re-opens the destination's section. | navLive N10. |
| D11 | S3 | Test coupling | `m14DemoSpotcheck` clicked the desktop tab strip; `m19Live` anchored on the in-content `h2`; ten player suites navigated to sections by the old You tab. | Tests coupled to chrome rather than to destinations. | Selectors migrated: sidebar child, top bar `h1`, new tabs + `getByRole('tab')`. | The suites themselves. |

## Not defects (considered and left)

- **Trials & Reports warning** ("N trials awaiting a mandatory report") is
  status, not prose; kept as is.
- **Second Look and Room trust disclaimers** are deliberate product honesty
  asserted by m17/m18/m181/m182 suites; kept, compacted.
- **T&S console**: a 66px top bar and a flat tab row over six groups is
  already compact; grouping further would not improve operator efficiency.
- **Pipeline phone strip** (6–7 tabs) still scrolls by 2–3 tabs at 390px.
  The group cap is 7 by design; splitting Pipeline would invent a category.
  Recorded in `NAVIGATION_ARCHITECTURE.md` §16.

## Frozen recruitment lifecycle

No defect in this register touches `scoutbox-server`. The lifecycle
validator, the journey projection, stores and routes are byte-identical to
the P2 tip (`git diff bf069b1 -- scoutbox-server` is empty). No regression
in the frozen semantics was exposed by the navigation work.
