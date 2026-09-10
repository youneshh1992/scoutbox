# ScoutBox Navigation & Information Architecture (M15-Nav)

## 1. Philosophy

Sidebar = **major destinations**. Page-level tabs = **functions within a
destination**. The Pro sidebar had grown to 29 permanently visible labels;
it now presents six product destinations plus utilities, with every feature
still exactly one secondary-tab (or one palette query) away. Reducing
visible choices removed **nothing**: every legacy screen keeps its id, its
component and its (new) deep link.

Two hard rules:

1. **Navigation visibility is never authorization.** Filtering is a client
   convenience computed from already-loaded state (`session.role` + one
   verification-level fetch per session). The server keeps answering
   401/403/404 by its own rules for every route, hidden or not — proven by
   the nav suites and the unchanged 193/94-check verification suites.
2. **No feature loss.** `e2e/navConfig.test.mjs` asserts every legacy
   destination appears in the configuration exactly once, per app.

## 2. One configuration drives everything

`src/nav.ts` (Pro and Grassroots each carry their own copy with their own
section map) defines typed `NavSection`/`NavItem` records with label keys,
icons, palette aliases and optional visibility predicates. That single
configuration drives the sidebar, the secondary tabs, the command palette,
`resolveNavigationLocation()` and pinned shortcuts — five surfaces that can
no longer drift apart. The T&S console keeps a smaller local `NAV_GROUPS`
table in its `App.tsx` (same principle, single source).

## 3. ScoutBox Pro — old → new mapping (29 destinations)

| Old sidebar item | Screen id (= route `#/<id>`) | New section | New child label |
|---|---|---|---|
| Home | `feed` | Home | Home |
| Search | `search` | Discover | Players |
| Shortlist | `shortlist` | Discover | Shortlist |
| Film Room | `filmroom` | Discover | Film Room |
| Opportunities | `opportunities` | Discover | Opportunities |
| Campaigns | `campaigns` | Discover | Campaigns |
| Scouting Insight | `insight` | Discover | Scouting Insight |
| Discovery Ledger | `ledger` | Discover | Discovery Ledger |
| Recruitment | `recruitment` | Recruitment | Pipeline |
| Assessments | `assessments` | Recruitment | Assessments |
| Video Workspace | `video` | Recruitment | Evidence & Video |
| Trials & Reports | `trials` | Recruitment | Trials & Reports |
| Trial Days | `trialdays` | Recruitment | Trial Days |
| Requests | `requests` | Recruitment | Player Requests |
| Outcomes | `outcomes` | Recruitment | Signings & Outcomes |
| Funnel | `funnel` | Recruitment | Funnel |
| Squad Planner | `planner` | Squad & Planning | Squad Planner |
| Coverage | `coverage` | Squad & Planning | Coverage |
| Calibration | `calibration` | Squad & Planning | Calibration |
| Fixtures | `fixtures` | Squad & Planning | Fixtures |
| Club Network | `network` | Network | Clubs & Groups |
| Representation | `representation` | Network | Representation |
| Organisation (F12 console) | `organisation` | Organisation | Staff & Security |
| Verification | `verification` | Organisation | Verification |
| Imports & Integrations | `imports` | Organisation | Integrations |
| Deal Budgets | `budgets` | Organisation | Finance |
| Plan & Compliance | `plan` | Organisation | Plan & Compliance |
| Reputation | `reputation` | Organisation | Reputation |
| Messages | `messages` | — (utility) | Inbox |

Utilities: **Search ScoutBox (⌘K/Ctrl+K)** at the top; **Inbox** (with its
unread badge) below the sections; the account block (name, role, **My
verification**, language, Switch org) in the footer. "My verification" is
an account-menu convenience deep-linking to the same `verification` screen
(whose *Me* tab is personal); the canonical navigation entry remains
Organisation → Verification.

## 4. Grassroots (29 destinations, same design language)

Home `feed` · **Discover** (Players, Shortlist, Film Room, Opportunities,
Campaigns, Scouting Insight, Discovery Ledger) · **Recruitment** (Pipeline,
Assessments, Evidence & Video, Trials & Reports, Trial Days, Open Days,
Player Requests, Signings & Outcomes, Funnel) · **Team** (Squad & Match
Days, Coaches, Friendlies, Fixtures, Coverage, Calibration) · **Network**
(Clubs & Groups) · **Organisation** (Staff & Security, Verification,
Integrations, Plan & Compliance) · Inbox. Pro-only destinations (Squad
Planner, Deal Budgets, Representation, Reputation) are absent — no
enterprise clutter, and the palette cannot surface them.

## 5. Player app — intentionally unchanged (documented follow-up)

M15 Football Passport does **not** exist yet (the M12 `passport.mjs` is the
older evidence-passport server feature). Per the mandate's own escape
hatch, the Player app keeps its current five tabs (Home, Inbox, Profile,
Upload, You) untouched. Follow-up when M15 Passport lands: `Profile` →
**Passport** as a major destination, `Upload` moves out of primary
navigation into a prominent **+ Add Evidence** action (functionality
preserved). Asserted as-unchanged by navLive N7.

## 6. Trust & Safety (22 tabs → 6 groups)

| Group | Tabs |
|---|---|
| Home | Overview |
| Cases | Report queue · Evidence disputes · Ver. disputes · Support desk |
| Verification | Verification · Club verification · Guardian IDV · Staff checks · Coach affiliations |
| Safety | Suspensions · Moderation log · Thread audit · Drill guidance |
| Operations | Outcome tracking · Representation · Federation groups · Delivery centre · Mail outbox · Billing |
| System | Service health · Backups |

The pending-reports badge moved onto **Cases**. All 22 legacy tabs remain
reachable (toured by navLive N8).

## 7. Role-aware visibility (convenience only)

- Ordinary scout (no lead-pattern role, no verification authority): Home,
  Discover, Recruitment, Squad & Planning, Network, Inbox. Organisation is
  hidden entirely — never shown as an empty husk.
- Lead-pattern roles (`/head|director|lead|manager|owner|chief/i` — the
  same heuristic the server's `isLead` uses): plus Organisation (all
  children).
- Verification authority without a lead role (fetched once per session
  from `/org/verification/me`): Organisation appears with Verification
  (and Staff & Security, Reputation); Finance/Integrations/Plan stay
  lead-only.
- Permission changes apply on the next session/verification-level refresh;
  the server rejects hidden routes regardless, immediately.

## 8. Command palette

⌘K (macOS) / Ctrl+K, plus the visible **Search ScoutBox** control.
Modifier-gated — plain typing in inputs never triggers it. Searches
navigation destinations only (label prefix > label substring > alias
prefix > alias substring > section name), across **permitted** destinations
only; aliases (e.g. `verify`, `reports`, `scout coverage`) can never bypass
the visibility filter, and the backend would refuse the data anyway.
Player search was deliberately not integrated (kept simple; Discover →
Players is one result away).

## 9. Shortcuts

Up to 5 pins, stored **by item id** (rename-safe) under
`sb-nav-shortcuts:<orgId>:<userId>` in localStorage — honest limitation: no
server-side preference store exists yet, so pins are per-browser. Pins are
re-validated against current visibility on load: forbidden or unknown ids
drop silently. Pin/unpin from the palette rows; unpin also from the
sidebar.

## 10. Route compatibility & deep links

The workspace previously had **no URLs at all** (pure in-memory screen
state). Every screen id is now a hash route (`#/verification`,
`#/assessments`, …) — so this redesign *added* deep links rather than
breaking any. Direct entry resolves the owning section and child tab via
`resolveNavigationLocation()` (unit-tested per destination); unknown hashes
land on Home and highlight nothing. Section clicks open the section's
first child (its sensible default); no route was renamed, moved or
removed.

## 11. Responsive behaviour

Desktop: expanded (218px) or collapsed icon rail (64px, tooltips +
aria-labels, keyboard reachable, persisted in `sb-nav-collapsed`). ≤900px
width: the sidebar becomes an off-canvas drawer behind a hamburger; tabs
scroll horizontally in their own container. The 640px-height regression
(the original M14 bug) is explicitly re-tested: with only ~9 sidebar rows
it no longer overflows, and `overflow-y: auto` remains as the guard.

## 12. Accessibility

`aria-current="page"` on active section and tab; visible
`:focus-visible` outlines; roving arrow-key focus in the tab row; dialog
semantics + Esc + arrow/Enter selection in the palette; icons are
`aria-hidden` with text or `aria-label` alongside; active state uses an
accent bar + weight, not color alone; the drawer closes on veil click and
after navigation.

## 13. Home action centre

"Needs your attention" renders only counts that already exist client-side:
unread player/guardian messages, and (for verification reviewers) the
pending verification-request queue. Each row deep-links (`messages`,
`verification`). No invented backend counts; the card disappears when
empty. Top-level sections carry no number badges except Inbox unread and
the T&S Cases pending-reports count — both genuinely actionable.

## 14. Tests

- `e2e/navConfig.test.mjs` — **111 checks**: config integrity (every legacy
  id exactly once, Pro + Grassroots), deterministic resolver, role
  filtering, empty-category suppression, palette permission filtering +
  aliases, strict hash parsing, shortcut persistence/degradation, malformed
  stored state.
- `e2e/navLive.test.mjs` — **30 checks**, journeys N1–N8 against a real
  backend (scout/lead/grassroots/T&S contexts): compact scout nav, hidden
  Organisation, deep-link highlighting, palette permission filtering and
  routing, typing-in-input negative, collapse + persistence, 640px height,
  narrow-width drawer, EN/FR labels, grassroots reduction, all 22 T&S tabs
  reachable, server-auth negatives, player-unchanged assertion.
- All pre-existing suites re-run green after migrating their navigation to
  the new deep links (which now exercises deep linking constantly).

## 15. Known limitations

- Shortcut and collapse preferences are per-browser (localStorage); a
  server-side preference store is future work.
- Verification-level visibility refreshes once per session (login/reload),
  not live mid-session; the server enforces immediately regardless.
- The Player app redesign is deferred until M15 Football Passport exists
  (see §5).
- Command search covers navigation destinations only, by design.
- The demo builds report a root verification level for every persona, so
  role-hiding is only observable against the live backend (covered by
  navLive); demo spotchecks exercise mechanics, not role filtering.
