# M23 P2.5 — Header Proposal (before → after)

> For each changed header: its structure and height before, what was wrong,
> its structure and height after, what was removed or moved, and which actions
> were preserved. Heights are measured (`M23_P25_HEADER_AUDIT.md`), targets
> are estimates verified after implementation.

---

## 1. The Pro / Grassroots top bar — every page

**Before** (66px desktop / **202px** Pro, 157px Grassroots at 390px):

```
[☰] h2 "Section / Page" [Trusted Partner] [🛡 Safeguarding Certified] [Verified club] [club] [● live sync] [🔔] [⚑ Report / Block]
```

**Problems.** Five pills that never change per page, so the bar says the same
thing on every screen; at phone width they wrap to two extra rows. The title is
an `h2` and the page has no `h1`. The crumb repeats the sidebar's active
section.

**After** (~48px desktop / ~48px phone, one row):

```
[☰] h1 "Page"  (section crumb kept, muted)              [● live] [🔔] [⚑ Report / Block]
```

| removed / moved | to where |
|---|---|
| Trusted Partner · Safeguarding Certified · Verified / pending · org type | the sidebar **account block**, as one compact chip row under the org name — they describe the organisation, and that is where the organisation is named |
| "● live sync" pill text | a **dot** with `aria-label` / `title`; the red *reconnecting* pill keeps its text because it is a state the user must act on |

| preserved | how |
|---|---|
| Report / Block | stays in the bar, full label on desktop, glyph + `aria-label` under 640px; never hidden (§33) |
| Notifications | unchanged |
| hamburger | unchanged |
| title semantics | becomes the page `<h1>` (§47); the crumb stays inside it, muted |

## 2. The page tab strip (`.subnav`) — every page with siblings

**Before:** 45px band, 4–16 tabs, horizontal scroll, 2,025px wide at 390px.
**After:** **removed on desktop** (the sidebar accordion lists the siblings);
at ≤900px a compact strip lists the active *group's* siblings only (≤6 tabs,
~38px, no overflow). T&S keeps its strip.

## 3. Duplicate page titles — 13 screens

Insight · Rooms list · Second Look · Nobody Missed · Briefs · Matching ·
Watchlists · Director Dashboard · Coverage · Calibration · Clubs & Groups ·
Representation · Staff & Security · Verification · Integrations · Finance each
render `<h2>{same text as the top bar}</h2>` as their first child.

**After:** removed. The top bar `h1` is the title. Where a screen's `h2` was a
test anchor (`m19Live`: "Player Matching"), the test anchors on the `h1`.
~28px returned per page.

## 4. Leading explanatory prose — classified page by page (§30)

| page | before (px) | decision | after |
|---|---:|---|---|
| Home | 62 | describes the page | **removed** |
| Fixtures | 62 | describes the page | **removed** |
| Funnel | 62 | "the numbers are the numbers" | **removed** |
| Grassroots Squad | 62–110 | the stat grid already says it | **removed** |
| Discovery Ledger | 62 | *append-only* is a material constraint | one-line `.pagehint` |
| Player Requests | 62 | *no direct message channel; U18 → guardian* is a safeguarding constraint | one-line `.pagehint` |
| Inbox | 62 | *on-platform, moderated, logged; U18 → guardian* | one-line `.pagehint` |
| Squad Planner | 40 | *no scores* — an honesty statement | one-line `.pagehint` |
| Evidence & Video | 40 | *annotations are private* | one-line `.pagehint` |
| Trial Days | 40 | gate note | one-line `.pagehint` |
| Campaigns · Outcomes · Finance · Grassroots Open Days / Friendlies | 40–62 | mixed | one-line `.pagehint` |
| Trials & Reports | conditional | "N trials awaiting a mandatory report" is **status** | kept as is (it is a warning, not prose) |
| Second Look disclaimer · Room trust disclaimer | — | deliberate product honesty, asserted by suites | kept, compacted |

`.pagehint`: 12.5px, muted, no box, one line, 10px margin — ~22px instead of
62–110px.

## 5. The Recruitment Room header (§81)

**Before** — `.section`, 8 rows, **336px desktop / 653px phone**; then the
room's 9 tabs at y=533; content at **584 / 1024**.

```
h3 Player · "CB · 22 · Club"                          [Open player profile]
Trust Score  64 /100 [Developing evidence] [demo]
  disclaimer line
  TrustNote line
  "never sorts or ranks" line
[Status: Watching] [Priority: Normal] [Room lead: X] [Owner: Y] [Health: OK] [Restricted] [Updated: …] [Source: search]
[tags…]
Change status [select ▾] [Apply]  Priority [select ▾]  Room lead [select ▾]  ☐ Restricted
priority note
[add tag ______] [Add tag]
tag note
```

**Problems.** A permanently open form in the header; eight equal-weight pills
of which two matter at a glance; ninety pixels of number plus three sentences.

**After** — ~**112px desktop / ~150px phone** (estimate; measured after):

```
h3 Player · CB · 22 · Club   [Watching] [Normal] [Restricted]      [Change status ▾] [Open profile] [⋯]
Trust 64/100 · Developing evidence · Evidence confidence — not football ability · never sorts or ranks rooms · [demo]
lead X · owner Y · health OK · updated 12 Sep · source search · #tag #tag
```

| element | before | after |
|---|---|---|
| status, priority, restricted | pills among eight | the **only** pills, beside the name (§35) |
| lead, owner, health, updated, source, tags | pills / rows | one muted meta line |
| Trust Score | 26px number + 3 lines | one line: number, band, disclaimer, no-ranking note — **all still in page text** (asserted by `m17DemoSpotcheck`) |
| Change status + reason picker + note | always-open form | **primary action** `Change status` reveals the same form (a disclosure; the `select`, reason picker and note are unchanged, same `aria-label`s) |
| Priority · Room lead · Restricted · Add tag | inline controls | the **⋯ overflow menu** (`role="menu"`, keyboard-operable) opens a small panel with the same controls — low-frequency actions, never hidden, one click away (§32–§33) |
| Open player profile | button | button, kept beside the primary action |
| conflict / unavailable notices | inline | unchanged |

**Ready for what comes next.** Contact, Trials and Offers will be **tabs** in
`[aria-label="Room sections"]`, not header rows. The header carries identity,
state and actions; it does not grow with features.

## 6. Design tokens (§44)

Added to `:root` in both stylesheets and used by every chrome rule:

```
--sidebar-w: 218px   --sidebar-w-collapsed: 64px
--chrome-x: 22px     --chrome-y: 10px          --title-size: 17px
--nav-item-py: 8px   --nav-child-py: 6px       --content-pad: 22px
```

## 7. Consolidation (§43)

One `<header className="topbar">` per app remains inline (the two shells are
separate packages and share no code), but its contents are now a single
`TopBar` component in `navui.tsx` in each, replacing the duplicated inline
JSX. `.pagehint` is the one intro primitive. The Room header stays bespoke —
it is an entity header, not a page header — but loses its form.

## 8. Expected results (verified after)

| page | content start before → after (desktop) | phone |
|---|---:|---:|
| Pro Home | 88 → ~70 | 216 → ~62 |
| Discover → Players | 133 → ~70 | 261 → ~100 |
| Recruitment Room (room tabs) | 533 → ~200 | 973 → ~260 |
| Inbox | 212 → ~92 | 388 → ~110 |
| Grassroots Squad | 211 → ~70 | 342 → ~100 |

Top-level: Pro 6 → 5, Grassroots 6 → 4, Player 5 → 5 (restructured), T&S 6 → 6.
