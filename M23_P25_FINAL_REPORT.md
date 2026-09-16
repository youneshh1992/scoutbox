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
37. `m19Live` anchors on the top bar `h1`; `m14DemoSpotcheck` and `m13DemoSpotcheck` use the sidebar / `h1` instead of the strip and a removed `h2`.

### Verification
38. Typechecks: club, grassroots, admin, player — all clean.
39. Builds: club, grassroots, admin (vite) and the player web export (demo bundles rebuilt at `ca2eda9`).
40. Browser battery — see §3.
41. Server suites — see §3 (frozen P2 suites m23E2E / m23Persistence / m23BootContract / m17E2E / m18E2E / m20E2E among them).
42. `git diff bf069b1 -- scoutbox-server` is **empty**: the frozen recruitment lifecycle is untouched.
43. Contact Workflow code search: none. `recruitmentOffers` remains an optional store (unchanged from P2). No generated files changed.
44. Measurements before/after recorded (§2).
45. Two commits on a clean tree; §3 lists the third (docs + final verification).
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

__BATTERY__

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
