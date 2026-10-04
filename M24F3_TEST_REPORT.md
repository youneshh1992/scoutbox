# M24F.3 — Test report

Baseline `f221c90`. Working tree at the R5 commit. Run on the session container
(Chromium via playwright-core, live `scoutbox-server` per suite, demo bundles from
`e2e/buildDemos.mjs`). Nothing was pushed.

## 1. Five-application gate

| Gate | Result |
| --- | --- |
| Typecheck (`tsc --noEmit`) | Pro ✓ · Grassroots ✓ · Agent ✓ · Trust & Safety ✓ · Player ✓ (5/5) |
| Build (`vite build` ×4, `expo export` web) | 5/5 |
| Demo bundles (`buildDemos.mjs`, `buildConnectedDemo.mjs`) | built; `demoFreshness` 21/21 against the committed source |
| Player lint (`expo lint`) | 48 problems (35 errors, 13 warnings) — M24F.2 baseline 51 (36 / 15): no new finding; one import-order block and one unused import that M24F.3 had introduced were removed |
| `m24f3DensityAudit` (static minimalism gate) | 50 / 50 |
| `m24f2DensityAudit` | 37 / 37 |
| `m24fVisualAudit` | 48 / 48 |
| `caseNav` | 127 / 127 |
| `demoHostOrdering` | 15 / 15 |

## 2. New suites

| Suite | Checks | Notes |
| --- | --- | --- |
| `m24f3DensityAudit.test.mjs` | 50 passed | Roots carry no banned pattern; opportunity preview one templated line; inbox preview one line; Trust root without policy version; Passport root without disclaimer; timeline root without "Where is this from?"; no seconds anywhere; trial token (accent + "Trial") with computed AA ratios (light 6.5:1, dark 9.1:1); portals route every hint through Hint/About; audit document complete with no unaccepted TOO DENSE row |
| `m24f3InboxLive.test.mjs` | 74 passed, 0 page errors | Seeds over the API: Eastport contact + two-slot trial for Kola, Harbour offer (issued) + accepted + signing presented, Eastport request for Elias who then blocks. At 390 / 430 / 1024: three tabs, compact rows (≤ 96 px), no body text on the list, no seconds / ISO dates, one gold "Trial" row, trial card with Accept / Decline + two slot chips, "View full message" reveals message + venue, Offer / Signing rows with accents, Offer row → Opportunities › Offer, Requests tab holds requests only; Accept → Accepted → conversation row → "Message…" composer → sent bubble → unread dot clears; blocked player: screen refuses, API 403 |
| `m24f3MinimalLive.test.mjs` | 101 passed, 0 page errors | Demo bundle at 390 / 430 / 1024: Passport root 933 chars vs 2 730 (M24F.2), status/club/availability/evidence rows, no provenance prose, About opens, timeline ≤ 4 rows + Show all, rows open to show source, Trust root without policy version, breakdown + About behind "View breakdown", board rows one line (preview ≤ 40 px) opening to requirements + action, fit one line + Check fit + Why. Live bundle: Inbox fewer characters than M24F.2, request row compact, Accept / Decline visible, message hidden until "View full message", safeguarding line one sentence |

## 3. Regression battery (46 suites)

First full run after R1–R4 (`m24f3-battery.sh`), then targeted re-runs after each
suite was re-pointed to the folded copy. Final state of every suite:

| Suite | Final result | Re-pointed for M24F.3? |
| --- | --- | --- |
| m24f3InboxLive | 74 ✓ | new |
| m24f3MinimalLive | 101 ✓ | new |
| m24f2DensityLive | 262 ✓, 0 page errors | — |
| m24fPlayerProfileLive | 191 ✓ | — |
| m24fVisualLive | 182 ✓ | guardian alternative dates were raw-ISO pills (product fix: day buttons) |
| m24eScrollLive | 48 ✓ | — |
| m24dAuthLive | 112 ✓ | — |
| m24dNavLive | 40 ✓ | — |
| navLive | 65 ✓ | — |
| m24CaseNavLive | ✓ | — |
| preM24SweepLive | ✓ | — |
| uiSpotcheck | ✓ | slot picker is the row's slots (trial-slot / alt-slot ids) |
| m12DemoSpotcheck | ✓ | — |
| m13DemoSpotcheck | ✓ | opens About before reading the budgets / support desk / backups notes |
| m14DemoSpotcheck | ✓ | — |
| m23AgentDemoSpotcheck | ✓ | opens About before reading honesty lines (Home, compliance, transactions, T&S) |
| m182DemoSpotcheck | ✓ | — |
| demoOffline | ✓ | — |
| crosstab | ✓ | leaves the request detail, opens the conversation row; composer "Message…" |
| liveIntegration | ✓ | detail / thread back controls; threads picked by club name (rows sort by latest message) |
| m12Live | ✓ | Apply behind the board row's "View details" |
| m13Live | ✓ | same; fit reasons behind "Why" |
| m14Live | ✓ | — |
| m15Live | 21 ✓ | About Passport, add-achievement / add-career / share disclosures, conflict row, provenance word "Player supplied" |
| m16Live | 10 ✓ | T&S Box Cam statement behind About |
| m182Live | 37 ✓ | — |
| m20Live | 59 ✓ | — |
| m21Live | 68 ✓ | "About these counts" / "About this target" |
| m23Live | 39 ✓ | — |
| m23ContactLive | 82 ✓ | empty-state words; guardian note + reply field behind "View full message" |
| m23DecisionLive | 86 ✓ | — |
| m23TrialLive | 122 ✓ | message behind "View full message"; one-line slot chip (zone applied, not printed) |
| m23OfferLive | 98 ✓ | "About offers" on the guardian section (A6 is a known pre-existing flake: failed once in the M24F.2 battery too, passed on re-run) |
| m23OfferHardeningLive | 53 ✓ | — |
| m23SigningLive | 134 ✓ | — |
| m23SigningHardeningLive | 68 ✓ | — |
| m23RecruitmentJourneyLive | 85 ✓ | — |
| m23RecruitmentJourneyHardeningLive | 57 ✓ | — |
| m23AgentLive | 91 ✓ | About opened on each swept screen |
| m23AgentIntegrationLive | ✓ | hand-off honest line behind About |
| m23AgentGrassrootsLive | 49 ✓ | — |
| m23AgentTransactionLive | 116 ✓ | honest lines behind About; deep link to Clubs › History (where transactions have lived since M24F.2) |
| entryCredit | 31 ✓ | — |

No suite was weakened: every re-point opens the disclosure that now holds the
wording and asserts the same sentence, or targets the new row / control by test id.

## 4. Captures

`design-system/screenshots/m24f3-before-*` (baseline bundles) and `m24f3-after-*`
(this tree) at 390 and 1024: inbox, request, request-open, trial-invite,
contact-request, passport, timeline, development, trust-open, explore,
opportunity-open, fit-open; plus `m24f3-after-inbox-desktop-1024.png` and
`m24f3-after-inbox-live-390.png` from the live seeded Inbox.

## 5. Density evidence

`M24F3_SCREEN_DENSITY_AUDIT.md` — 96 screens across the five applications, before
→ after, with classification and fix. Raw crawls in the session scratchpad.
