# M23 P2.5 — Navigation Proposal (current → proposed)

> For every app: what the navigation is now, what it becomes, why, and what it
> does to routes and permissions. Written from `M23_P25_NAVIGATION_AUDIT.md`,
> not from memory.

The governing principle applied throughout: **sidebar = destinations, page
tabs = functions**. A destination is somewhere you go; a function is something
you do once there.

---

## 1. The one structural change, shared by Pro and Grassroots

**CURRENT.** A section is a single sidebar button. Its children are rendered
as a horizontal tab strip (`.subnav`) inside the page area, on every page.
Recruitment's 15–16 children make that strip ~2,000px wide; at 390px, 12–13
tabs are off-screen.

**PROPOSED.** A section is an **accordion**: the active section is expanded in
the sidebar and lists its children, arranged in labelled **groups** where the
section has them. The page tab strip is **removed on desktop**. At phone width
the sidebar is a drawer, so a compact strip stays — but it lists only the
**active group's siblings** (never more than six), not the whole section.

**Rationale.** The strip was a second navigation bar carrying destinations,
which is exactly what the principle forbids. Moving children into the sidebar
returns 45px on every page, gives the fifteen Recruitment destinations a
structure, and makes the mobile strip fit.

**Route impact:** none. `screenFromHash`, `hashFor*`, every screen id and
every pretty hash are byte-identical. **Permission impact:** none — the same
`visible` predicates filter the same children; groups are a display overlay
computed *after* filtering, and a group with no visible child is not drawn.

**Depth.** `Section → (group label) → page → page-local tabs`. The group is a
heading, not a level: it has no route and cannot be opened. Routine depth
stays at two clicks before page-local tabs.

## 2. ScoutBox Pro

```
CURRENT (6 + Inbox, 36 pages)              PROPOSED (5 + Inbox, 36 pages)
├─ Home                                    ├─ Home
├─ Discover ─ 7 pages                      ├─ Recruitment ─ 22 pages in 5 groups
├─ Recruitment ─ 15 pages, flat            │    Discover      Players · Shortlist · Film Room · Scouting Insight
├─ Squad & Planning ─ 4                    │    Pipeline      Cases · Recruitment Rooms · Player Requests ·
├─ Network ─ 2                             │                  Opportunities · Campaigns · Signings & Outcomes
├─ Organisation ─ 6 (lead / ver)           │    Evidence      Assessments · Evidence & Video · Trials & Reports · Trial Days
└─ Inbox                                   │    Intelligence  Briefs · Player Matching · Dynamic Watchlists ·
                                           │                  Second Look · Nobody Missed
                                           │    Analytics     Director Dashboard · Funnel · Discovery Ledger
                                           ├─ Squad & Planning ─ Squad Planner · Coverage · Calibration · Fixtures
                                           ├─ Network ─ Clubs & Groups · Representation
                                           ├─ Organisation ─ 6 (lead / ver, unchanged)
                                           └─ Inbox
```

| change | rationale | route impact | permission impact |
|---|---|---|---|
| **Discover folds into Recruitment** as its first group | Discover is the finding half of recruiting; the mandate's target places it there; with the accordion, "Recruitment" opens on Players, so the most-used page (`#/search`, 23 suites) is still one click from anywhere and one tap from the drawer — no tap penalty | none — `#/search` etc. unchanged | none — all were visible to all |
| **Opportunities, Campaigns → Pipeline** | the club posting roles is outbound demand, not discovery | none | none |
| **Discovery Ledger → Analytics**, beside Funnel | the Funnel's own intro says it counts "real recorded events on the Discovery Ledger" — they belong together; three analytics pages now sit in one group | none | none |
| **Recruitment grouped** (5 groups) | fifteen flat peers, alphabetised by milestone of arrival, became legible by purpose | none | none |
| **Network stays** | the mandate's Pro target keeps it; two pages, low clutter | — | — |
| **Organisation unchanged** | already role-gated, already suppressed when empty | — | — |

**Analytics placement (§10), decided:** *inside Recruitment*, as a group.
Not top-level: it measures the recruitment process and nothing else, the
existing `nav.ts` comment already argues it belongs "beside the work it
measures", and a top-level Analytics would invite one new item per future
analytical module (§85). Not under Organisation: it is operational, not
administrative. Future analytical modules join the Analytics group.

## 3. Grassroots

```
CURRENT (6 + Inbox, 35 pages)              PROPOSED (4 + Inbox, 35 pages)
├─ Home                                    ├─ Home
├─ Discover ─ 7                            ├─ Players ─ Squad & Match Days · Coaches · Friendlies · Fixtures
├─ Recruitment ─ 16, flat                  ├─ Recruitment ─ 25 pages in 6 groups
├─ Team ─ 6                                │    Discover · Pipeline (+ Open Days) · Evidence · Intelligence ·
├─ Network ─ 1                             │    Analytics · Planning (Coverage · Calibration)
├─ Organisation ─ 4 (lead / ver)           ├─ Club ─ Clubs & Groups · Staff & Security · Verification ·
└─ Inbox                                   │         Integrations · Plan & Compliance
                                           └─ Inbox
```

| change | rationale | route impact | permission impact |
|---|---|---|---|
| **Team → Players** (Squad, Coaches, Friendlies, Fixtures) | the mandate's grassroots target; a manager's daily surface is the squad, named for what it holds | none — `#/squad` etc. unchanged | none |
| **Coverage, Calibration → Recruitment › Planning** | they are *scout* planning, not squad management; they were in Team only because Grassroots had nowhere else | none | none |
| **Network folds into Club** | a section for one page; Clubs & Groups is the club's external relationships | none | **none widened.** `network` was visible to all and stays so; the four admin pages keep their lead/ver gates. Consequence: a non-lead now sees *Club → Clubs & Groups* where they previously saw *Network → Clubs & Groups*. Same page, same server rules. |
| **Discover folds into Recruitment** | as Pro | none | none |
| **Development** | the mandate lists it under Players; in source, club-side Development is the `DevelopmentPanel` inside the player drawer, not a route. **Not added** — there is no page to point at. | — | — |

## 4. Player

```
CURRENT (5 tabs)                           PROPOSED (5 tabs)
├─ Home    weekly report · pathway ·       ├─ Home          weekly report · pathway · promises
│          opportunities board · fit       ├─ Football      Passport · Development · Box Cam · Combine · Trust
├─ Inbox   threads · acks · squad          │                + primary action  [+ Add evidence]
│          invites · trial days            ├─ Opportunities board · opportunity fit · squad invites ·
├─ Profile identity · availability ·       │                trial days · follow-ups
│          evidence passport               ├─ Inbox         threads · acknowledgements
├─ Upload  campaigns · resumable upload    └─ You           profile & identity · availability · account ·
└─ You     account · safety · season ·                      safety · notifications · data · references ·
           notifications · data · rules ·                   representation · transitions · preferences ·
           + 14 sections incl. Passport,                    guardian controls · invite code
           Development, Box Cam, Combine,
           Trust, References, …
```

| change | rationale | route impact | permission impact |
|---|---|---|---|
| **Football** tab (new `football.tsx`) with page tabs Passport / Development / Box Cam / Combine / Trust | the five football features shipped since M15 were the 9th–13th sections of "You". This is the follow-up `NAVIGATION_ARCHITECTURE.md §5` recorded. Page tabs are functions of one destination | new route `/football`; the sections move, the screens they call are unchanged | none — every section is the same component reading the same server projection; minors' guardian-managed rules are enforced inside each section by the server as today |
| **Upload becomes an action** | "Upload" is something you do. `+ Add evidence` is the primary action on Football (and offered on Home); it opens the existing upload screen | `/upload` **stays a valid route** (`href: null` hides its tab button); deep links and `a[href="/upload"]` keep working | none |
| **Opportunities** tab (new) gathers the board, fit, squad invites, trial days and follow-ups | the "opportunities" concept had no home: it was split between Home and Inbox | new route `/opportunities` | none — the same sections; minors see the same guardian-routed copy |
| **Profile folds into You** | identity, availability, medical sharing and the evidence passport are the player's own record — the mandate's "You: Profile" | `/profile` **stays valid** (`href: null`), redirect-free | none |
| **Inbox** keeps threads and acknowledgements | messages are messages | unchanged | unchanged (minors: "Updates", no threads) |
| **Tab titles localised** via `pt()` | they were string literals; FR exists for everything else | — | — |
| **Icons** | ◎ ▤ ♟ ⬆ ● → labelled glyphs with meaning (home, football, target, inbox, person) | — | — |

**Minor / guardian (§12).** The tab set is the same for every player kind;
what differs is *inside* each tab, exactly as today, driven by `isMinor` and
enforced by the server. Guardian-owned accounts never reach the tabs at all —
`index.tsx` redirects `kind === 'guardian'` to the guardian dashboard before
the tab layout renders. Nothing in this proposal creates a route a minor
could not already reach, and nothing hides a route that the server does not
also refuse.

## 5. Trust & Safety

**Unchanged.** Six groups, 26 tabs, a compact 66px top bar, a flat sidebar.
The mandate says group only where it improves operator efficiency; the
existing grouping already did that in M15-Nav and Cases (7 tabs) is the only
group above five. Splitting it would add a click to the report queue, the
tool's centre of gravity. Its `nav.subnav` tab strip stays too — T&S tabs are
functions of a queue view, not destinations, and eight suites drive them.

## 6. Where future functions live (§82–§85)

| future function | lives at | not |
|---|---|---|
| **Contact** (P3) | a page tab inside the Recruitment Room, beside Overview / Assessments / Decision | a sidebar destination |
| **Trials** | the aggregate destination *Recruitment › Evidence › Trials & Reports* exists today; the case-local view is a Room tab | a second aggregate page |
| **Offers** (P4) | *Recruitment › Pipeline*, only once it exists | shown now — `recruitmentOffers` stays optional; no empty destination |
| future analytics | *Recruitment › Analytics* | a new top-level item each |

## 7. Active state, expansion, collapse (§18–§20)

- **Active:** the section that owns the current screen id is `aria-current="page"`
  and expanded; the child is `aria-current="page"` within it. Resolved by the
  unchanged `resolveNavigationLocation`, so `#/recruitment/rooms/123` lights
  Recruitment › Pipeline › Recruitment Rooms exactly as `#/rooms` does.
- **Expansion:** deterministic. The active section is always expanded. Any
  other section can be toggled open with its chevron (`aria-expanded`) for the
  session; **no persisted preference** — there is nothing worth remembering,
  and §19 prefers simple behaviour.
- **Collapsed rail (64px):** each section icon opens a **flyout menu** listing
  its grouped children (`role="menu"`, keyboard: Enter/Space opens, arrows
  move, Escape closes, Tab leaves). The icon keeps `aria-label` + `title`;
  the flyout's label, not the tooltip, is the accessible name of the children
  (§48). Single-child sections (Home) navigate directly.
- **Mobile drawer:** the same accordion inside the 260px drawer. **Fixes the
  Grassroots row-layout defect** by deleting its obsolete 860px strip rule.

## 8. Permission matrix (§49)

`✓` visible in navigation · `–` hidden · every route stays server-enforced
regardless.

| destination | Pro: Head of Recruitment | Pro: First-Team Scout / Academy Coach | Pro: Agent | Pro: verification reviewer (non-lead) | Grassroots: Manager | Grassroots: Coach / Volunteer / Secretary | Player adult | Player minor | Guardian | T&S |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Home | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – (own dashboard) | – |
| Recruitment (all groups) | ✓ | ✓ | ✓ (agency wall inside pages) | ✓ | ✓ | ✓ | – | – | – | – |
| Squad & Planning / Players | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | – |
| Network | ✓ | ✓ | ✓ | ✓ | (in Club) | (in Club) | – | – | – | – |
| Organisation / Club → Staff & Security, Verification, Reputation | ✓ | – | – | ✓ | ✓ | – | – | – | – | – |
| Organisation / Club → Integrations, Finance, Plan | ✓ | – | – | – | ✓ | – | – | – | – | – |
| Club → Clubs & Groups | n/a | n/a | n/a | n/a | ✓ | ✓ | – | – | – | – |
| Inbox | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ ("Updates") | – | – |
| Player: Football / Opportunities / You | – | – | – | – | – | – | ✓ | ✓ (guardian-managed content) | – | – |
| T&S groups | – | – | – | – | – | – | – | – | – | ✓ |

**Before → after difference in effective visibility: one row** — Grassroots
non-leads see Club (with a single child) instead of Network. No destination
becomes visible to a role that could not see it before.

## 9. Test impact

| suite | change |
|---|---|
| `navConfig` | section counts 6→5 (Pro), 6→4 (Grassroots); `validateNavConfig()` must return `[]`; every group label key exists in EN and FR; Grassroots scout sees Club with exactly `network` |
| `navLive` | N1/N2/N4/N5/N6 rewritten for the accordion, flyout and drawer; `.topbar h2` → `.topbar h1`; N7 asserts the **new** Player tabs and that `/upload`, `/profile` remain routes; new N9 (mobile group strip ≤ 6, no overflow), N10 (keyboard: expand → child → Escape from flyout), N11 (deep link + refresh + Back/Forward keep the parent active) |
| `m14DemoSpotcheck` | one wait on `nav.subnav … Vérification` → the sidebar child button |
| `m19Live` | `h2:has-text("Player Matching")` → `.topbar h1` (the screen's duplicate `h2` is removed) |
| six player Live suites | `a[href="/you"]` → `/football` where the awaited section moved (Passport, Box Cam, Trust, Development); `/discover` → `/opportunities` where the board moved; `/you` unchanged for account, transitions, feedback |
