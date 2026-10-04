# M24F.4 — Test report

Baseline `d1fc3f1` (M24F.3). Run on the session container: Chromium through
playwright-core, a live `scoutbox-server` per live suite, demo bundles from
`e2e/buildDemos.mjs` and `e2e/buildConnectedDemo.mjs`. Nothing was pushed.

Order of work: the full battery ran once on the R1–R5 tree plus the new suites.
Every failure was investigated, fixed in the product or re-pointed to the row that
now holds the same content (no assertion was weakened), and re-run on the final
tree. The demos were rebuilt after the last code change and the gate suites
re-run against them.

## 1. Five-application gate

| Gate | Result |
| --- | --- |
| Typecheck (`tsc --noEmit`) | Pro ✓ · Grassroots ✓ · Agent ✓ · Trust & Safety ✓ · Player ✓ (5/5), re-run on the final tree |
| Build (`vite build` ×4, `expo export` web) | 5/5 |
| Demo bundles | rebuilt after the last change; `demoFreshness` 21/21 |
| Player lint (`expo lint`) | 48 problems (35 errors, 13 warnings), the M24F.3 baseline. The first battery saw 49: one new "impure function during render" in the Activity page, fixed (defect 18) |
| Font gate (`m24f4MinimalismAudit` + `m24f4PortalMinimalLive`) | Inter computed on every crawled element; the only other faces are the wordmark (Albert Sans) and the Player `@font-face` declarations |

## 2. New suites

| Suite | Checks | What it holds |
| --- | --- | --- |
| `m24f4MinimalismAudit.test.mjs` (static) | 60 / 60 | The reset roots render rows, not paragraphs; Home header carries name, football line, availability and a "Joined" line from `createdAt` only; NEXT is one action; RECENT ≤ 3 + "View all activity"; Development / Box Cam / Combine / Passport roots as rows with their detail one tap deep; Combine root names only; Evidence counts from real sources; Offer has "View terms" and "Offer acceptance is not a signature."; Grassroots radar read line; Nobody Missed ring from canonical counts; Director Dashboard ≤ 4 KPIs with every m20 contract preserved; zero emoji; no seconds in any time format; Inter tokens; the audit document is complete with no open row |
| `m24f4PlayerMinimalLive.test.mjs` | 476 / 476 | Demo bundle at 320 / 360 / 390 / 430 / 640×360: root word budgets (Home ≤ 120 words), zero paragraphs over 140 characters on roots, ≥ 80 % rows without a sub-note, no horizontal overflow, Inter computed, no emoji, no seconds, every root row opens its page and Back returns, Offer terms open, Evidence rows open their pages |
| `m24f4PortalMinimalLive.test.mjs` | 316 / 316 | Pro and Grassroots at 1024 / 1280 / 1440 in light and dark: Director Dashboard executive layer (≤ 4 KPIs, funnel, time by stage, coverage ring, ≤ 5 attention links that navigate), Nobody Missed ring and grouped compact rows that expand, Grassroots radar read line and edit, flat squad rows; Inter computed; zero page errors |

## 3. Regression battery — browser (53 suites)

Final state of every suite. "Re-pointed" means the assertion is unchanged and the
suite first opens the row or disclosure that now holds the content.

| Suite | Final result | M24F.4 change |
| --- | --- | --- |
| m24f3InboxLive | 74 ✓ | — (re-run after the Updates change) |
| m24f3MinimalLive | 104 ✓ | — (re-run after the Updates change) |
| m24f2DensityLive | 262 ✓, 0 page errors | — |
| m24fPlayerProfileLive | 191 ✓ | — |
| m24fVisualLive | 182 ✓ | first run 180 ✓ 2 ✗: Home had no primary action when nothing waited. Product fix: "Explore clubs" (defect 15) |
| m24eScrollLive | 48 ✓ | first run 1 ✗ on the flatter Grassroots squad page. Re-pointed: scrolls to the end when needed (defect 19) |
| m24dAuthLive | 112 ✓ | — |
| m24dNavLive | 40 ✓ | — |
| navLive | 65 ✓ | — |
| m24CaseNavLive | 85 ✓ | — |
| preM24SweepLive | 30 ✓ | — |
| uiSpotcheck | OK | re-pointed: "Manage …'s profile" before the pairing code; waits for "Your journey" |
| m12DemoSpotcheck | OK, 0 page errors | re-pointed: opens "Evidence record" first |
| m13DemoSpotcheck | OK | — |
| m14DemoSpotcheck | OK | — |
| m17DemoSpotcheck | 47 ✓ | — |
| m18DemoSpotcheck | all checks passed | re-pointed in R4: opens a candidate row first |
| m181DemoSpotcheck | all checks passed | first run 2 ✗, pre-existing (failed on the M24F.3 bundles too). Product fix: the Discover ordering sentences name evidence confidence (defect 17) |
| m182DemoSpotcheck | all checks passed | — |
| m21DemoSpotcheck | all checks passed | re-pointed: reads root, Goals (each "About this target" opened) and Feedback |
| m23AgentDemoSpotcheck | 23 ✓ | — |
| demoOffline | OK | — |
| crosstab | OK | — |
| liveIntegration | OK | — |
| m12Live | OK | re-pointed: opens "Evidence record" first |
| m13Live | OK | — |
| m14Live | L1–L7 ✓ | — |
| m15Live | 21 ✓ | re-pointed in R1 (Achievements / Club history rows) |
| m16Live | 10 ✓ | re-pointed in R1 (`boxcam-start`) |
| m17Live | 25 ✓ | — |
| m18Live | 60 ✓ | re-pointed in R4 |
| m181Live | 37 ✓ | — |
| m182Live | 37 ✓ | — |
| m20Live | 59 ✓ | — (every m20 contract preserved under the executive layer) |
| m21Live | 68 ✓ | re-pointed in R1 (Goals page) |
| m22Live | ✓ | re-pointed in R1 (`boxcam-start`) |
| m23Live | 39 ✓ | — |
| m23ContactLive | 82 ✓ | first run 1 ✗ (M6). Product fix: the child's Updates rows say "Guardian-managed" (defect 16) |
| m23DecisionLive | 86 ✓ | — |
| m23TrialLive | 122 ✓ | first run 1 ✗ (N12). Same product fix as M6 |
| m23OfferLive | 98 ✓ | re-pointed in R2 ("View terms") |
| m23OfferHardeningLive | 53 ✓ | re-pointed: opens "View terms" before S2e (club message) and S3f (replaced revision) |
| m23SigningLive | 134 ✓ | — |
| m23SigningHardeningLive | 68 ✓ | — |
| m23RecruitmentJourneyLive | 85 ✓ | — |
| m23RecruitmentJourneyHardeningLive | 57 ✓ | — |
| m23AgentLive | 91 ✓ | — |
| m23AgentIntegrationLive | 98 ✓ | — |
| m23AgentGrassrootsLive | 49 ✓ | — |
| m23AgentTransactionLive | 116 ✓ | — |
| entryCredit | 31 ✓ | — |
| m24f4PlayerMinimalLive / m24f4PortalMinimalLive | 476 ✓ / 316 ✓ | new (re-run on the final demos) |

Static suites in the same battery: `m24f3DensityAudit` 50 ✓, `m24f2DensityAudit`
37 ✓, `m24fVisualAudit` 48 ✓, `caseNav` 127 ✓, `demoHostOrdering` 15 ✓.

## 4. Regression battery — server (14 suites)

| Suite | Result |
| --- | --- |
| m23RecruitmentJourneyE2E | 168 ✓ |
| m23RecruitmentJourneyPersistence | 139 ✓ |
| m23OfferHardeningE2E | all ✓ |
| m23SigningHardeningE2E | all ✓ |
| m23SigningE2E | all ✓ |
| m23SigningPersistence | all ✓ |
| m23TemporalIntegrityE2E | 493 ✓ |
| m23AgentIntegrationE2E | 535 ✓ |
| m23AgentE2E | all ✓ |
| m23AgentComplianceE2E | all ✓ |
| m20E2E | all ✓ |
| m23E2E | all ✓ |
| m182E2E | all ✓ (re-run after the ordering sentences changed; it still says "not ability" and "not the Trust Score") |
| m23TrialE2E | all ✓ |

## 5. Final re-run on the rebuilt demos

After the last code change (the Grassroots First Team Seekers sentence) every demo
was rebuilt and these suites ran on the final tree:

| Suite | Result |
| --- | --- |
| demoFreshness | 21 ✓ |
| m24f4MinimalismAudit | 60 ✓ |
| m181DemoSpotcheck | all checks passed, 0 page errors |
| m18DemoSpotcheck | all checks passed, 0 page errors |
| m23OfferHardeningLive | 53 ✓ |
| m24f4PortalMinimalLive | 316 ✓ |
| m182E2E (server) | all ✓ |

The Player bundle did not change after the previous rebuild, on which
m24f4PlayerMinimalLive (476 ✓), m24f3InboxLive, m24f3MinimalLive, m24fVisualLive,
m23ContactLive, m23TrialLive, m12Live, m21DemoSpotcheck, m12DemoSpotcheck,
uiSpotcheck and m24eScrollLive all passed.

## 6. Captures and density evidence

- `design-system/screenshots/m24f4-before-*` (from the preserved M24F.3 bundles)
  and `m24f4-after-*` (this tree), with `m24f4-before-metrics.json` and
  `m24f4-after-metrics.json`.
- Route audit (`M24F4_ALL_APP_SCREEN_AUDIT.md`): 179 screens across five apps;
  visible words 26 931 → 23 910; bordered elements 1 405 → 1 160; 129 GOOD,
  50 accepted with a reason, 0 open; 0 non-Inter, 0 emoji, 0 seconds.
- Player reset roots (`M24F4_PLAYER_VISUAL_RESET.md`): 3 701 → 1 449 words
  over the eight reset screens.

## 7. Known flakes

- `m23OfferLive` A6: pre-existing since M24F.2, fails about one battery in three,
  passes on re-run. It passed in this battery.
