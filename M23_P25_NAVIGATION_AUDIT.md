# M23 P2.5 — Navigation Audit

> Every visible navigation system in the repository, inventoried from source
> and measured in a browser before anything was changed.

Tip audited: `bf069b1`. Method: the four clients' navigation configurations
(`nav.ts`, `(tabs)/_layout.tsx`, T&S `NAV_GROUPS`) and shells (`App.tsx`,
`navui.tsx`) were read; every route was cross-referenced against the e2e
suites, the notification tables and the demo builds; and the self-contained
demo bundles were driven in Chromium at 1440×900 and 390×844 to measure what
the chrome actually costs.

---

## 1. Navigation surfaces found

| App | Surface | Component | Notes |
|---|---|---|---|
| Pro | desktop sidebar | `navui.tsx` `Sidebar` | 6 sections + Inbox; expanded 218px / collapsed rail 64px; ≤900px becomes an off-canvas drawer |
| Pro | page tab strip | `navui.tsx` `SecondaryNav` → `nav.subnav` | the active section's **children** as a horizontal button row, on every page with >1 child |
| Pro | top bar | inline in `App.tsx` → `.topbar` | hamburger · `h2` "Section / Page" · up to 5 org pills · live-sync pill · bell · "⚑ Report / Block" |
| Pro | command palette | `CommandPalette` | ⌘K / Ctrl+K; searches permitted destinations |
| Pro | shortcuts | sidebar block | up to 5 pins, localStorage |
| Pro | account block | sidebar `whoami` | name · role · org · plan · My verification · language · Switch org |
| Pro | notification bell | `.bell-panel` | rows deep-link via `NOTIFICATION_SCREEN` (17 types) |
| Pro | player drawer | `PlayerDrawer` | overlay, not a route |
| Grassroots | identical set | `navui.tsx` is byte-identical to Pro's; `nav.ts` has its own section map | plus a **second, conflicting** mobile rule at 860px (see §6) |
| Player | bottom tabs | `(tabs)/_layout.tsx` | 5 tabs: Home(`discover`) · Inbox · Profile · Upload · You; icons are text glyphs; titles hard-coded EN |
| Player | per-screen header row | each tab file | `h1` 26px + `NotificationBell` + `ReportButton` (Home/Upload/You); Profile has back `‹` + `⋯` menu instead |
| Player | guardian dashboard | `app/guardian.tsx` | separate stack route; reached only by `Redirect` from `index.tsx`/onboarding when `kind === 'guardian'` |
| T&S | sidebar | inline in `App.tsx` | 6 groups; badge on Cases |
| T&S | tab strip | `nav.subnav` | the group's tabs |
| T&S | top bar | `.topbar` | `h2` "Group / Tab" · demo pill · ↻ Refresh |

No breadcrumb component exists; the "Section / Page" crumb is rendered inside
the top-bar `h2`. No floating actions exist. No route-level redirects exist:
every hash is parsed by `screenFromHash` and an unknown hash lands on Home.

## 2. Nav item inventory (§3)

Legend — **vis**: all / lead / leadOrVer (client convenience only; the server
enforces every route regardless). **active**: how the item is highlighted.
**dup**: overlap with another destination.

### 2.1 ScoutBox Pro — `scoutbox-club/src/nav.ts`

| section (icon) | label | id → route | vis | active logic | dup / note |
|---|---|---|---|---|---|
| Home (`home`) | Home | `feed` → `#/feed` | all | section+child by `resolveNavigationLocation` | — |
| Discover (`search`) | Players | `search` → `#/search` | all | " | most-used route in the suites (23 files) |
| | Shortlist | `shortlist` → `#/shortlist` | all | " | — |
| | Film Room | `filmroom` → `#/filmroom` | all | " | — |
| | Opportunities | `opportunities` → `#/opportunities` | all | " | **pipeline**, not discovery: the club posts roles |
| | Campaigns | `campaigns` → `#/campaigns` | all | " | same — outbound demand |
| | Scouting Insight | `insight` → `#/insight` | all | " | renders its own duplicate `<h2>` |
| | Discovery Ledger | `ledger` → `#/ledger` | all | " | **analytics/audit**, sits under Discover |
| Recruitment (`target`) | Pipeline | `recruitment` → `#/recruitment` | all | " | — |
| | Recruitment Rooms | `rooms` → `#/rooms`, `#/recruitment/rooms/:id` | all | " | parameterised; pushes history |
| | Second Look | `secondlook` → `#/recruitment/second-look` | all | " | own `<h2>` |
| | Nobody Missed | `nobodymissed` → `#/recruitment/nobody-missed` | all | " | own `<h2>` |
| | Recruitment Briefs | `briefs` → `#/briefs`, `#/recruitment/briefs/:id` | all | " | own `<h2>` |
| | Player Matching | `matching` → `#/recruitment/matching[?c=]` | all | " | own `<h2>` |
| | Dynamic Watchlists | `watchlists` → `#/recruitment/watchlists[/:id]` | all | " | own `<h2>` |
| | Director Dashboard | `dashboard` → `#/recruitment/dashboard[?filters]` | all | " | own `<h2>`; **analytics** |
| | Assessments | `assessments` → `#/assessments` | all | " | — |
| | Evidence & Video | `video` → `#/video` | all | " | — |
| | Trials & Reports | `trials` → `#/trials` | all | " | — |
| | Trial Days | `trialdays` → `#/trialdays` | all | " | — |
| | Player Requests | `requests` → `#/requests` | all | " | — |
| | Signings & Outcomes | `outcomes` → `#/outcomes` | all | " | — |
| | Funnel | `funnel` → `#/funnel` | all | " | **analytics** |
| Squad & Planning (`clipboard`) | Squad Planner | `planner` → `#/planner` | all | " | — |
| | Coverage | `coverage` → `#/coverage` | all | " | own `<h2>` |
| | Calibration | `calibration` → `#/calibration` | all | " | own `<h2>` |
| | Fixtures | `fixtures` → `#/fixtures` | all | " | — |
| Network (`globe`) | Clubs & Groups | `network` → `#/network` | all | " | own `<h2>` |
| | Representation | `representation` → `#/representation` | all | " | own `<h2>` |
| Organisation (`building`) — section `leadOrVer` | Staff & Security | `organisation` → `#/organisation` | leadOrVer | " | own `<h2>` |
| | Verification | `verification` → `#/verification` | leadOrVer | " | own `<h2>`; also reachable from account block "My verification" |
| | Integrations | `imports` → `#/imports` | lead | " | own `<h2>` |
| | Finance | `budgets` → `#/budgets` | lead | " | own `<h2>` |
| | Plan & Compliance | `plan` → `#/plan` | lead | " | — |
| | Reputation | `reputation` → `#/reputation` | leadOrVer | " | — |
| utility | Inbox | `messages` → `#/messages` | all | `itemId === 'messages'` | unread badge |
| utility | Search ScoutBox | palette | all | — | — |
| utility | My verification | → `verification` | all (server gates) | — | duplicate entry point, documented as deliberate |
| utility | Switch org | logout | all | — | — |
| utility | Collapse sidebar | toggle | all | — | persisted |
| top bar | Report / Block | `SafetyModal` | all | — | safety action on every screen — **must stay visible** |
| top bar | Notifications | `.bell-panel` | all | `aria-expanded` | — |

**Counts:** 6 sections · 36 destinations · 1 utility route · 11 sidebar buttons
visible when expanded (search, 6 sections, Inbox, My verification, Switch org,
Collapse). Recruitment alone has **15** children.

### 2.2 Grassroots — `scoutbox-grassroots/src/nav.ts`

Same shape, 35 destinations. Differences from Pro:

| section | label key | children |
|---|---|---|
| Home | `navsec.home` | feed |
| Discover | `navsec.discover` | search, shortlist, filmroom, opportunities, campaigns, insight, ledger |
| Recruitment | `navsec.recruitment` | recruitment, rooms, secondlook, nobodymissed, briefs, matching, watchlists, dashboard, assessments, video, trials, trialdays, **opendays**, requests, outcomes, funnel — **16** |
| Team | `navsec.team` (EN "Team") | **squad**, **coaches**, **friendlies**, fixtures, coverage, calibration |
| Network | `navsec.network` | network |
| Organisation (leadOrVer) | `navsec.organisation` | organisation, verification, imports (lead), plan (lead) |

Absent by design: `planner`, `budgets`, `representation`, `reputation`.
Present only here: `squad`, `coaches`, `friendlies`, `opendays`.

### 2.3 Player — `scoutbox-player/src/app/(tabs)/_layout.tsx`

| tab | file | title (EN only, hard-coded) | icon | what it actually holds | minor/guardian |
|---|---|---|---|---|---|
| Home | `discover.tsx` | Home | ◎ | weekly scout report · pathway · **BoardSection** (opportunities) · **OpportunityFitSection** · safeguarding promises | `isMinor` copy variants; "via your guardian" pills |
| Inbox | `inbox.tsx` | Inbox | ▤ (badge) | Threads · AckSection · **SquadInvitesSection** · **TrialSafetySection** | minors: title "Updates", no threads, requests shown as "with your guardian" |
| Profile | `profile.tsx` | Profile | ♟ | back `‹` · `⋯` report menu · identity block · availability/medical toggles · **PassportSection** (M12 evidence) | location hidden, "Guardian-managed" pill, availability guardian-controlled |
| Upload | `upload.tsx` | Upload | ⬆ | CampaignsSection · ResumableUploadCard | — |
| You | `you.tsx` | You | ● | account card · account/data · guardian-managed · safety centre · season wrap · notifications · data · rules, then **FeedbackDev · FollowUps · Preferences · Transitions · Representation · Exposure · Access · References · DevelopmentHub · BoxTraining · Combine · TrustProfile · FootballPassport · InviteCode** | guardian-managed card |
| (route) | `guardian.tsx` | — | — | guardian dashboard, own stack | `kind === 'guardian'` only |
| (route) | `onboarding.tsx` | — | — | welcome / details / pair / guardian account; demo personas | — |

**Finding:** every football feature shipped since M15 — Passport, Development
Hub, Box Training, Combine, Trust Profile — lives at the **bottom of the "You"
tab**, below account settings, notifications and the data-rights section.
"You" is 14 stacked sections. `NAVIGATION_ARCHITECTURE.md §5` recorded this as
a deliberate deferral: *"Profile → Passport as a major destination; Upload
moves out of primary navigation into a prominent + Add Evidence action."* That
follow-up is this milestone.

### 2.4 Trust & Safety — `scoutbox-admin/src/App.tsx`

| group | tabs (26 total) |
|---|---|
| Home | overview |
| Cases (badge) | reports · disputes · verdisputes · passport · boxcam · trust · supportdesk — **7** |
| Verification | verification · clubs · guardians · staffchecks · coaches |
| Safety | blocks · moderation · threads · drillguide |
| Operations | outcomes · representation · groups · deliverycentre · outbox · billing |
| System | servicehealth · backups |

`NAVIGATION_ARCHITECTURE.md` says 22 tabs; four have been added since
(passport, boxcam, trust, staffchecks/coaches). The T&S sidebar is a flat
group list with no collapse, no mobile rule at all (`styles.css` has no
`max-width` query), and a compact 66px top bar.

## 3. Route inventory (§4)

Every Pro/Grassroots screen id **is** its route (`#/<id>`), plus the eight
pretty/parameterised hashes. `screenFromHash` is strict: malformed hashes
reject; `#/recruitment/rooms` and `#/recruitment/briefs` resolve to their
lists.

| route | navigable from | role gate (server) | deep-linked by | in notifications | in e2e (files) | in demo |
|---|---|---|---|---|---|---|
| `#/feed` | Home | any org user | — | — | 2 | yes |
| `#/search` | Discover→Players | any | palette alias | `saved_search` | **23** | yes |
| `#/shortlist` `#/filmroom` `#/insight` `#/ledger` | Discover | any | — | — | 3 / 0 / 3 / 0 | yes |
| `#/opportunities` `#/campaigns` | Discover | any | — | `application`, `campaign`, `review_queue` | 4 / 1 | yes |
| `#/recruitment` | Recruitment→Pipeline | any | — | `case` | 1 | yes |
| `#/rooms`, `#/recruitment/rooms`, `#/recruitment/rooms/:id` | Recruitment→Rooms; PlayerDrawer; Nobody Missed; Watchlists | room role (`findRoom`, 404-concealing) | `hashForRoom` (App.tsx) | `recruitment_room` | 9 / 8 / 8 | yes |
| `#/recruitment/second-look` | Recruitment | any | `PRETTY_HASH` | `second_look` | 12 | yes |
| `#/recruitment/nobody-missed` | Recruitment | any | " | — | 9 | yes |
| `#/briefs`, `#/recruitment/briefs/:id` | Recruitment | any | `hashForBrief` | — | 10 / 4 | yes |
| `#/recruitment/matching[?c=]` | Recruitment; Watchlists "new" | any | `hashForMatching` | — | 13 | yes |
| `#/recruitment/watchlists[/:id]` | Recruitment; Matching | any | `hashForWatchlist` | — | 8 / 3 | yes |
| `#/recruitment/dashboard[?…]` | Recruitment | director (server) | `hashForDashboard` | — | 2 | yes |
| `#/assessments` `#/video` `#/trials` `#/trialdays` `#/requests` `#/outcomes` `#/funnel` | Recruitment | any | — | `open_trial`, `trial_day`, `outcome` | 1 / 1 / 0 / 2 / 0 / 1 / 0 | yes |
| `#/planner` `#/coverage` `#/calibration` `#/fixtures` | Squad & Planning | any | — | `coverage`, `calibration` | 1 / 3 / 0 / 0 | yes |
| `#/network` `#/representation` | Network | any / agency-aware | — | `representation` | 3 / 0 | yes |
| `#/organisation` `#/verification` `#/imports` `#/budgets` `#/plan` `#/reputation` | Organisation | lead / ver authority (server) | "My verification" | `verification` | 5 / 9 / 1 / 1 / 0 / 0 | yes |
| `#/messages` | Inbox | any | bell rows | `accepted`, `declined`, `message` | 2 | yes |
| grassroots-only `#/squad` `#/coaches` `#/friendlies` `#/opendays` | Team / Recruitment | any | — | — | 1 / 1 / 0 / 0 | yes |

**Notification links are type→screen-id** (`NOTIFICATION_SCREEN`), never
constructed hashes. Deep links are produced in exactly one place per app
(`App.tsx`, via `hashFor*`). Therefore: **as long as every screen id and every
`hashFor*` function is unchanged, no notification link and no deep link can
break by regrouping the sidebar.** This audit finds no route that is reachable
only through a sidebar item — every one is also a typed hash, a palette result,
or both.

Demo builds set no hashes of their own.

## 4. Current information architecture (§5)

```
Pro (6 + Inbox)                        Grassroots (6 + Inbox)
├─ Home                                ├─ Home
├─ Discover (7)                        ├─ Discover (7)
├─ Recruitment (15)                    ├─ Recruitment (16)
├─ Squad & Planning (4)                ├─ Team (6)
├─ Network (2)                         ├─ Network (1)
├─ Organisation (6, lead/ver)          ├─ Organisation (4, lead/ver)
└─ Inbox                               └─ Inbox

Player (5 tabs)                        T&S (6 groups)
├─ Home                                ├─ Home (1)
├─ Inbox                               ├─ Cases (7)
├─ Profile                             ├─ Verification (5)
├─ Upload                              ├─ Safety (4)
└─ You (14 sections)                   ├─ Operations (6)
                                       └─ System (2)
```

## 5. Baseline measurements (§39, §88)

Demo bundles at tip `bf069b1`, Chromium, lead persona. *contentTop* = where
`.content` begins; *meaningful* = first element that is not an explanatory
`.notice`.

### Desktop 1440×900

| page | topbar | tab strip | tabs | contentTop | first element | meaningful |
|---|---:|---:|---:|---:|---|---:|
| Pro Home | 66 | — | 0 | 66 | attn-card | 88 |
| Pro Discover→Players | 66 | 45 | 7 | 111 | filters | 133 |
| Pro Recruitment→Pipeline | 66 | 45 | 15 | 111 | filters | 133 |
| Pro Rooms list | 71 | 45 | 15 | 116 | (own `h2`) | 138 |
| **Pro Room detail** | 71 | 45 | 15 | 116 | room header **336px**, 8 rows, 11 pills, 4 buttons | room tabs at **533**, content **584** |
| Pro Squad Planner | 66 | 45 | 4 | 111 | notice | 133 |
| Pro Organisation | 66 | 45 | 6 | 111 | own `h2` "Organisation" | 133 |
| Pro Director Dashboard | 66 | 45 | 15 | 111 | own `h2` | 133 |
| Pro Inbox | 66 | — | 0 | 66 | notice (62px prose) | **212** |
| Grassroots Home | 66 | — | 0 | 66 | attn-card | 88 |
| Grassroots Squad | 66 | 45 | 6 | 111 | notice (62px prose) | **211** |
| Grassroots Room detail | 66 | 45 | 16 | 111 | room header 336px | content **579** |

### Phone 390×844

| page | topbar | tab strip | contentTop | first element | meaningful |
|---|---:|---:|---:|---|---:|
| **Pro — every page** | **202** | 45 | **247** | | |
| Pro Home | 202 | — | 202 | attn-card | 216 |
| Pro Discover→Players | 202 | 45 | 247 | filters 167px | 261 |
| Pro Inbox | 202 | — | 202 | notice 94px | **388** |
| **Pro Room detail** | 202 | 45 | 247 | header **653px** | room tabs **973**, content **1024** |
| **Grassroots — every page** | **157** | 45 | 202 | | |
| Grassroots Squad | 157 | 45 | 202 | notice 110px | **342** |
| Grassroots Room detail | 157 | 45 | 202 | header 630px | content **956** |

The 202px comes from the top bar wrapping: `h2` on its own row, then five
status pills and the bell/report buttons wrapping onto two more rows. It is
the same on every page because the pills are org-level, not page-level.

### Recruitment tab strip at 390px

| app | tabs | strip scrollWidth | tabs fully off-screen |
|---|---:|---:|---:|
| Pro | 15 | 2025px | **12** |
| Grassroots | 16 | 2127px | **13** |

### Sidebar

| | expanded | collapsed |
|---|---|---|
| width | 218px | 64px |
| section item height | 36px (10px padding, 14px text, 4px gap) | 36px |
| visible buttons (lead) | 11 | 9 |
| collapsed rail labelled | every section has `aria-label` + `title` | ✓ |
| children reachable when collapsed | only via the page tab strip in `.main` | — |

### Mobile drawer (hamburger, 390px)

| app | drawer width | layout | scrollWidth | account buttons |
|---|---:|---|---:|---|
| Pro | 260 | column, 36px items | 259 | visible |
| **Grassroots** | 260 | **row** — all eight buttons at y≈405 | **1349** | **0px high (hidden)** |

### Player (Expo web export)

Onboarding renders first; the tab shell measures h1 26px/800 with 18px scroll
padding on every tab, plus a bell + report row on Home/Upload/You.

## 6. Navigation problems identified (§6)

| # | class | finding | evidence |
|---|---|---|---|
| P1 | functions presented as destinations | Recruitment's 15–16 children are rendered as a page **tab strip**, i.e. as functions of one page. They are destinations. The strip is a second navigation bar. | §5: 45px band on every page; 12–13 tabs off-screen at 390 |
| P2 | related pages split across sections | Opportunities and Campaigns (outbound demand) sit under Discover; Funnel and Discovery Ledger (analytics) are split between Recruitment and Discover; Director Dashboard, Funnel, Ledger are three analytics pages in two sections | `nav.ts` |
| P3 | top-level items that belong under a category | Discover is the *finding* half of recruitment; Network (Pro: 2 items, Grassroots: 1) is a section for one or two pages | `nav.ts`; mandate §8/§13 |
| P4 | excessively flat grouping | Recruitment has no sub-structure at all: 15 peers, alphabetised by milestone of arrival | `nav.ts` comments: "no seventh sidebar section" ×4 |
| P5 | duplicate destination | "My verification" (account block) and Organisation→Verification | documented as deliberate; kept |
| P6 | inconsistent naming | sidebar says **Recruitment Rooms**, the room list `h2` says **Recruitment Rooms**, the top bar says **Recruitment / Recruitment Rooms** — three renderings of one name on one screen | §5 Rooms row |
| P7 | desktop/mobile mismatch | **Grassroots drawer renders as a horizontal row** because the 860px "sidebar becomes a top strip" rule and the 900px "sidebar becomes a drawer" rule both apply at phone width; the later rule wins `position` but not `flex-direction` | §5 drawer table — **defect** |
| P8 | desktop/mobile mismatch | Pro top bar wraps to 202px at 390 (Grassroots 157) — org status pills that never change per page take two rows on every page | §5 |
| P9 | role-specific clutter | none found: Organisation is suppressed entirely for non-leads; empty sections never render | `filterSections` |
| P10 | orphaned routes | none: every screen id is in a section, asserted by `navConfig` (197 checks) | — |
| P11 | Player: functions buried | Passport, Development, Box Cam, Combine, Trust are the 9th–13th sections of "You", under notifications and data rights | §2.3 |
| P12 | Player: destination that is a function | "Upload" is an action (add evidence), not a place to be | mandate §11; `NAVIGATION_ARCHITECTURE.md §5` |
| P13 | Player: same content on two tabs | opportunities board on Home, squad invites and trial days on Inbox — the "opportunities" concept has no home | §2.3 |
| P14 | Player: no localisation of nav | tab titles are string literals; the app has `pt()` and an FR dictionary | `_layout.tsx` |
| P15 | icon semantics | Pro/Grassroots use a 15-glyph SVG set; Player uses Unicode text glyphs (◎ ▤ ♟ ⬆ ●) — "♟" for Profile and "●" for You carry no meaning | `_layout.tsx` |
| P16 | T&S | compact already; 26 tabs in 6 groups; Cases has 7. No mobile rule, but T&S is a desk tool. | §2.4 — **leave** |

## 7. Test inventory before changes (§87)

| suite | checks | what it pins about navigation |
|---|---:|---|
| `navConfig` | 197 | every legacy id exactly once per app; resolver; role filtering; palette; strict hash parsing; shortcuts |
| `navLive` | 30 | N1–N8 journeys; **26 references** to `.subnav` / `nav.sidebar button` / `.topbar h2`; **N7 asserts the five Player tab ids are unchanged** |
| `m12/m13/m14/m162/m17 DemoSpotcheck`, `m14/m15/m16 Live` | — | 2–6 references each: `nav.subnav button:has-text("…")` to reach a child page; `nav.sidebar button` counts |
| T&S suites | — | 8 × `admin.click('nav.subnav button:has-text(…)')` — T&S nav is unchanged, so these stay |
| all Live suites | — | 22 suites wait on `nav.sidebar` after login |
| typecheck / build | 4 / 3 | green at `bf069b1` |

`h2:has-text(…)` is used 3× and `.topbar h2` 3× — both must survive a title
element change or be migrated deliberately.

## 8. What this audit did not find

- No route reachable only through a sidebar item.
- No client-side authorization: `visible` predicates are convenience over
  already-resolved `role`/`verLevel`; the server answers 401/403/404 for
  hidden routes identically (navLive N1/N3 negatives).
- No server data fetched to draw navigation beyond the one
  `/org/verification/me` call per session.
- No history pollution: section clicks `replaceState`; only opening an entity
  (room, brief, watchlist) `pushState`.
