# M24F.2 — Test report

Baseline `e5fe716` (M24F.1). Everything below ran on the final tree of this
pass, in this environment (Chromium, live `scoutbox-server`, the Expo web
export and the five demo bundles). No server file was touched.

## Five-application gate

| Gate | Result |
|---|---|
| Typecheck | 5 / 5 (Pro, Grassroots, Agent, Trust & Safety, Player) |
| Build / export | 5 / 5 (four Vite builds, the Expo web export) |
| Player lint | 36 errors / 15 warnings — the pre-existing baseline exactly; the one new error this pass introduced (the copied `useLoad`) was fixed before the gate |
| Demo bundles | rebuilt after the last source change; `demoFreshness` 21 / 21 on the final bundles; `demoHostOrdering` 15 / 15 |

## New gates

### `e2e/m24f2DensityAudit.test.mjs` — 37 static checks, 0 failed

Player › Clubs and › Account are four categories each (≤ 5) with the agreed
names; the section is derived from `?section=` and every change is a
history entry; Suitability preferences render under Account › Preferences
and not under Clubs; Development holds the feedback behind "View details";
the Account root rows carry no sub-note and the category pages a back
control. Grassroots: no diagonal gradient on the entry introduction in
`platform.css`; no stylesheet carries a photograph or a centre-circle motif and the
asset is not on disk; the entry has no bullet points and no demo notice;
pitch markings are dark-only; the navy

sidebar keeps a readable Sign out. Agent: the active-navigation tokens are
gold in both themes, no green, with the inset bar. The M24F.1 profile keeps
its four sections and its header / current action. Sign out in all six
places; Switch account beneath the Account list. The ™ recipe (8 px, raised,
pulled back over the square, 2 px optical gap) on the brand and the entry
headings, no rule re-introducing the old gap, the mark announced as
"trademark", the Player Wordmark stacking TM over the square. No generic
opener ("Manage your…", "Here you can…", "Use this to…", "Control how…",
"Choose whether…") in the five applications' UI source; the design system
states the rule. The Grassroots Home has its six parts, exactly one primary
action and no percentage; it replaces the bare feed.

### `e2e/m24f2DensityLive.test.mjs` — 266 live checks, 0 failed, 0 page errors (147 s)

| Area | What is asserted |
|---|---|
| Player 390×844, 640×360, 1024×700, 1440×900 | the Wordmark's mark column starts 2–6 px after the word, the TM raised and small, announced "trademark"; Clubs: four categories in a tablist, one selected, ≥ 40 px targets, Current default; Clubs root ≤ 2700 px of scroll (M24F.1: 4450); Requests / Development / History reachable with `?section=`; no horizontal overflow on any category; browser back → Development, forward → History; Enter on the focused Current tab opens it and keeps focus; `/you?tab=clubs&section=development` opens Development and a refresh keeps it; Account: the root list of four, no sub-note under a category row, Switch account and Sign out beneath, root ≤ 1100 px (M24F.1: 1280); each category opens with `?section=`, no overflow, back control returns to the root; `/you?tab=account&section=privacy` opens Privacy with the safeguarding rules in reach; browser back returns to the root |
| Player demo | Development shows a "View details" per club; opening it reveals the feedback texts with Log progress as the one primary inside |
| Grassroots entry, four viewports | the M24E green introduction (restored at the Founder's direction: no photograph, no centre-circle motif), the headline and one sentence (no points, no notice), no `img`, the panel named by its headline, the form without an image, no overflow, the ™ geometry |
| Grassroots light 390 / 1024 / 1440 | canvas `rgb(247,249,252)` with no background image and navy ink; sidebar `rgb(6,56,86)`, active destination white on the green wash with an inset bar, Sign out `rgb(255,180,168)`, the sidebar ™; Home: exactly one primary action, the six parts in order, Club progress ≥ 4 facts with no percentage, ≤ 8 activity rows, 4 quick actions, no overflow, a progress row navigates |
| Grassroots dark 1440 | the frozen M24E tokens unchanged, the computed workspace / sidebar / top bar / body / active colours identical, the grain present and no photograph |
| Agent dark and light 1440 | the active destination's text is gold (`rgb(208,181,123)` / `rgb(122,90,28)`), the inset bar gold (`rgb(199,169,107)` / `rgb(166,124,46)`), no green anywhere on it, the icon gold, on Home, Clients, Transactions and Inbox; the sidebar ™ |
| Agent entry, four viewports | the ™ geometry on the entry heading, no overflow |

### Measured scroll heights (390 px, demo data)

| Page | Before | After |
|---|---|---|
| Clubs root | 4450 | 1635 (−63 %) |
| Clubs › Requests / Development / History | — | 1545 / 844 / 1800 |
| Account root | 1280 | 844 (−34 %, one screen) |
| Account › Profile / Privacy / Preferences / Appearance | — | 844 each |

## Suites updated for the new state

| Suite | Change |
|---|---|
| `m24fVisualAudit` | 48 checks: the Grassroots LIGHT tokens (cool canvas, navy sidebar, white surfaces, green, ink), the base turf tokens for dark, grain and markings dark-only, the M24E green entry panel restored, no photograph or centre-circle rule anywhere, no asset on disk |
| `m24fVisualLive` | 182 checks: the entry is the M24E green panel with its bands and no photograph; the page and form keep the shared scheme; the light workspace is the cool canvas with the navy sidebar, no grain, no markings, navy ink |
| `m24dAuthLive` | 112 checks: Grassroots exempt from "desktop shows the points" (it has none) |
| `m23AgentLive`, `m23AgentIntegrationLive` | the licence is one fact (the caveat only when unverified); each disclosure row's Turn on / Turn off control is the statement |
| `m12DemoSpotcheck`, `m12Live`, `m13DemoSpotcheck`, `m13Live`, `m14DemoSpotcheck`, `m15Live`, `uiSpotcheck` | re-pointed at Clubs › Current / Development / History and Account › Preferences / Privacy; the You link matched by prefix |
| nine Agent / M13–M15 suites | the You tab link matched by prefix (`a[href^="/you"]`) — the link now carries `?tab=` |

## Regression battery (final tree)

| Suite | Result |
|---|---|
| m24fVisualAudit / m24f2DensityAudit / caseNav | 50 / 38 / 127 passed |
| m24f2DensityLive / m24fPlayerProfileLive | 266 / 191 passed, 0 page errors |
| m24dAuthLive / m24eScrollLive / m24fVisualLive | 112 / 48 / 182 passed |
| m24CaseNavLive / m24dNavLive / navLive / preM24SweepLive | 85 / 40 / 65 / 30 passed |
| uiSpotcheck, m12 / m13 / m14 / m23Agent demo spotchecks, demoOffline, crosstab, liveIntegration | all green |
| m12Live / m13Live / m14Live / m15Live / m16Live / m21Live / m23Live | green (m13Live green on the rerun after its exact-match You link was prefixed) |
| m23 Contact / Decision / Trial / Offer / OfferHardening / Signing / SigningHardening / RecruitmentJourney / RecruitmentJourneyHardening | 82 / 86 / 122 / 98 / 53 / 134 / 68 / 85 / 57 passed (Offer: one A6 timing miss on the Issue button in the battery, 98 / 98 on the rerun) |
| m23AgentLive / m23AgentIntegrationLive / m23AgentGrassrootsLive / entryCredit | 91 / 98 / 49 / 31 passed (both Agent suites green on the rerun after their assertions were re-pointed at the M24F.2 copy and at Clubs › Requests; one C6 confirmation wait missed once and passed on the next run) |
| Final pass on the rebuilt demos | demoFreshness 21 / 21 · demoHostOrdering 15 · uiSpotcheck · m12DemoSpotcheck · m13DemoSpotcheck · m23AgentDemoSpotcheck green |

## Accessibility and responsiveness

The category tabs are `role="tab"` in a `tablist` with `aria-selected`,
≥ 40 px targets, Enter opens a focused tab and keeps focus (live). Gold is
never the only carrier of the Agent's active state (inset bar +
`aria-current`). The Grassroots centre circle is CSS background (no image
element, the panel named by its headline). The ™ is announced
"trademark"; the brand text is "ScoutBox". Viewports exercised: 320 / 360
/ 390 / 430 (m24dAuthLive, m24fPlayerProfileLive), 390 / 430 / 1024 / 1440
(m24fVisualLive), 390 / 640×360 / 1024 / 1440 (m24f2DensityLive), 768 and
1280 (m24dAuthLive, m24eScrollLive). No horizontal overflow on any
asserted page.

## Captures

`design-system/screenshots/m24f2-before-*` (Clubs and Account roots at
390, the Grassroots entry and light / dark Home, the Agent entry and
sidebar, the wordmark close-ups) and `m24f2-after-*` (the same, plus
every Clubs and Account category at 390, the Grassroots light Home, the
Agent sidebar in dark and light, the wordmark close-ups on Grassroots,
Pro, Trust & Safety, Agent and the Player).

## Domain

Lifecycle changed: NO. Player authorization changed: NO. Trial / Offer /
Signing semantics changed: NO. Trust Score semantics changed: NO. Schema
changed: NO (`SCHEMA_VERSION = 2308`). No server file touched.

## Defects

See `M24F2_DEFECT_REGISTER.md`: six found and fixed during the pass; open
critical 0, high 0, medium 0, low 0.
