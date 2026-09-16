# M23 P2.5 — Header & Top Bar Audit

> Every recurring top bar and page header, what it contains, what it costs in
> vertical pixels, and what on it is redundant.

Measured at tip `bf069b1` in Chromium from the demo bundles (§39/§88). Heights
are from `getBoundingClientRect()`.

---

## 1. The recurring chrome, per app

### 1.1 Pro / Grassroots shell (`App.tsx` inline; `styles.css`)

```
┌ .topbar  (14px 22px padding, bg-2, border-bottom) ─────────────────────────┐
│ [☰] h2 "Section / Page"  [Trusted Partner][🛡 Safeguarding][Verified club] │
│                          [club][● live sync]                 [🔔] [⚑ Report / Block] │
├ .subnav  (8px 22px 0; buttons 8px 12px 10px; horizontal scroll) ──────────┤
│  Child · Child · Child · Child · … (up to 16)                              │
├ .content (22px padding) ───────────────────────────────────────────────────┤
│  [optional .notice prose block, 62–110px]                                  │
│  [optional duplicate <h2> page title]                                      │
│  content                                                                   │
```

| component | desktop height | phone height | content rows | duplicated information |
|---|---:|---:|---|---|
| `.topbar` | 66 (71 on Rooms) | **202 Pro / 157 Grassroots** | 1 (3 when wrapped) | the crumb repeats the sidebar's active section; the page label repeats the active tab; org pills repeat the account block's org line |
| `.subnav` | 45 | 45 (2025px wide) | 1 | it is the section's child list — the same list the sidebar would show if it showed children |
| `.content` top padding | 22 | 14 | — | — |
| leading `.notice` | 62–110 | 94–110 | 1 | permanent prose that describes the page |
| screen-level `<h2>` | ~28 | ~28 | 1 | the page name, already in the top bar |

**Stacked chrome before content, desktop:** 66 + 45 + 22 = **133px** on a
normal page; **211–212px** where a notice leads; **584px** on a Room.
**Phone:** 247px on every Pro page before any content; 388px on Inbox;
**1024px** on a Room.

### 1.2 Player tab screens

| element | height | notes |
|---|---:|---|
| `SafeAreaView` top inset | device | — |
| scroll padding | 18 | every tab |
| `h1` row | 26px/800 + 6 margin ≈ 40 | with `NotificationBell` + `ReportButton` on Home/Upload/You |
| Profile header row | ≈ 44 | `‹` back + `⋯` menu round buttons, then identity block |

Not elongated. The Player problem is structural (14 sections under "You"),
not a tall header.

### 1.3 T&S

`.topbar` 66px: `h2` "Group / Tab" · demo pill · Refresh. Compact; the only
duplication is the crumb. **Left as is** apart from the shared title
semantics.

## 2. Page-by-page inventory (§24)

`title` = what the user sees as the page name; `own h2` = the screen renders
a second title inside content; `intro` = a leading explanatory `.notice`.

### 2.1 Pro

| route / page | own h2 | intro (chars) | filters in header | primary action | secondary actions | status badges | search | desktop → phone chrome | classification |
|---|---|---|---|---|---|---|---|---|---|
| `#/feed` Home | — | 141 "What changed since you last looked…" | — | — | — | — | — | 66→202 | **remove intro**: describes the page |
| `#/search` Players | — | — | `.filters` 71px (5 inputs) | — | — | — | text | 111→247 | filters belong to content; fine |
| `#/shortlist` | — | — | — | — | — | — | — | | fine |
| `#/filmroom` | — | — | — | — | — | — | — | | fine |
| `#/opportunities` | — | — | `.filters` (create form) | Publish | — | — | — | | fine |
| `#/campaigns` | — | `camp.fileVsHuman` | `.filters` | — | — | — | — | | **shorten intro** |
| `#/insight` | **yes** | — | — | — | — | — | — | | **remove h2** |
| `#/ledger` | — | 130 "Append-only. Every action…" | — | — | — | — | — | | **keep 1 line**: material constraint |
| `#/recruitment` Cases | — | — | `.filters` (new-case) | New case | — | — | — | 111→247 | fine |
| `#/rooms` list | **yes** "Recruitment Rooms" | — | saved-view tabs + search | New room | — | — | text | 116→247 | **remove h2** (third rendering of the name) |
| **`#/recruitment/rooms/:id`** | `h3` player name | — | — | Open player profile | change status (inline form) · priority · lead · tags | **11 pills** | — | header 336→653 | **condense** — see §3 |
| `#/recruitment/second-look` | **yes** | disclaimer | — | — | — | — | — | | **remove h2**; disclaimer stays (asserted, and honest) |
| `#/recruitment/nobody-missed` | **yes** | — | brief picker | — | — | — | — | | **remove h2** |
| `#/briefs` | **yes** | — | — | New brief | — | — | — | | **remove h2** |
| `#/recruitment/matching` | **yes** | — | criteria editor | Run | Save as watchlist | — | — | | **remove h2** |
| `#/recruitment/watchlists` | **yes** | — | status filter | New watchlist | — | — | — | | **remove h2** |
| `#/recruitment/dashboard` | **yes** "Director Dashboard" | — | `card` filters | — | drill-downs | — | — | | **remove h2** |
| `#/assessments` | — | — | `.filters` toolbar | — | — | — | — | | fine |
| `#/video` | — | "Annotations are private…" | — | — | — | — | — | | **keep 1 line** |
| `#/trials` | — | conditional warning "N trials awaiting a report" | — | — | — | — | — | | **keep**: it is status |
| `#/trialdays` | — | `day.gateNote` | — | — | — | — | — | | **keep 1 line** |
| `#/requests` | — | 190 "There is no direct message channel…" | — | — | — | — | — | | **keep 1 line**: safeguarding constraint |
| `#/outcomes` | — | "Follow-ups are scheduled…" | — | — | — | — | — | | **shorten** |
| `#/funnel` | — | 129 "…The numbers are the numbers." | — | — | — | — | — | | **remove intro** |
| `#/messages` Inbox | — | 160 "Threads open only when…" | — | — | — | — | — | 66→202; meaningful **212→388** | **keep 1 line**: safeguarding constraint |
| `#/planner` | — | `planner.noScores` | — | — | — | — | — | | **keep 1 line**: honest constraint (no scores) |
| `#/coverage` `#/calibration` | **yes** | — | — | — | — | — | — | | **remove h2** |
| `#/fixtures` | — | 150 "Scout by match…" | — | — | — | — | — | | **remove intro** |
| `#/network` `#/representation` | **yes** | rep: `data.note` | — | — | — | — | — | | **remove h2**; note stays (server-provided) |
| `#/organisation` | **yes** | — | — | — | — | — | — | 111 (content 2111px tall) | **remove h2** |
| `#/verification` | **yes** | dim one-liner | — | — | — | — | — | | **remove h2** |
| `#/imports` `#/budgets` | **yes** | bud: `m13.bud.note` | — | — | — | — | — | | **remove h2** |
| `#/plan` `#/reputation` | — | — | — | — | — | — | — | | fine |

Totals: **13 screens render a duplicate `<h2>`**; **9 screens open with
permanent explanatory prose** (62–110px), of which 4 are pure description and
5 state a genuine constraint worth one compact line.

### 2.2 Grassroots (additional pages)

| page | own h2 | intro | classification |
|---|---|---|---|
| `#/squad` | — | 175 "Your squad in one place: who you have, where you're thin…" | **remove intro** (the stat grid says it) |
| `#/opendays` | — | 140 "Open days are how kids find their first team…" | **shorten to 1 line** |
| `#/friendlies` | — | 150 "Trial matches are how grassroots scouting actually happens…" | **shorten to 1 line** |
| everything shared with Pro | as Pro | as Pro | as Pro |

## 3. The Recruitment Room header — measured (§81)

`roomsScreens.tsx` `RoomHeader`, `aria-label="Room header"`, a `.section` with
**8 stacked rows**:

| row | content | approx height |
|---|---|---:|
| 1 | `h3` player name · "CB · 22 · Lagos City FC" · **Open player profile** button | 34 |
| 2 | conflict notice (conditional) | 0 |
| 3 | unavailable notice (conditional) | 0 |
| 4 | **Trust Score**: label · **64** (26px) · /100 · band pill · demo pill | 36 |
| 5 | disclaimer line · `TrustNote` · "never sorts or ranks" line | ~54 |
| 6 | **8 pills**: Status · Priority · Room lead · Owner · Health · Restricted · Updated · Source | 38 (wraps to 76 at 390) |
| 7 | tags (conditional) | 0–30 |
| 8 | **actions**: Change status `select` + reason picker + note + button · priority `select` · lead `select` · tag input | ~110 (wraps to ~250 at 390) |

Total **336px desktop / 653px phone**, then the room's own 9 tabs (41px), then
content. This header is the page Contact, Trials and Offers will add to.

What is wrong with it, specifically:

- Row 6 puts eight facts in identical pills. Status and Priority are the two
  a scout scans for; Owner, Updated and Source are metadata.
- Row 8 is a permanently-open **form** in a header. Changing status is the
  primary action; the reason picker and note belong to the moment of changing
  it, not to every visit.
- Rows 4–5 spend ~90px on a number and three sentences of disclaimer. The
  disclaimer and the no-ranking statement are deliberate product honesty and
  are asserted by `m17DemoSpotcheck`; they must remain visible in page text —
  but they can be one muted line rather than three.

## 4. Stacked-chrome summary (§38/§39)

| representative page | before, desktop | before, phone |
|---|---:|---:|
| Pro Home | 88 | 216 |
| Pro Discover → Players | 133 | 261 |
| Pro Recruitment Room | **584** | **1024** |
| Pro Squad Planner | 133 | 261 |
| Pro Organisation | 133 | 261 |
| Pro Inbox | 212 | 388 |
| Grassroots Squad | 211 | 342 |
| Player Home | h1 at ~44 below safe area | same |

## 5. Header components (§43)

There is **no header component**. The top bar is inline JSX duplicated in
`scoutbox-club/src/App.tsx` and `scoutbox-grassroots/src/App.tsx` (identical),
and a third copy in `scoutbox-admin/src/App.tsx`. Screen titles are ad-hoc
`<h2>`s; intros are ad-hoc `.notice` divs; the Room header is bespoke.
`styles.css` differs between Pro and Grassroots by 72 lines, none of them in
the chrome rules. No spacing tokens exist: `:root` defines colours only;
`14px 22px`, `8px 22px 0`, `10px 12px` are repeated literals.

## 6. Sticky layers (§37)

`.main` is `overflow: hidden` with `.content { overflow-y: auto }`, so the top
bar and tab strip are effectively sticky by layout, not by `position: sticky`.
Grassroots' 860px rule additionally makes the sidebar `position: sticky; top:
0` as a horizontal strip — the second half of defect P7. Nothing else is
sticky. The Room header scrolls with content.
