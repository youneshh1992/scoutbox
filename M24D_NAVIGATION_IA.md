# M24D — Navigation simplification

One rule, everywhere a person is shown a list of choices: **no navigation
category holds more than five entries**, and three to four is the target.
It is data (`NAV_MAX_PER_CATEGORY = 5` in the Pro and Grassroots `nav.ts`,
`ADMIN_NAV_MAX = 5` in `scoutbox-admin/src/navGroups.ts`,
`CASE_NAV_MAX_SUBS = 5` in `design-system/caseNav.ts`), reported by the
validators (`validateNavConfig`, `validateAdminNav`, `validateCaseNav`) and
asserted on the real configuration of all five applications by
`e2e/navConfig.test.mjs` and `e2e/caseNav.test.mjs`, then on the rendered
sidebar by `e2e/m24dNavLive.test.mjs`. A sixth entry fails a suite.

This is a presentation and information-architecture change. No route moved,
no screen was added or removed, no lifecycle, authorization, server domain,
Contact / Trial / Assessment / Decision / Offer / Signing semantics, Trust
Score, Matching, Box Cam, minor safeguard or Agent boundary changed. Hiding
a destination was never authorization and still is not.

## The audit

| Application | Category | Before | After |
|---|---|---|---|
| Pro | Recruitment › Pipeline | 6 (Cases, Rooms, Requests, Opportunities, Campaigns, Signings & Outcomes) | 4 — Campaigns moved to Outreach, Signings & Outcomes to Outcomes |
| Pro | Recruitment › Intelligence | 5 | 4 — Recruitment Briefs moved to Outreach |
| Pro | Organisation (ungrouped, lead) | 6 | 2 groups of 3 — Administration (Staff & Security, Verification, Reputation), Operations (Integrations, Finance, Plan & Compliance) |
| Grassroots | Recruitment › Pipeline | 7 (+ Open Days) | 4 — Campaigns and Open Days to Outreach, Signings & Outcomes to Outcomes |
| Grassroots | Recruitment › Intelligence | 5 | 4 |
| Trust & Safety | Cases | 7 | 4 — Passport, Box Cam and Trust moved to a new **Evidence** group |
| Trust & Safety | Operations | 6 | 3 — Delivery centre, Mail outbox and Billing moved to a new **Delivery & Billing** group |
| Player | Opportunities categories | 6 (… + Board) | 5 — the Board is a page of My journey; Current stage and Tasks folded into Overview |
| Agent | every section | ≤ 3 | unchanged |
| Player | bottom navigation | 5 | 5 (unchanged, asserted) |

Groups audited: 24 (Pro 7 + 2, Grassroots 8, Trust & Safety 9, Player 5,
Agent 5 sections). Originally above five: 7. Split: 7. Largest now: 5
(Trust & Safety › Verification, unchanged at five; every Recruitment group
is four or fewer).

## ScoutBox Pro — Recruitment

The brief's IA, using only destinations that exist. Headings the brief
listed with no screen behind them — Contacts, Offers, Completed Cases,
Recruitment Planning, Position Needs — are **not** fabricated; the groups
below name what is there.

```
RECRUITMENT
  DISCOVER       Players · Shortlist · Film Room · Scouting Insight
  PIPELINE       Cases · Recruitment Rooms · Player Requests · Opportunities
  OUTREACH       Campaigns · Recruitment Briefs
  EVALUATION     Assessments · Evidence & Video · Trials & Reports · Trial Days
  INTELLIGENCE   Player Matching · Dynamic Watchlists · Second Look · Nobody Missed
  OUTCOMES       Signings & Outcomes
  ANALYTICS      Director Dashboard · Funnel · Discovery Ledger
SQUAD & PLANNING (the existing section: Squad Planner · Coverage · Calibration · Fixtures)
NETWORK          Clubs & Groups · Representation
ORGANISATION     Administration (Staff & Security · Verification · Reputation)
                 Operations (Integrations · Finance · Plan & Compliance)
```

Grassroots is the same with Open Days in Outreach (Campaigns · Open Days ·
Recruitment Briefs) and an eighth group, Planning (Coverage · Calibration);
its Club section lists five pages ungrouped. The Agent keeps its five
sections of at most three pages. The Trust & Safety console's nine groups
are in `scoutbox-admin/src/navGroups.ts`.

## The sidebar: one open at a time

`SectionRow` (the three portal `navui.tsx` files, byte-for-byte the same
code) now folds at two levels:

- **Sections.** The section holding the current page is expanded; arriving
  anywhere folds the sections opened on the way (`Sidebar` keeps the set to
  one on navigation). A chevron still opens a second section for the
  session.
- **Groups.** Inside an expanded section exactly one group is open: the one
  holding the current page, or the first group when the current page is
  elsewhere. Opening another folds it; the open one can be folded by hand;
  any navigation returns to following the current page. The group that
  holds the current page is marked (`.nav-group.has-active`) even while
  folded, so the route is always locatable.
- A group heading is a real `<button>` with `aria-expanded` and
  `aria-controls` naming its rendered page list, inside a `role="group"`
  container with its name; it never navigates and is never a link. The
  collapsed rail's flyout menu keeps every page (it is a menu, not an
  accordion). The phone drawer uses the same accordion with ≥ 32px headings
  and ≥ 34px pages.
- Depth is section → group → page and never deeper (asserted).

Recruitment visible-link count in the expanded sidebar: **22 before, 4
after** (the open group's pages; never more than five anywhere, asserted at
1440 / 1024 / 390).

The phone strip (`stripLayout`) is unchanged in mechanism: a group of up to
four pages shows whole; Intelligence, whose four names fit a 360px row only
two at a time, declares `stripMax: 3` and shows Matching · Watchlists with
Second Look and Nobody Missed behind the explicit More menu. Pipeline, now
four pages, shows whole.

## Player — Opportunities

```
MY JOURNEY     Overview · Activity · Board
CLUB CONTACT   Messages · Contact
TRIAL          Invitation · Schedule · Details
OFFER          Offer · Documents · Response
SIGNING        Signing · Documents · Contract
```

The Overview now carries what the Current stage and Tasks pages carried
(the stage, what each club has shared, the next action with its Go). The
Board page stacks the four board sections (open roles, fit, squad invites,
follow-ups). Old links still land: `?cat=board` and `?tab=board-*` open
My journey › Board; `?tab=stage` and `?tab=tasks` open the Overview
(`PLAYER_LEGACY_SUBS`, asserted by `caseNav.test.mjs` and
`m24CaseNavLive` P5). No club-private information was added.

## Tests

- `e2e/navConfig.test.mjs` — the five rule on every group and ungrouped
  section of Pro and Grassroots for every role, on the Agent's sections, on
  every Trust & Safety group (and that every tab the console defines is in
  exactly one group), on the Player's bottom navigation (five, two routes
  off the bar) and recruitment categories; the new Recruitment groups; the
  validators refusing a six-page group.
- `e2e/caseNav.test.mjs` — the Player's five categories and legacy links.
- `e2e/navLive.test.mjs` — N1 / N5 / N14 / N15 / N16 rewritten for one open
  group; N8 for the nine Trust & Safety groups (every tab still reachable,
  no group shows more than five tabs); N13 for the strip's More on
  Intelligence.
- `e2e/m24dNavLive.test.mjs` — C1–C11 + G1–G3: initial state, active
  group, expand another, collapse, deep link, Back / Forward, refresh,
  keyboard, phone drawer, depth, the five rule at three widths, Grassroots.
- `e2e/m24CaseNavLive.test.mjs` P1–P5 — the Player's categories and pages
  at 390 and 360, plus the pre-M24D Board link.
