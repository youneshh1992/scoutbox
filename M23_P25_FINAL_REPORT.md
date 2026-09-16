# M23 P2.5 — Navigation & Header Information Architecture Consolidation: Final Report

Objective: reduce navigation clutter and oversized page chrome by grouping
related destinations into clear categories and condensing elongated top
bars, without removing functionality, weakening permissions, breaking deep
links, or making mobile navigation harder to use.

Branch `claude/desktop-project-migration-wyk3ec`, on top of the P2 tip
`bf069b1`. **Not pushed. No PR opened.** No Contact Workflow code.

## 1. What was delivered (46 items)

### Audits and proposals
1. `M23_P25_NAVIGATION_AUDIT.md` — every nav surface, 36 + 35 + 5 + 26 destinations, route/test/notification inventory, baseline measurements, problems P1–P16.
2. `M23_P25_HEADER_AUDIT.md` — top bar composition, page-by-page intro/h2 classification, Room header rows, stacked-chrome totals.
3. `M23_P25_NAV_PROPOSAL.md` — Pro 6→5, Grassroots 6→4, Player restructure, T&S unchanged, permission matrix, test impact.
4. `M23_P25_HEADER_PROPOSAL.md` — top bar, subnav, h2, prose, Room header, tokens.
5. `M23_P25_DEFECT_REGISTER.md` — D1–D11 with cause, fix and guard.
6. `M23_P25_FINAL_IA.md` — the shipped IA per app with the rule behind each placement.
7. `M23_P25_HEADER_CONTRACT.md` — what a page may draw above its content.
8. `NAVIGATION_ARCHITECTURE.md` rewritten for P2.5.

### Shared navigation architecture (Pro + Grassroots)
9. `NavGroup` overlay in `nav.ts`: `groups?` on a section; `groupedChildren`, `groupSiblings`, `groupOf`, `validateNavConfig`. Groups carry no visibility, routes or permissions.
10. Pro: five sections; Recruitment holds 22 pages in Discover / Pipeline / Evidence / Intelligence / Analytics; Discover folded in as the first group so Players stays first.
11. Grassroots: four sections — Home / Players / Recruitment (six groups incl. Planning) / Club; Network folded into Club with Clubs & Groups visible to every role.
12. `searchNav` rows carry `groupLabel`; the palette shows section › group › page.
13. Obsolete `navsec.discover` / `navsec.team` keys removed after confirming no consumer; unused `Icon` imports removed from both `App.tsx`.

### Desktop shell
14. Sidebar accordion: the active section is always expanded and lists its pages by group; other sections toggle with a real button (`aria-expanded`, `aria-controls`); any navigation re-opens the destination's section; nothing persisted.
15. Collapsed 64px rail: a multi-page section opens a flyout `role="menu"` with `menuitem`s, ArrowUp/Down, Enter, Escape (focus returns to the rail).
16. The secondary tab strip is hidden above 900px — the sidebar carries the pages.
17. `TopBar` primitive: one row, `h1.page-title` with a muted section crumb, live dot / red reconnecting pill, bell, Report / Block.
18. `OrgChips` moved from the top bar to the sidebar account block.
19. Tokens: `--sidebar-w`, `--sidebar-w-collapsed`, `--chrome-x`, `--chrome-y`, `--title-size`, `--nav-item-py`, `--nav-child-py`, `--content-pad`; `.pagehint` primitive.

### Mobile shell
20. Drawer is a column at every width — the Grassroots row-drawer defect (D1) closed by deleting the stale 860px strip rules.
21. Phone strip lists only the active group's siblings (≤ 7), with the active page marked; deep links land on the right group.
22. Top bar stays one row at 390px (54px); Report / Block keeps its accessible name as a glyph under 640px; no horizontal overflow.

### Player app
23. Five destinations: Home / Football / Opportunities / Inbox / You (`_layout.tsx`); titles localised via `pt()`; meaningful glyphs; Inbox reads "Updates" for minors.
24. `football.tsx`: page tabs Passport (Trust Score + Football Passport) / Development / Box Cam / Combine; `+ Add evidence` → `/upload`.
25. `opportunities.tsx`: board, opportunity fit, squad invitations, trial day & safety pack, placement check-ins.
26. `you.tsx`: page tabs Profile (the former Profile body, exported as `ProfileBody`) / Account / Clubs.
27. `/profile` and `/upload` keep their routes with `href: null`; Upload has a back control.
28. `PageChrome.tsx`: `PageHeader` (one row, `role="heading"` level 1) and `PageTabs` (real tablist, `?tab=` deep links).
29. Player i18n EN/FR: tab titles, page-tab labels, action and hints.

### Page headers
30. 17 duplicate in-content `h2` titles removed per app (34 total); the Second Look compare sub-title kept.
31. Leading prose: removed on Home, Fixtures, Funnel, Grassroots Squad; one-line `.pagehint` on Requests, Inbox, Ledger, Squad Planner, Campaigns, Evidence & Video, Follow-ups, Trial Days, Finance, Grassroots Search / Open Days / Friendlies; Trials & Reports status warning kept.
32. Recruitment Room header: identity row (name · position/age/club · status/priority/health/restricted · Move to + Apply · Open profile), a two-line trust block keeping the disclaimer and the no-ranking statement, and a `Room details` disclosure (lead, owner, updated, source, priority, lead, restricted, tags). `aria-label="Room header"` and `.badges` unchanged.
33. `rm.details` EN/FR; Room header CSS in both apps.

### Tests
34. `navConfig.test.mjs` — 256 checks: group validator, ≤ 7 per group, groups survive filtering, empty group vanishes, three broken configs refused, every label in EN and FR, per-app role filtering with no widening, resolver checks.
35. `navLive.test.mjs` — rewritten, 46 checks, N1–N12 (accordion, flyout keyboard, drawer column, group strip, one-row top bar, phone deep link, toggle semantics, refresh/back/forward, EN/FR groups, Grassroots Players/Club, T&S tour, scout-token authorization, player tab set).
36. Player suites migrated (m12/m13/m14/m15/m16/m162/m17/m21/m22 Live, m12/m13/m14/m162/m17/m21 demo spotchecks, uiSpotcheck) to the new tabs and `getByRole('tab')`.
37. `m19Live` anchors on the top bar `h1`; `m14DemoSpotcheck` and `m13DemoSpotcheck` use the sidebar / `h1` instead of the strip and a removed `h2`; `m182Live` J3 clicks a section button (Discover is a group); `m21Live` waits for the Development section title rather than an `aria-label` that only exists once a plan is loaded; `m12Live` / `m15Live` select the page tab their step needs (Profile, Clubs, Football).

### Verification
38. Typechecks: club, grassroots, admin, player — all clean.
39. Builds: club, grassroots, admin (vite) and the player web export (demo bundles rebuilt at `ca2eda9`).
40. Browser battery — see §3.
41. Server suites — see §3 (frozen P2 suites m23E2E / m23Persistence / m23BootContract / m17E2E / m18E2E / m20E2E among them).
42. `git diff bf069b1 -- scoutbox-server` is **empty**: the frozen recruitment lifecycle is untouched.
43. Contact Workflow code search: none. `recruitmentOffers` remains an optional store (unchanged from P2). No generated files changed.
44. Measurements before/after recorded (§2).
45. Four commits on a clean tree: `5258a2e` (shared nav + shell), `ca2eda9` (Player, headers, Room, navLive), `e3e79de` (documents), and the closing commit (test re-anchors + final report).
46. Not pushed, no PR.

## 2. Measured result (Chromium, demo bundles)

| surface | before | after |
|---|---:|---:|
| Pro phone top bar (390px) | 202px | 54px |
| Grassroots phone top bar | 157px | 54px |
| Desktop top bar | 66px | 58px |
| Desktop content start on section pages | 111px | 58px |
| Desktop first meaningful element | 133px (Inbox 212) | 80px |
| Phone content start on section pages | 247px | 93px |
| Phone Inbox first meaningful element | 388px | 68px |
| Recruitment strip at 390px | 15–16 tabs, 12–13 off-screen | 4–7 tabs, 0–3 off-screen |
| Room header desktop / phone | 336 / 653px | 141 / 357px |
| Room tabs reached at (desktop / phone) | 533 / 973px | 280 / 523px |
| Collapsed rail | 64px | 64px (+ flyouts) |
| Pro / Grassroots sections | 6 / 6 | 5 / 4 |
| Player "You" sections | 14 | 3 page tabs |
| Duplicate in-content h2 per app | 17 | 0 |
| Routes removed | — | 0 |
| Permission widening | — | 0 |

## 3. Regression battery

### Browser suites (33, Chromium, sequential)

| suite | first run | after test-anchor fix |
|---|---|---|
| navConfig | pass — navConfig: 256 checks passed | — |
| uiSpotcheck | pass — UI SPOTCHECK OK | — |
| demoOffline | pass — DEMO BUILDS OK | — |
| crosstab | pass — CROSS-TAB E2E OK | — |
| demoHostOrdering | pass — demoHostOrdering: all 15 checks passed | — |
| m12DemoSpotcheck | pass — M12 DEMO SPOTCHECK OK — zero page errors | — |
| m13DemoSpotcheck | fail (test anchor) —  | pass — M13 DEMO SPOTCHECK OK — zero page errors (FR anchor → top bar h1) |
| m14DemoSpotcheck | pass —  | — |
| m162DemoSpotcheck | pass — m162DemoSpotcheck: 21 checks passed — Trust Score demo story OK, zero page errors | — |
| m17DemoSpotcheck | pass — m17DemoSpotcheck: 47 checks passed — Recruitment Rooms demo story OK, zero page errors | — |
| m18DemoSpotcheck | pass — M18 headless spotcheck: ALL CHECKS PASSED — zero page errors | — |
| m181DemoSpotcheck | pass — M18.1 headless spotcheck: ALL CHECKS PASSED — zero page errors | — |
| m182DemoSpotcheck | pass — M18.2 headless spotcheck: ALL CHECKS PASSED — zero page errors | — |
| m19DemoSpotcheck | pass — M19 headless spotcheck: ALL CHECKS PASSED — zero page errors | — |
| m20DemoSpotcheck | pass — M20 headless spotcheck: ALL CHECKS PASSED — zero page errors | — |
| m21DemoSpotcheck | pass — M21 headless spotcheck: ALL CHECKS PASSED — zero page errors | — |
| liveIntegration | pass — LIVE INTEGRATION OK — separate contexts, one backend, no demo bus | — |
| navLive | pass — navLive: 46 checks passed — N1–N12 complete | — |
| m12Live | fail (test anchor) —  | pass — M12 LIVE INTEGRATION OK (Opportunities tab for the board; You › Profile / Clubs page tabs) |
| m13Live | fail (test anchor) —  | pass — M13 LIVE INTEGRATION OK (Clubs page tab; `/you?tab=clubs` deep link) |
| m14Live | pass — m14Live: L1–L7 all passed (separate contexts, live backend) | — |
| m15Live | fail (test anchor) —  | pass — 21 checks, P1–P8 + T&S (Clubs page tab for references; back to Football before sharing) |
| m16Live | pass — m16Live: 10 checks passed — Box Cam cross-app journey complete | — |
| m162Live | pass — m162Live: 11 checks passed — Trust Profile journeys complete | — |
| m17Live | pass — m17Live: 25 checks passed — Recruitment Room journeys complete | — |
| m18Live | pass — m18Live: 60 checks passed — Second Look and Nobody Missed journeys complete | — |
| m181Live | pass — M18.1 live browser journeys: 37 checks passed (H1–H10) | — |
| m182Live | fail (test anchor) —  | pass — 37 checks (J3 clicks a real section button; Discover is a group now) |
| m19Live | pass — M19 live journeys: 17 checks passed | — |
| m20Live | pass — M20 live journeys: 59 checks passed | — |
| m21Live | fail (test anchor) —  | pass — 68 checks (waits for the Development section title in any state) |
| m22Live | pass — production Combine eligibility: NOT ELIGIBLE — real-world validation not completed | — |
| m23Live | pass — m23Live: 39 checks passed — P2 sweep corrections verified end to end | — |

### Server suites (25, plus apiE2E against a fresh :4000 server)

| suite | result |
|---|---|
| testTrust | pass — 23 trust/safeguarding tests passed |
| apiE2E | pass — 130 API checks passed (rerun with a server on :4000; the battery's first attempt had no server on that port) |
| connectedE2E | pass — 43 connected-mode checks passed |
| m12E2E | pass — m12E2E: all 147 checks passed |
| m13E2E | pass — m13E2E: all 212 checks passed |
| m14E2E | pass — m14E2E: all 193 checks passed |
| m141E2E | pass — M14.1 adversarial suite: 94 checks passed |
| m15E2E | pass — M15 acceptance suite: 185 checks passed, 71 negative/abuse checks (38% of all checks) |
| m16E2E | pass — M16 acceptance suite: 118 checks passed, 55 negative/abuse checks (47% of all checks) |
| m161E2E | pass — all M16.1 checks passed |
| m162E2E | pass — all M16.2 checks passed |
| m17E2E | pass — all M17 checks passed |
| m18E2E | pass — all M18 checks passed |
| m181E2E | pass — all M18.1 checks passed |
| m182E2E | pass — all M18.2 checks passed |
| m19E2E | pass — all M19 checks passed |
| m20E2E | pass — all M20 checks passed |
| m21E2E | pass — all M21 checks passed |
| m22E2E | pass — M22 acceptance suite: 112 checks passed, 82 negative/integrity/security checks (73% of all checks) |
| m23E2E | pass — all M23 P2 checks passed |
| m23Persistence | pass — M23-D2 persistence suite: 67 checks passed, 20 negative/integrity checks (30%) |
| m23BootContract | pass — all M23 boot-contract checks passed |
| m17Perf | pass — Passport projection (same player, direct)  median 1.6 ms   p90 1.7 ms |
| m18Perf | pass — matching the WHOLE brief costs 1.45× a single Passport assembly — the match runs on light facts, not assembled Passports |
| m181Perf | pass — noise. Worth revisiting if Passports of that size become common; today the |

Frozen P2 suites among them: m23E2E, m23Persistence (67), m23BootContract, m17E2E, m18E2E, m20E2E — all green, and `scoutbox-server` is byte-identical to `bf069b1`.

Six browser suites failed on the first pass, every one on a selector that pointed at chrome P2.5 removed or moved (a removed `h2`, the old Home/Inbox/You placement of a player section, the former Discover section button, the Development section's empty-state label). No failure was a product regression; each was re-anchored on the destination and rerun (right-hand column).

## 4. Constraints honoured

- Frozen lifecycle semantics: no server file changed; no regression exposed.
- Contact Workflow: not started; the future surface is a Room tab (documented, nothing reserved).
- Server authoritative: navLive N12 proves a scout's own token is refused on a route the sidebar hides; nav config cannot widen anything (navConfig asserts the visible-id sets per role).
- Deep links: every `#/<id>` and pretty route unchanged; player `?tab=` links are additive.
- Mobile: drawer column, group strip, one-row bar, Report reachable, no overflow.
- No push, no PR.

## 5. Open items carried forward

- Pipeline phone strip (6–7 tabs) scrolls by 2–3 tabs at 390px (by design; cap is 7).
- Accordion open state is session-only (deliberate).
- T&S console untouched (66px bar, tab row) — group further only if operators ask.

## 6. Final audit (§113)

| check | result |
|---|---|
| Typecheck club / grassroots / admin / player | clean / clean / clean / clean |
| Builds club / grassroots / admin (vite) + player web export | built by navLive and the live suites; demo bundles rebuilt at `ca2eda9` |
| navConfig | 256 checks |
| navLive | 46 checks, N1–N12 |
| Browser suites (33) | 33 green (6 after test re-anchoring, none a product regression) |
| Server suites (25) + apiE2E | 25 green + 130 API checks |
| Frozen P2 suites (m23E2E, m23Persistence, m23BootContract, m17E2E, m18E2E, m20E2E) | green |
| `git diff bf069b1 -- scoutbox-server` | empty |
| Contact Workflow code | none |
| `recruitmentOffers` | optional store, unchanged |
| Generated files | unchanged |
| Routes removed | 0 |
| Permission widening | 0 (navConfig per-role id sets; navLive N12 scout token → 403) |
| Mobile | drawer column, group strip ≤ 7, one-row 54px bar, Report reachable, no overflow (navLive N5/N6/N9) |
| Deep links | every hash route and pretty route unchanged; refresh + back/forward verified (navLive N11) |
| Tree | clean after the closing commit |
| Push / PR | none |

## 7. Success condition (§114)

Navigation clutter and page chrome are reduced on every surface — Pro
6 → 5 sections with Recruitment grouped, Grassroots 6 → 4, Player 5 → 5
restructured with page tabs, top bars one row (202 → 54px on a phone),
Room header 336 → 141px — and nothing was removed, hidden from a role it
was visible to, or unlinked. The server is untouched, the frozen
recruitment lifecycle is untouched, the Contact Workflow is not started,
and every suite in the battery is green. **Stopped here (§115): not
pushed, no PR.**

---

# P2.5 Closure — mobile Pipeline discoverability and current demo artifacts

Two carried-forward items closed on top of `7d56e7c`, plus a structured
task-finding proof. **Not pushed. No PR. No Contact Workflow code. Server
unchanged.**

## C1. Verified before changing anything

| item | value |
|---|---|
| branch / tip / tree | `claude/desktop-project-migration-wyk3ec` · `7d56e7c` · clean · 168 ahead of origin |
| Pro / Grassroots sections | 5 / 4 |
| Player destinations | 5 visible (Home · Football · Opportunities · Inbox · You) + 2 hidden routes (`/profile`, `/upload`) |
| Pipeline pages | Pro 6, Grassroots 7 (Open Days) |
| demo mechanism | `e2e/buildDemos.mjs` (+ `buildConnectedDemo.mjs`) → untracked `e2e/dist/*.html`, badge "build <sha> · <date>"; consumed by 11 demo spotchecks + 4 demo suites through `demoHost.mjs`, and by the six published review pages (14 Sep build) |

## C2. Pipeline audit and classification

| page | route | frequency | role | desktop | mobile (390px) | deep link |
|---|---|---|---|---|---|---|
| Cases (was "Pipeline") | `#/recruitment` | high — the case list | all | accordion › Pipeline | **visible tab** | loads, Recruitment active, refresh ok |
| Recruitment Rooms | `#/rooms`, `#/recruitment/rooms/:id` | high | all | accordion › Pipeline | **visible tab** | as above |
| Player Requests | `#/requests` | high — only outbound contact path | all | accordion › Pipeline | **visible tab** | as above |
| Opportunities | `#/opportunities` | medium | all | accordion › Pipeline | More | as above |
| Campaigns | `#/campaigns` | low–medium | all | accordion › Pipeline | More | as above |
| Open Days (Grassroots) | `#/opendays` | seasonal | all | accordion › Pipeline | More | as above |
| Signings & Outcomes | `#/outcomes` | low | all | accordion › Pipeline | More | as above |

PRIMARY: Cases, Rooms, Requests. SECONDARY: Opportunities, Campaigns, Open
Days, Signings & Outcomes. CONTEXTUAL: none — each page aggregates across
cases; the per-case functions already live in a Room's tabs. Nothing moved
to reduce a count.

## C3. What changed (client only)

- **`stripLayout()`** (`nav.ts`, both apps): ≤ 4 pages → whole group; more →
  `primary` pages + **More**. `primary` and `shortKey` are NavItem fields
  in the same config the accordion, palette and resolver read. No separate
  mobile list.
- **More** (`navui.tsx`): button with `aria-haspopup="menu"`,
  `aria-expanded`, `aria-controls`, a count; `role="menu"` + `menuitem`s;
  ArrowUp/Down, Escape (focus back to More), outside click, closes on
  selection; focus returned to More or the page title. When the current
  page is inside the menu the control shows that page's name with the
  caret and the active state; its accessible name still says More.
  Navigation goes through the same guarded `setScreen` (unsaved-change
  guard proven from More by navLive N13).
- **Short strip labels** (`navshort.*`, EN + FR): Rooms, Requests, Insight,
  Video, Trials, Briefs, Matching, Watchlists, Nobody Missed, Dashboard,
  Ledger, Signings, Open Days, Planner, Squad, Clubs, Staff, Plan. Full
  labels everywhere else. No abbreviation a user would not recognise.
- **Cases**: the page inside the Pipeline group was itself labelled
  "Pipeline"; now **Cases** / **Dossiers**. Route id, aliases and links
  unchanged.
- **Drawer**: at ≤ 900px a section tap expands the section
  (`aria-expanded`), a page tap navigates and closes. Desktop unchanged.
- **Groups** are `role="group"` containers with names; headings are plain
  text (never a button or link).
- **Demo artifacts**: every bundle carries `sb-source-fingerprint` (content
  hash of `src/**` + package files + the build scripts) and `sb-build-sha`;
  `e2e/demoFreshness.test.mjs` fails a stale or missing bundle. Timestamps
  are never compared; `e2e/dist` stays untracked, so nothing becomes dirty
  by building or testing.

## C4. Final metrics (measured, Chromium, rebuilt demo bundles)

| metric | value |
|---|---|
| Pro top-level sections | 5 |
| Grassroots top-level sections | 4 |
| Player top-level destinations | 5 (+ 2 hidden routes) |
| Pipeline desktop destinations | 6 (Pro) / 7 (Grassroots), all in the accordion |
| Pipeline mobile immediately visible | 3 (Cases · Rooms · Requests) |
| Pipeline mobile in More | 3 (Pro) / 4 (Grassroots) |
| Phone top bar (390px) | 54px |
| Phone strip (Pipeline control) height | 45px (tabs ≥ 40px tall, 13px labels) |
| Phone content start | 99px (was 93 with the clipped strip; the 6px is the 40px tap targets) |
| Phone Room header | 357px at 390px (unchanged), 396px at 360px |
| Desktop top bar / content start / Room header | 58px / 58px / 141px (unchanged) |
| Document overflow at 390px and 360px | none, on every page of every section (navLive N13/N14) |

## C5. Task-finding matrix (fresh login, no URL entry)

```
Destination          Desktop   Collapsed sidebar   Mobile (390px)   Interactions (desktop / collapsed / mobile)
Players (Discover)   PASS      PASS                PASS             1 / 2 / 3
Dynamic Watchlists   PASS      PASS                PASS             2 / 2 / 3
Cases                PASS      PASS                PASS             2 / 2 / 3
Recruitment Rooms    PASS      PASS                PASS             2 / 2 / 3
Second Look          PASS      PASS                PASS             2 / 2 / 3
Trials & Reports     PASS      PASS                PASS             2 / 2 / 3
Director Dashboard   PASS      PASS                PASS             2 / 2 / 3
```

Every path is `Recruitment → destination` (desktop: section click, then the
page in the expanded accordion; collapsed: section icon, then the flyout
item; mobile: hamburger, section tap expands, page tap). No task uses a
URL, a swipe, or a pre-expanded menu: each run reloads on Home first
(navLive N15, 61 checks in total for N1–N16). No path is excessive; the
longest is three taps on a phone.

## C6. Demo artifacts

```
demo artifacts rebuilt: YES  (e2e/buildDemos.mjs + buildConnectedDemo.mjs, from the closure source; September 14 bundles not reused)
artifact source tip:    the closure commit (badge "build <sha> · 2026-09-16"; <meta name="sb-build-sha">), fingerprint-stamped
spotchecks:             11 demo spotchecks + uiSpotcheck, demoOffline, crosstab, demoHostOrdering, demoFreshness — all green
live suites:            navLive (61), liveIntegration, m12–m23 Live (15) — all green against bundles built from the same source
stale old build remains: NO  (demoFreshness fails any bundle whose source fingerprint differs from the working tree)
published review pages: all six updated in place on the user's explicit, scoped approval (force overwrite of my own 14 September versions; private claude.ai pages, not a deployment) from bundles built at 8effa92 —
  App Launcher 2bQfzzftYdNd2ptBpFERsA v18 · Pro 7X18GH19SZMHcNfcVdhxMT v24 · Grassroots T1yP7a1noNEtQMCAt5chnm v22 · Player PrZdGhFxhwY6RWrUAgxBpH v25 · T&S 95jZZMnNPSsCkjb5sQRtMu v19 · Connected Xg7fmowsbY1B9vKmk1g3Xc v16.
  Three older pages from 3 September (two "ScoutBox Player", one "ScoutBox — Recruitment OS") predate the launcher, are not linked from it and were not part of the approval; they were left as they are.
```

Visual check on the rebuilt bundles (Chromium): Pro shows five sections and a 58px / 54px top bar; Grassroots four sections and a vertical 260px drawer; Player shows Home · Football · Opportunities · Inbox · You; the Room header is 141px on a desktop and 357px at 390px.

## C7. Routes, permissions, accessibility

```
Pipeline routes before: #/recruitment #/rooms #/recruitment/rooms/:id #/requests #/opportunities #/campaigns #/outcomes (+ #/opendays Grassroots)
Pipeline routes after:  identical
removed: 0   renamed: 0   redirected: 0   broken: 0

permission widening: 0
permission narrowing unintended: 0
mobile/desktop destination-set mismatch: 0   (navConfig: strip ≡ accordion for scout, lead and reviewer, every group)
```

Accessibility: keyboard (arrows across the strip, ArrowDown opens More,
arrows inside, Escape closes and returns focus); screen-reader naming
(More announces its count or the current page; groups are named
`role="group"` containers; section buttons in the drawer announce
expansion); active state (tab `aria-current="page"`, More carries the
active state when its page is current); More semantics (`aria-haspopup`,
`aria-expanded`, `aria-controls`, `role="menu"`/`menuitem`); focus (into
the menu on open, back to More on Escape and after selection, to the page
title if More unmounted).

## C8. Regression battery (closure run)

### Browser suites

```
discovered: 34   (33 pre-existing + demoFreshness)
applicable: 34
passed: 34
failed: 0
```

| suite | result |
|---|---|
| navConfig | pass — navConfig: 282 checks passed |
| demoFreshness | pass — demoFreshness: 13 checks passed |
| uiSpotcheck | pass — UI SPOTCHECK OK |
| demoOffline | pass — DEMO BUILDS OK |
| crosstab | pass — CROSS-TAB E2E OK |
| demoHostOrdering | pass — demoHostOrdering: all 15 checks passed |
| m12DemoSpotcheck | pass — M12 DEMO SPOTCHECK OK — zero page errors |
| m13DemoSpotcheck | pass — M13 DEMO SPOTCHECK OK — zero page errors |
| m14DemoSpotcheck | pass —  |
| m162DemoSpotcheck | pass — m162DemoSpotcheck: 21 checks passed — Trust Score demo story OK, zero page errors |
| m17DemoSpotcheck | pass — m17DemoSpotcheck: 47 checks passed — Recruitment Rooms demo story OK, zero page errors |
| m18DemoSpotcheck | pass — M18 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| m181DemoSpotcheck | pass — M18.1 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| m182DemoSpotcheck | pass — M18.2 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| m19DemoSpotcheck | pass — M19 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| m20DemoSpotcheck | pass — M20 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| m21DemoSpotcheck | pass — M21 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| liveIntegration | pass — LIVE INTEGRATION OK — separate contexts, one backend, no demo bus |
| navLive | pass — navLive: 61 checks passed — N1–N16 complete |
| m12Live | pass — M12 LIVE INTEGRATION OK — real backend, separate contexts |
| m13Live | pass — M13 LIVE INTEGRATION OK — real backend, four separate contexts |
| m14Live | pass — m14Live: L1–L7 all passed (separate contexts, live backend) |
| m15Live | pass — m15Live: 21 checks passed — P1–P8 + T&S complete |
| m16Live | pass — m16Live: 10 checks passed — Box Cam cross-app journey complete |
| m162Live | pass — m162Live: 11 checks passed — Trust Profile journeys complete |
| m17Live | pass — m17Live: 25 checks passed — Recruitment Room journeys complete |
| m18Live | pass — m18Live: 60 checks passed — Second Look and Nobody Missed journeys complete |
| m181Live | pass — M18.1 live browser journeys: 37 checks passed (H1–H10) |
| m182Live | pass — M18.2 live browser journeys: 37 checks passed (J1–J10) |
| m19Live | pass — M19 live journeys: 17 checks passed |
| m20Live | pass — M20 live journeys: 59 checks passed |
| m21Live | pass — M21 live journeys: 68 checks passed |
| m22Live | pass — production Combine eligibility: NOT ELIGIBLE — real-world validation not completed |
| m23Live | pass — m23Live: 39 checks passed — P2 sweep corrections verified end to end |

Every suite ran from clean ports after the demo rebuild; the demo spotchecks (11) and the four demo suites read the rebuilt bundles; the 15 live suites and liveIntegration build their own live bundles from the same source. Player flows exercised: `/football` (m15/m16/m162/m17/m21/m22), `/opportunities` (m12/m13), `/you?tab=clubs` (m13), `/upload` (uiSpotcheck).

### Server suites (25, plus apiE2E against an owned :4000 server)

| suite | result |
|---|---|
| testTrust | pass — 23 trust/safeguarding tests passed |
| apiE2E | pass — 130 API checks passed (rerun with an owned server on :4000; the battery script starts none) |
| connectedE2E | pass — 43 connected-mode checks passed |
| m12E2E | pass — m12E2E: all 147 checks passed |
| m13E2E | pass — m13E2E: all 212 checks passed |
| m14E2E | pass — m14E2E: all 193 checks passed |
| m141E2E | pass — M14.1 adversarial suite: 94 checks passed |
| m15E2E | pass — M15 acceptance suite: 185 checks passed, 71 negative/abuse checks (38% of all checks) |
| m16E2E | pass — M16 acceptance suite: 118 checks passed, 55 negative/abuse checks (47% of all checks) |
| m161E2E | pass — all M16.1 checks passed |
| m162E2E | pass — all M16.2 checks passed |
| m17E2E | pass — all M17 checks passed |
| m18E2E | pass — all M18 checks passed |
| m181E2E | pass — all M18.1 checks passed |
| m182E2E | pass — all M18.2 checks passed |
| m19E2E | pass — all M19 checks passed |
| m20E2E | pass — all M20 checks passed |
| m21E2E | pass — all M21 checks passed |
| m22E2E | pass — M22 acceptance suite: 112 checks passed, 82 negative/integrity/security checks (73% of all checks) |
| m23E2E | pass — all M23 P2 checks passed |
| m23Persistence | pass — M23-D2 persistence suite: 67 checks passed, 20 negative/integrity checks (30%) |
| m23BootContract | pass — all M23 boot-contract checks passed |
| m17Perf | pass — Passport projection (same player, direct)  median 1.4 ms   p90 1.6 ms |
| m18Perf | pass — matching the WHOLE brief costs 1.81× a single Passport assembly — the match runs on light facts, not assembled |
| m181Perf | pass — noise. Worth revisiting if Passports of that size become common; today the |

Frozen P2 set (m23Persistence, m23BootContract, m23E2E, m17E2E, m18E2E, m20E2E): green. `git diff bf069b1 -- scoutbox-server` remains empty.


## C9. Final audit

```
Pipeline destinations require blind horizontal scrolling at 390px: NO
Core Pipeline destination hidden without explicit overflow indication: NO
Mobile and desktop Pipeline permissions differ: NO
Pipeline deep link broken: NO
Pipeline back/forward broken: NO
Pipeline unsaved-change guard bypass exists: NO
390px document overflow remains: NO
360px navigation overflow remains: NO

Discover task-find fails: NO
Watchlists task-find fails: NO
Cases task-find fails: NO
Rooms task-find fails: NO
Second Look task-find fails: NO
Trials task-find fails: NO
Analytics task-find fails: NO

Published/demo artifacts stale: NO (repository bundles fingerprint-guarded; all six review pages republished from build 8effa92)
Demo artifacts rebuild from current source: YES
Demo spotchecks green: YES
Relevant live suites green: YES
Stale-artifact regression exists: YES

Pro condensed navigation preserved: YES
Grassroots condensed navigation preserved: YES
Player condensed navigation preserved: YES
Condensed top bars preserved: YES
Room condensed header preserved: YES

Route removed unintentionally: NO
Permission widened: NO
Deep link broken: NO
Notification link broken: NO
Raw localization key visible: NO
Keyboard accessibility defect remains: NO
Process/port leak remains: NO

All typechecks green: YES
All required production builds green: YES
Browser/live/demo battery green: YES
Frozen P2 regression green: YES
Server modified unnecessarily: NO
Contact implementation begun: NO
recruitmentOffers created prematurely: NO
Tree clean: YES
```

## C10. Success condition

```
M23 P2.5 FINAL CLOSURE COMPLETE
NAVIGATION IA FROZEN
MOBILE PIPELINE DISCOVERABILITY FIXED
DEMO ARTIFACTS CURRENT
ALL CORE DESTINATIONS DISCOVERABLE ACROSS DESKTOP AND MOBILE
READY FOR M23 CONTACT WORKFLOW
```

The single earlier blocker (five compiled review pages on the 14 September
build) was closed on the user's explicit, scoped approval: bundles rebuilt
at `8effa92`, all six review pages force-republished in place, and the
full browser battery (34 suites, including the 11 demo spotchecks,
demoFreshness, navLive, liveIntegration, m17Live and m23Live) rerun green
against those exact bundles; 390px and 360px re-measured on them (top bar
54px, strip 45px, Room header 357px, Grassroots drawer a 260px column, no
overflow). Routes, permissions and deep links unchanged (navConfig 282).
`e2e/dist` is untracked, so the republish left the tree clean apart from
this report.

Stopped here. Not pushed, no PR, no merge, no deploy, no Contact code.
