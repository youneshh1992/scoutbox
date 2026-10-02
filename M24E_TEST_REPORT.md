# M24E — Test report

Tree: the M24E commits on `claude/desktop-project-migration-wyk3ec`, local
only — nothing pushed, no pull request, no deployment. Every suite below ran
sequentially on this tree from a clean `dist-live*` state (the battery
rebuilds every bundle it drives; a live suite never ran beside another).
Results are copied from the battery's status file and the post-battery
status file; a line that is not here did not run.

## Static

| Check | Result |
|---|---|
| typecheck (Pro, Grassroots, Agent, Trust & Safety, Player) | 5 / 5 pass |
| production build (Pro, Grassroots, Agent, Trust & Safety) + Player web export | 4 / 4 + export pass; the export lists the three bundled faces and prints no missing-font warning |
| Player lint (`expo lint`) | 36 errors, 17 warnings — the pre-existing baseline, unchanged by M24E (no new finding) |
| demo bundles (`buildDemos`, `buildConnectedDemo`) | pass twice: in the battery, and again after the inliner fix (E16); the rebuilt demos hold no `url(/assets/…)` reference and carry the Inter upright, Inter italic and Albert Sans faces as data URIs (connected demo 12.7 MB) |
| `demoFreshness` | 21 checks passed on the rebuilt demos (21 / 21) |
| `navConfig` (the five rule on every application; the validators) | 504 checks passed |
| `caseNav` (every case model ≤ 5) | 127 checks passed |

## Server-side (auth / session / journey)

| Suite | Result |
|---|---|
| `testTrust` | pass — 23 trust/safeguarding tests passed |
| `apiE2E` | first run failed in the battery (it does not boot a server; none was on :4000); run after the battery on its own freshly seeded server: pass — 130 API checks passed |
| `connectedE2E` | pass — 44 connected-mode checks passed |
| `preM24SweepE2E` | pass — PRE-M24 sweep server regressions: 36 checks passed, 23 negative, 0 fai |
| `m23RecruitmentJourneyE2E` | pass — M23 P8 Recruitment Journey: 168 checks passed, 86 negative, 0 failed |
| `m23RecruitmentJourneyHardeningE2E` | pass — M23 P8.1 Recruitment Journey Hardening: 247 checks passed, 178 negativ |
| `m23OfferHardeningE2E` | pass — all M23 P6.1 Offer hardening checks passed |
| `m23SigningHardeningE2E` | pass — all M23 P7.1 Signing hardening checks passed |
| `m23AgentIntegrationE2E` | pass — M23 P5.6E integration suite: 535 checks passed, 281 negative/security/ |
| `m23AgentFinalHardeningE2E` | pass — all M23 P5.6F reconstructed hardening checks passed |

## Browser (live and demo)

The M24E suites: `m24dAuthLive` 112 checks (M24D's 83 plus the M24E block:
fixed entry appearance with `dark` and `light` saved, no toggle on any
entry screen, Inter on the entry screens, Sign out → entry screen with the
old token refused (401), Back and a protected deep link stop at the entry
screen, the saved theme restored after sign in, Switch organisation / club /
profile → the selector, Trust & Safety key cleared, Player Sign out / Switch
account); `m24eScrollLive` 48 checks (entry screens at nine viewports for
four portals, the Agent roster, the Player entry at nine viewports, fifteen
long-named clubs on the Grassroots selector at 320×568 and 640×360, long
pages in four portals at 640×360 / 1024×600 / 1440×700, the Trust & Safety
drawer at 640×360 with Sign out inside it, the Pro sidebar at 1024×600 with
the exits on screen, palette and drawer at 1024×600, the ledger at 640×360,
Player pages at 360×640 / 640×360 / 430×932 with the tab bar never over the
last control, orientation changes, computed Inter on heading / body /
button / navigation / control in four portals, the Player's two faces as one
family, no font warning, zero page errors).

| Suite | Result |
|---|---|
| `entryCredit` | pass — entryCredit: 31 checks passed — the credit is present on Club, Grassroots, Age |
| `navLive` | pass — navLive: 65 checks passed — N1–N17 complete |
| `m24dNavLive` | pass — m24dNavLive: 40 checks passed |
| `m24dAuthLive` | pass — m24dAuthLive: 112 checks passed |
| `m24eScrollLive` | pass — m24eScrollLive: 48 checks passed |
| `m24CaseNavLive` | pass — M24B CASE NAV LIVE: 85 checks passed (8 negative, 9%) |
| `liveIntegration` | pass |
| `crosstab` | pass |
| `demoOffline` | pass |
| `uiSpotcheck` | pass |
| `demoFreshness` | pass — demoFreshness: 21 checks passed |
| `demoHostOrdering` | pass — demoHostOrdering: all 15 checks passed |
| `m12Live` | pass |
| `m12DemoSpotcheck` | pass |
| `m13Live` | pass |
| `m13DemoSpotcheck` | pass |
| `m14Live` | pass — m14Live: L1–L7 all passed (separate contexts, live backend) |
| `m14DemoSpotcheck` | pass |
| `m15Live` | pass — m15Live: 21 checks passed — P1–P8 + T&S complete |
| `m16Live` | pass — m16Live: 10 checks passed — Box Cam cross-app journey complete |
| `m162Live` | pass — m162Live: 11 checks passed — Trust Profile journeys complete |
| `m162DemoSpotcheck` | pass — m162DemoSpotcheck: 21 checks passed — Trust Score demo story OK, zero page err |
| `m17Live` | pass — m17Live: 25 checks passed — Recruitment Room journeys complete |
| `m17DemoSpotcheck` | pass — m17DemoSpotcheck: 47 checks passed — Recruitment Rooms demo story OK, zero pag |
| `m18Live` | pass — m18Live: 60 checks passed — Second Look and Nobody Missed journeys complete |
| `m18DemoSpotcheck` | first run failed in the battery (5 checks: the Inter font files 404 on the demo host — E16); rerun on the rebuilt demos: pass — M18 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m181Live` | pass — M18.1 live browser journeys: 37 checks passed (H1–H10) |
| `m181DemoSpotcheck` | first run failed in the battery (5 checks: the Inter font files 404 on the demo host — E16); rerun on the rebuilt demos: pass — M18.1 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m182Live` | pass — M18.2 live browser journeys: 37 checks passed (J1–J10) |
| `m182DemoSpotcheck` | first run failed in the battery (5 checks: the Inter font files 404 on the demo host — E16); rerun on the rebuilt demos: pass — M18.2 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m19Live` | pass — M19 live journeys: 17 checks passed |
| `m19DemoSpotcheck` | first run failed in the battery (2 checks: the Inter font files 404 on the demo host — E16); rerun on the rebuilt demos: pass — M19 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m20Live` | pass — M20 live journeys: 59 checks passed |
| `m20DemoSpotcheck` | first run failed in the battery (2 checks: the Inter font files 404 on the demo host — E16); rerun on the rebuilt demos: pass — M20 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m21Live` | pass — M21 live journeys: 68 checks passed |
| `m21DemoSpotcheck` | first run failed in the battery (2 checks: the Inter font files 404 on the demo host — E16); rerun on the rebuilt demos: pass — M21 headless spotcheck: ALL CHECKS PASSED — zero page errors |
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
| `m23AgentLive` | pass — M23 P5.6B AGENT LIVE: 91 checks passed (26 negative, 29%) |
| `m23AgentComplianceLive` | pass — M23 P5.6C COMPLIANCE LIVE: 86 checks passed (25 negative, 29%) |
| `m23AgentTransactionLive` | pass — M23 P5.6D TRANSACTION LIVE: 116 checks passed (46 negative, 40%) |
| `m23AgentIntegrationLive` | pass — all M23 P5.6E live journeys passed |
| `m23AgentGrassrootsLive` | pass — M23 P5.6F GRASSROOTS LIVE (reconstructed): 49 checks passed (27 negative, 55%) |
| `m23AgentDemoSpotcheck` | pass |
| `preM24SweepLive` | pass — preM24SweepLive: 30 checks passed (22 negative) |

## Rerun on the rebuilt demos (after E16)

All sixteen demo-facing suites were rerun on the demos rebuilt with the
inliner fix, in sequence: `demoFreshness` 21, `demoOffline`, `uiSpotcheck`,
`demoHostOrdering` 15, `m12DemoSpotcheck`, `m13DemoSpotcheck`,
`m14DemoSpotcheck`, `m162DemoSpotcheck` 21, `m17DemoSpotcheck` 47,
`m18DemoSpotcheck`, `m181DemoSpotcheck`, `m182DemoSpotcheck`,
`m19DemoSpotcheck`, `m20DemoSpotcheck`, `m21DemoSpotcheck`,
`m23AgentDemoSpotcheck` — every one rc=0, zero page errors.

## Visual captures

`design-system/screenshots/m24e-*.png` (25 files, taken from the live
bundles): the five entry screens at 1440×900, 390×844 and 640×360 with
`dark` saved (the fixed appearance), the four portal sidebars with the
account block and its exits at 1280×720 plus the account block alone, the
Pro and Trust & Safety drawers at 640×360 with Sign out inside, the Player's
Account tab at 390×844 with Sign out / Switch account above the tab bar.

## Counts

- Typecheck 5 / 5, build / export 5 / 5, demo freshness 21 / 21.
- Node suites 2 / 2; server suites 10 / 10 (apiE2E on its own seeded server).
- Browser suites 54 / 54 green on this tree (six of them after the E16 rebuild).
- Page errors across every browser context: 0.

## Open defects

None. See `M24E_DEFECT_REGISTER.md` for the sixteen entries (E1 / E1b / E2
/ E3 / E4 / E5 / E6 / E16 product or bundle defects, all fixed; E7–E15 test
corrections; E11 environment).
