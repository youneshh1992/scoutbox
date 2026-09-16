# ScoutBox Navigation & Information Architecture (M15-Nav → M23 P2.5)

## 1. Philosophy

Sidebar = **major destinations**. Page-level tabs = **functions within a
destination**. M15-Nav took the Pro sidebar from 29 permanently visible
labels to six sections plus a secondary tab row. M23 P2.5 went further: the
tab row is gone from the desktop (it was a second navigation bar carrying
destinations), sections became an accordion whose pages are arranged in
named **groups**, the top bar became one row with a single `h1`, and the
Player app got the destination structure M15-Nav had deferred. Reducing
visible choices removed **nothing**: every legacy screen keeps its id, its
component and its deep link.

Two hard rules:

1. **Navigation visibility is never authorization.** Filtering is a client
   convenience computed from already-loaded state (`session.role` + one
   verification-level fetch per session). The server keeps answering
   401/403/404 by its own rules for every route, hidden or not — proven by
   the nav suites (navLive N12 uses a scout's own token against a route the
   sidebar hides from them) and the unchanged verification suites. The nav
   configuration is never a source of security truth: editing it cannot
   widen anything.
2. **No feature loss.** `e2e/navConfig.test.mjs` asserts every legacy
   destination appears in the configuration exactly once, per app, and that
   `validateNavConfig()` finds every child of a grouped section in exactly
   one group.

## 2. One configuration drives everything

`src/nav.ts` (Pro and Grassroots each carry their own copy with their own
section map) defines typed `NavSection`/`NavItem` records with label keys,
icons, palette aliases and optional visibility predicates. P2.5 added
`NavGroup` — a **presentation overlay**: a section may list `groups`, each
naming a label key and the ids of its children. Groups never carry
visibility, routes or permissions; `groupedChildren()` arranges whatever
`filterSections()` left visible, and a group with no visible child is not
drawn. That single configuration drives the sidebar accordion, the
collapsed-rail flyouts, the phone strip, the command palette (which shows
section › group › page), `resolveNavigationLocation()` and pinned
shortcuts. The T&S console keeps a smaller local `NAV_GROUPS` table in its
`App.tsx` (same principle, single source; unchanged by P2.5).

## 3. ScoutBox Pro — five sections, Recruitment grouped

| Section | Group | Pages (screen id = route `#/<id>`) |
|---|---|---|
| Home | — | Home `feed` |
| Recruitment | Discover | Players `search` · Shortlist `shortlist` · Film Room `filmroom` · Scouting Insight `insight` |
| | Pipeline | Cases `recruitment` (labelled "Pipeline" until the P2.5 closure) · Recruitment Rooms `rooms` · Player Requests `requests` · Opportunities `opportunities` · Campaigns `campaigns` · Signings & Outcomes `outcomes` |
| | Evidence | Assessments `assessments` · Evidence & Video `video` · Trials & Reports `trials` · Trial Days `trialdays` |
| | Intelligence | Recruitment Briefs `briefs` · Player Matching `matching` · Dynamic Watchlists `watchlists` · Second Look `secondlook` · Nobody Missed `nobodymissed` |
| | Analytics | Director Dashboard `dashboard` · Funnel `funnel` · Discovery Ledger `ledger` |
| Squad & Planning | — | Squad Planner `planner` · Coverage `coverage` · Calibration `calibration` · Fixtures `fixtures` |
| Network | — | Clubs & Groups `network` · Representation `representation` |
| Organisation | — | Staff & Security `organisation` · Verification `verification` · Integrations `imports` · Finance `budgets` · Plan & Compliance `plan` · Reputation `reputation` |
| Inbox (utility) | — | Messages `messages` |

The former **Discover** section folded into Recruitment as its first group,
so the most-used page (Players) is still the first thing Recruitment opens
on. Analytics lives inside Recruitment rather than as a sixth section: the
Director Dashboard, the Funnel and the Ledger are analytics *of
recruitment*, and a Recruitment lead's day starts and ends there.

Utilities: **Search ScoutBox (⌘K/Ctrl+K)** at the top; **Inbox** (with its
unread badge) below the sections; the account block (name, role, the
organisation's standing badges, **My verification**, language, Switch org)
in the footer. The organisation badges moved out of the top bar, where
they repeated on every page, to the account block, where the organisation
is named.

## 4. Grassroots — four sections

| Section | Group | Pages |
|---|---|---|
| Home | — | `feed` |
| Players | — | Squad & Match Days `squad` · Coaches `coaches` · Friendlies `friendlies` · Fixtures `fixtures` |
| Recruitment | Discover / Pipeline (+ Open Days `opendays`) / Evidence / Intelligence / Analytics / Planning (Coverage `coverage` · Calibration `calibration`) | as Pro, minus Pro-only pages |
| Club | — | Clubs & Groups `network` (everyone) · Staff & Security · Verification (lead or verification authority) · Integrations · Plan & Compliance (lead) |
| Inbox | — | `messages` |

**Team** became **Players** (what a grassroots club actually manages), and
the one-page **Network** section folded into **Club**. Clubs & Groups kept
its unconditional visibility, so a coach sees Club with exactly that page
and nothing that was hidden before (asserted by navConfig). Pro-only
destinations (Squad Planner, Deal Budgets, Representation, Reputation) are
absent and the palette cannot surface them.

## 5. Player app — five destinations

| Tab | Route | Page tabs / contents |
|---|---|---|
| Home | `/discover` | weekly report · pathway · clubs within reach · what scouts noticed · profile strength · who's watching · visibility · club directory · promises |
| Football | `/football` | **Passport** (Trust Score + Football Passport) · **Development** · **Box Cam** · **Combine**; primary action **+ Add evidence** → `/upload` |
| Opportunities | `/opportunities` | opportunity board · opportunity fit · squad invitations · trial day & safety pack · placement check-ins |
| Inbox / Updates | `/inbox` | requests · threads (adults) · acknowledgements |
| You | `/you` | **Profile** (the former Profile screen's body) · **Account** (identity, guardian card, safety centre, season wrap, notifications, access & language, data export/delete, the rules, invite code, log out) · **Clubs** (published feedback, suitability preferences, club transition, representation, exposure, coach references) |

`/profile` and `/upload` remain valid routes (`href: null` keeps them off
the bar); Upload carries a back control. Page tabs are a real `tablist`
(`role="tab"`, `aria-selected`) and accept `?tab=` for deep links. The tab
set is identical for every player kind; what differs inside each tab is
driven by `isMinor` and enforced by the server, exactly as before. Guardian
accounts never reach the tabs (`index.tsx` redirects them first).

## 6. Trust & Safety (22 tabs → 6 groups) — unchanged by P2.5

| Group | Tabs |
|---|---|
| Home | Overview |
| Cases | Report queue · Evidence disputes · Ver. disputes · Support desk |
| Verification | Verification · Club verification · Guardian IDV · Staff checks · Coach affiliations |
| Safety | Suspensions · Moderation log · Thread audit · Drill guidance |
| Operations | Outcome tracking · Representation · Federation groups · Delivery centre · Mail outbox · Billing |
| System | Service health · Backups |

The pending-reports badge sits on **Cases**. All 22 legacy tabs remain
reachable (toured by navLive N8). The console's 66px top bar and flat tab
row were already compact; the mandate's "group only where it improves
operator efficiency" argued for leaving it alone.

## 7. Role-aware visibility (convenience only)

- Ordinary scout (no lead-pattern role, no verification authority): Home,
  Recruitment, Squad & Planning, Network, Inbox. Organisation is hidden
  entirely — never shown as an empty husk.
- Lead-pattern roles (`/head|director|lead|manager|owner|chief/i` — the
  same heuristic the server's `isLead` uses): plus Organisation (all
  children).
- Verification authority without a lead role (fetched once per session
  from `/org/verification/me`): Organisation appears with Verification
  (and Staff & Security, Reputation); Finance/Integrations/Plan stay
  lead-only.
- P2.5 regrouping widened nothing: navConfig computes the set of ids each
  role can see from the same predicates and asserts a scout sees none of
  the four admin pages and everything a scout sees, a lead sees.
- Permission changes apply on the next session/verification-level refresh;
  the server rejects hidden routes regardless, immediately.

## 8. Command palette

⌘K (macOS) / Ctrl+K, plus the visible **Search ScoutBox** control.
Modifier-gated — plain typing in inputs never triggers it. Searches
navigation destinations only (label prefix > label substring > alias
prefix > alias substring > section name), across **permitted** destinations
only; aliases can never bypass the visibility filter, and the backend would
refuse the data anyway. Rows show the path as section › group › page.

## 9. Shortcuts

Up to 5 pins, stored **by item id** (rename-safe) under
`sb-nav-shortcuts:<orgId>:<userId>` in localStorage — honest limitation: no
server-side preference store exists yet, so pins are per-browser. Pins are
re-validated against current visibility on load: forbidden or unknown ids
drop silently.

## 10. Route compatibility & deep links

Every screen id is a hash route (`#/verification`, `#/assessments`, …), and
the pretty routes (`#/recruitment/rooms/:id`, `#/recruitment/briefs/:id`,
`#/recruitment/second-look`, `#/recruitment/dashboard`, …) are unchanged.
Regrouping cannot break a link: links are produced only by `hashFor*()`
from screen ids, and `resolveNavigationLocation()` derives the section
from the id. Section clicks open the section's first child; a direct deep
link highlights the section and the page without a parent-first step;
unknown hashes land on Home and highlight nothing. **Routes removed: 0.**

## 11. Responsive behaviour

Desktop (> 900px): expanded sidebar (218px) as an **accordion** — the
active section is always expanded and lists its pages by group; other
sections toggle with a chevron for the session (nothing persisted). Any
navigation into a section re-opens it. Collapsed icon rail (64px, persisted
in `sb-nav-collapsed`): a multi-page section opens a **flyout menu**
(`role="menu"`, arrow keys, Escape returns focus). No tab strip: the
sidebar carries the pages. ≤ 900px: the sidebar is an off-canvas drawer
(a column — the Grassroots row-drawer defect is closed); a section tap in
the drawer expands the section, a page tap navigates and closes it. The
**phone strip** lists only the active group's pages: a group of up to four
whole, a longer group as its primary pages plus an explicit **More** menu
(see §11a).
The top bar is one row at every width (54px on a phone, 58px on a
desktop); Report / Block shrinks to its glyph under 640px with the same
accessible name. The 640px-height regression guard remains.

## 11a. Pipeline (and every long group) on a phone — the discoverability invariant

Desktop: the sidebar accordion lists every page of the section, grouped;
there is no strip. Phone (≤ 900px): `stripLayout(section, itemId)` in
`nav.ts` derives the strip from the same configuration as the accordion:

- a group of up to `STRIP_MAX_VISIBLE` (4) pages is shown whole;
- a longer group shows the pages flagged `primary` (Pipeline: Cases · Rooms
  · Requests; Intelligence: Briefs · Matching; Organisation: Staff · Verification) — or, with no
  flag, its first three — and puts the rest behind **More**;
- More is a button with `aria-haspopup="menu"`, `aria-expanded`, a count,
  and a `role="menu"` of `menuitem`s (ArrowUp/Down, Escape returns focus,
  outside click closes, closes on selection, focus returned to More);
- when the current page is inside More, the control reads
  the current page's name with the menu caret and the active state (its accessible name still says More), so a selection is never
  invisible;
- short strip labels come from `shortKey` (`navshort.*`, EN/FR); the full
  label is used everywhere else;
- navigation from the strip and from More goes through the same guarded
  `setScreen` as the sidebar (unsaved-change guard included).

**Invariant (asserted).** For every role and every group the strip's pages
(visible ∪ More) are exactly the accordion's pages, in order, with the
active page marked in exactly one place (navConfig). At 390px and 360px no
strip clips, no tab is off screen, no document scrolls sideways, and the
strip is ≤ 48px tall (navLive N13/N14). 900px is the phone shell, 901px the
desktop shell — one breakpoint, no intermediate state.

## 12. Accessibility

`aria-current="page"` on active section and page; accordion toggles are
buttons with `aria-expanded` and `aria-controls`; flyouts are menus with
`menuitem`s and roving arrow focus; the page title is the document's only
`h1`; visible `:focus-visible` outlines; roving arrow-key focus in the
phone strip; dialog semantics + Esc + arrow/Enter selection in the
palette; icons are `aria-hidden` with text or `aria-label` alongside;
active state uses an accent bar + weight, not colour alone; the drawer
closes on veil click and after navigation. Player page tabs are a
`tablist`.

## 13. Home action centre

"Needs your attention" renders only counts that already exist client-side:
unread player/guardian messages, and (for verification reviewers) the
pending verification-request queue. Each row deep-links. Top-level sections
carry no number badges except Inbox unread and the T&S Cases
pending-reports count.

## 14. Page header contract

See `M23_P25_HEADER_CONTRACT.md`. In short: the top bar `h1` is the one
page title; screens draw no `h2` that repeats it; a leading explanation is
either a material constraint (one line, `.pagehint`) or absent; status
warnings stay; entity headers (the Recruitment Room) are one identity row
plus one disclosure.

**Room sections after M23 P3.** The Recruitment Room gained a **Contact**
section tab (after Discussion, before Activity: internal talk first, shared
communication second). It is a function of the case, not a destination — no
sidebar item, no route, no palette entry; the deep link stays
`#/recruitment/rooms/:id`. The strip scrolls within itself at 390px.

## 15. Tests

- `e2e/navConfig.test.mjs` — config integrity (every legacy id exactly
  once, Pro + Grassroots), P2.5 group overlay (validator, ≤ 7 per group,
  groups survive filtering, empty group vanishes, broken configs refused),
  every label key present in EN and FR, deterministic resolver, role
  filtering (no widening), palette permission filtering + aliases, strict
  hash parsing, shortcut persistence/degradation, malformed stored state.
- `e2e/navLive.test.mjs` — journeys N1–N12 against a real backend
  (scout/lead/grassroots/T&S contexts): compact scout nav, one `h1` and no
  duplicate `h2`, accordion groups, no desktop strip, deep-link
  highlighting, palette path with group, collapse + flyout keyboard +
  persistence, 640px height, phone drawer column + group strip + one-row
  top bar + Report reachable + no overflow, phone deep link, accordion
  toggle keyboard semantics, refresh + back/forward, EN/FR, grassroots
  Players/Club, all 22 T&S tabs, server-auth negatives incl. a scout's own
  token, player tab set.
- The Player journeys live in the player suites (m12–m22 Live and demo
  spotchecks), migrated to the new tabs and page tabs.

## 16. Known limitations

- Shortcut and collapse preferences are per-browser (localStorage); a
  server-side preference store is future work. Accordion open/closed state
  is deliberately not persisted.
- Verification-level visibility refreshes once per session (login/reload),
  not live mid-session; the server enforces immediately regardless.
- Command search covers navigation destinations only, by design.
- The demo builds report a root verification level for every persona, so
  role-hiding is only observable against the live backend (covered by
  navLive); demo spotchecks exercise mechanics, not role filtering.
- (closed) The Pipeline strip no longer scrolls: primaries + More (§11a).

## 17. Demo / review artifacts

| artifact | built by | output | tracked | stamp | consumers |
|---|---|---|---|---|---|
| `scoutbox-club-demo.html`, `scoutbox-grassroots-demo.html`, `scoutbox-admin-demo.html`, `scoutbox-player-demo.html` | `node e2e/buildDemos.mjs` (vite `VITE_DEMO=1` / expo `EXPO_PUBLIC_DEMO=1` + `e2e/inline.mjs`) | `e2e/dist/` | no (untracked; nothing becomes dirty by building or testing) | badge "Interactive demo · build <sha> · <date>", `<meta name="sb-source-fingerprint">`, `<meta name="sb-build-sha">` | the demo spotchecks (`*DemoSpotcheck`, `uiSpotcheck`, `crosstab`, `demoOffline`, `demoHostOrdering`) via `demoHost.mjs`; the published review pages |
| `scoutbox-connected-demo.html` | `node e2e/buildConnectedDemo.mjs` (after buildDemos) | `e2e/dist/` | no | as above | the connected review page |
| Live bundles `dist-live*` | each live suite builds its own with the API URL baked in | per app | no | — | the live suites |

**Stale-artifact prevention.** `e2e/demoFreshness.test.mjs` recomputes each
client's source fingerprint (sha256 over `src/**` + package files + the two
build scripts — content, never timestamps) and fails when a bundle's stamp
differs or a bundle is missing. It is part of the browser battery, so a
navigation rebuild that forgets `buildDemos.mjs` is caught before review.
Published review pages are updated from `e2e/dist` after the battery is
green; their build chip names the source commit.
