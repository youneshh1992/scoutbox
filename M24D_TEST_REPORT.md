# M24D — Test report

Tree: three M24D commits on `claude/desktop-project-migration-wyk3ec`,
local only, nothing pushed, no pull request, no deployment). Every suite
below ran sequentially on this tree from a clean `dist-live*` state (the
battery script rebuilds every bundle it drives). Results are filled in from
the battery's status file; a line that is not here did not run.

## Static

| Check | Result |
|---|---|
| typecheck (Pro, Grassroots, Agent, Trust & Safety, Player) | 5 / 5 pass |
| production build (Pro, Grassroots, Agent, Trust & Safety) + Player web export | 4 / 4 + export pass |
| Player lint (`expo lint`) | 36 errors, 17 warnings — the pre-existing baseline, unchanged by M24D (no new finding) |
| demo bundles (`buildDemos`, `buildConnectedDemo`) | pass; `demoFreshness` 21 checks |
| `navConfig` (the five rule on every application; the new IA; the validators) | 504 checks passed |
| `caseNav` (every case model ≤ 5; the Player's five categories and legacy links) | 127 checks passed |

## Server-side end to end

| Suite | Result |
|---|---|
| `m23RecruitmentJourneyE2E` | first run failed on a stale source check (D11 / D12), pass after the suite fix |
| `m23RecruitmentJourneyHardeningE2E` | pass |
| `m23OfferHardeningE2E` | pass |
| `m23SigningHardeningE2E` | pass |
| `m23AgentIntegrationE2E` | first run failed on a stale source check (D11 / D12), pass after the suite fix |
| `m23AgentFinalHardeningE2E` | pass |
| `preM24SweepE2E` | pass |

## Browser (live and demo)

| Suite | Result |
|---|---|
| `entryCredit` | pass — entryCredit: 31 checks passed — the credit is present on Club, Grassroots, Age |
| `navLive` | pass — navLive: 65 checks passed — N1–N17 complete |
| `m24dNavLive` | pass — m24dNavLive: 40 checks passed |
| `m24dAuthLive` | pass — m24dAuthLive: 83 checks passed |
| `m24CaseNavLive` | pass — M24B CASE NAV LIVE: 85 checks passed (8 negative, 9%) |
| `liveIntegration` | pass |
| `crosstab` | pass |
| `demoOffline` | pass |
| `uiSpotcheck` | pass |
| `demoFreshness` | pass — demoFreshness: 21 checks passed |
| `demoHostOrdering` | pass — demoHostOrdering: all 15 checks passed |
| `m12Live` | pass |
| `m12DemoSpotcheck` | pass |
| `m13Live` | first run failed (a Board sub-tab the suite still named — D10b); rerun after the fix: pass (M13 LIVE INTEGRATION OK) |
| `m13DemoSpotcheck` | pass |
| `m14Live` | pass — m14Live: L1–L7 all passed (separate contexts, live backend) |
| `m14DemoSpotcheck` | pass |
| `m15Live` | first run failed (the Passport tab moved to Evidence — D13); sequential rerun: rc=0 fails=0 |
| `m16Live` | first run failed (the Box Cam tab moved to Evidence — D13); sequential rerun: rc=0 fails=0 |
| `m162Live` | first run failed (the demo rows under load from a concurrent rerun — D14); sequential rerun: rc=0 fails=0 |
| `m162DemoSpotcheck` | pass — m162DemoSpotcheck: 21 checks passed — Trust Score demo story OK, zero page err |
| `m17Live` | pass — m17Live: 25 checks passed — Recruitment Room journeys complete |
| `m17DemoSpotcheck` | pass — m17DemoSpotcheck: 47 checks passed — Recruitment Rooms demo story OK, zero pag |
| `m18Live` | pass — m18Live: 60 checks passed — Second Look and Nobody Missed journeys complete |
| `m18DemoSpotcheck` | pass — M18 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m181Live` | pass — M18.1 live browser journeys: 37 checks passed (H1–H10) |
| `m181DemoSpotcheck` | pass — M18.1 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m182Live` | pass — M18.2 live browser journeys: 37 checks passed (J1–J10) |
| `m182DemoSpotcheck` | pass — M18.2 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m19Live` | pass — M19 live journeys: 17 checks passed |
| `m19DemoSpotcheck` | pass — M19 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m20Live` | pass — M20 live journeys: 59 checks passed |
| `m20DemoSpotcheck` | pass — M20 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m21Live` | pass — M21 live journeys: 68 checks passed |
| `m21DemoSpotcheck` | pass — M21 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m22Live` | pass — M22 live journeys: 41 checks passed, 30 negative/integrity (73%) |
| `m23Live` | pass — m23Live: 39 checks passed — P2 sweep corrections verified end to end |
| `m23ContactLive` | pass — M23 P3 CONTACT LIVE: 82 checks passed (33 negative, 40%) |
| `m23DecisionLive` | pass — M23 P5 DECISION LIVE: 86 checks passed (25 negative, 29%) |
| `m23TrialLive` | pass — M23 P4B TRIAL LIVE: 122 checks passed (53 negative, 43%) |
| `m23OfferLive` | pass — M23 P6 OFFER LIVE: 98 checks passed (30 negative, 31%) |
| `m23OfferHardeningLive` | pass — M23 P6.1 OFFER HARDENING LIVE: 53 checks passed (26 negative, 49%) |
| `m23SigningLive` | pass — M23 P7 SIGNING LIVE: 134 checks passed (48 negative, 36%) |
| `m23SigningHardeningLive` | pass — M23 P7.1 SIGNING HARDENING LIVE: 68 checks passed (16 negative, 24%) |
| `m23RecruitmentJourneyLive` | pass — m23RecruitmentJourneyLive: 85 checks passed (13 negative) |
| `m23RecruitmentJourneyHardeningLive` | pass — m23RecruitmentJourneyHardeningLive: 57 checks passed (19 negative) |
| `m23AgentLive` | first run failed (a 10-second confirm wait under load — D14); sequential rerun: rc=0 fails=0 |
| `m23AgentComplianceLive` | pass — M23 P5.6C COMPLIANCE LIVE: 86 checks passed (25 negative, 29%) |
| `m23AgentTransactionLive` | pass — M23 P5.6D TRANSACTION LIVE: 116 checks passed (46 negative, 40%) |
| `m23AgentIntegrationLive` | pass — all M23 P5.6E live journeys passed |
| `m23AgentGrassrootsLive` | pass — M23 P5.6F GRASSROOTS LIVE (reconstructed): 49 checks passed (27 negative, 55%) |
| `m23AgentDemoSpotcheck` | pass |
| `preM24SweepLive` | pass — preM24SweepLive: 30 checks passed (22 negative) |

## What the M24D suites prove

- **m24dNavLive** (C1–C11, G1–G3): initial state (nothing listed on Home;
  Recruitment opens with seven headings and Discover's four pages), the
  active group on a deep link, expanding another group folds the open one
  and keeps the current page's group marked, folding the open group, deep
  links to Pipeline and Intelligence, Back / Forward, refresh, keyboard
  (Enter / Space on headings, Tab into pages, Enter navigates, aria-expanded
  / aria-controls), the 390px drawer with ≥ 32px headings, depth of three,
  never more than five pages listed and never two sections open at 1440 /
  1024 / 390, Organisation as two groups of three, Grassroots' eight groups.
- **m24dAuthLive** (83 checks): Pro, Grassroots, Agent and Trust & Safety at
  320 / 360 / 390 / 430 / 768 / 1024 / 1280 / 1440 — no overflow, the card
  and the one primary action inside the viewport, ≥ 40px targets, the points
  hidden on a phone, every field labelled, every button named, the password
  reveal announcing aria-pressed, role=alert on an empty submission, Tab
  reaching the submit with a visible ring, choice rows as named buttons with
  the arrow on the right, aria-pressed on exactly one chosen row, tabs with
  aria-selected, contrast ≥ 4.5:1 on every text, no pill / emoji / icon
  circle, ≥ 24px gutters; the Agent's three demo rows sign in; the Player at
  320 / 360 / 390 / 430 / 1024 / 1440 — the 430px column, the four rows, one
  form and one primary action on sign-in, role=alert, keyboard, contrast, no
  authenticated bottom navigation.
- **navLive** N1 / N5 / N14 / N15 / N16 (one open group, group headings as
  disclosure buttons, three taps at most), N8 (nine Trust & Safety groups,
  every tab reachable, none wider than five), N13 (the strip's More on
  Intelligence; Pipeline whole).
- **navConfig / caseNav**: the rule as data on every application.
- **m24CaseNavLive** P1–P5: the Player's five categories at 390 and 360 and
  the pre-M24D Board link.

## Not verified here

Native iOS and Android rendering of the Player (no simulator in this
environment); the same React Native components run on the web export that
every Player suite drives.
