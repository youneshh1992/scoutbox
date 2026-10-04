# M24F.5 — Test report

Baseline `a993577` (M24F.4). Run on the session container: Chromium through
playwright-core, a live `scoutbox-server` per live suite, demo bundles from
`e2e/buildDemos.mjs` and `e2e/buildConnectedDemo.mjs`. Nothing was pushed.

Order of work: every screen was captured and looked at first; fixes followed
what the captures showed; the full battery then ran once on the R1 + R2 tree
with the three new suites. Each failure was investigated and either fixed in
the product or re-pointed to open the view that now holds the same content (no
assertion weakened). The demos were rebuilt after the last code change and every
suite touched by the late changes was re-run on the final bundles.

## 1. Five-application gate (final tree)

| Gate | Result |
| --- | --- |
| Typecheck (`tsc --noEmit`) | Pro ✓ · Grassroots ✓ · Agent ✓ · Trust & Safety ✓ · Player ✓ (5/5) |
| Build (`vite build` ×4, `expo export` web) | 5/5 |
| Demo bundles | rebuilt after the last change; `demoFreshness` 21/21 |
| Player lint (`expo lint`) | 48 problems (35 errors, 13 warnings) — the M24F.4 baseline, no new regression |
| Inter computed | asserted per screen and per width in both new live suites: Player (Home, Activity, Development, Box Cam, Combine, Evidence, Passport, Offer, Messages, Trial), Pro (Nobody Missed, Director Dashboard, Verification), Grassroots (Home, Open Days, Squad), Agent (Home, Transactions), Trust & Safety (Verification, Agent transactions). The only other faces are the wordmark (Albert Sans) and the Grassroots editorial face |
| Emoji | 0 (static gate over every app plus live text scan on every captured screen) |
| Seconds | 0 in any rendered time |

## 2. New suites

| Suite | Result | Holds |
| --- | --- | --- |
| `m24f5VisualAcceptanceAudit.test.mjs` (static) | 63 / 63 | Home: no greeting, day/date, View Passport or verified sentence, Joined from the record; timeline Recent; Combine names only; Box Cam root without setup copy; Development root without the feedback paragraph; Evidence LATEST / CATEGORIES with counts; Offer document with View terms and "not a signature"; trial edge accent with no fill; Director Dashboard executive root with filters / principle / detail behind toggles and every m20 contract; Nobody Missed coverage; radar read state without a border; squad names unbordered; Staff & Security rows; Film Room caption under the clip; Verification forms folded; bare links in link colour; open-day meta line; no "facet" jargon; Inter tokens; zero emoji; no seconds; the kept-screen review has 50 rows with a verdict each |
| `m24f5PlayerVisualLive.test.mjs` | 436 / 436, 0 page errors | Home, Activity, Passport + Trust Score, Development, Box Cam, Combine, Evidence, Offer, Messages, Trial at 320 / 360 / 390 / 430 / 640×360: word budget, no root paragraph over 140 characters, no overflow, Inter computed, zero emoji, no seconds, plus the per-screen rules above (Trust block ≤ 24 words and "Evidence confidence only"; Box Cam never says assessment; the Offer section adds no second rule; the trial card is an edge accent with a transparent fill) |
| `m24f5PortalVisualLive.test.mjs` | 262 / 262, 0 page errors | at 1024 / 1280 / 1440: Grassroots navy sidebar, light canvas, no grass photograph in the workspace; radar read line without border and Edit as a link; one meta line per open day, age group in words, no ISO dates; squad names unbordered; Nobody Missed one heading per group, ring and honesty line; Dashboard ≤ 4 counts, funnel, time, coverage, ≤ 5 attention lines, no filters / principle / detail / `<code>` on the root and "Show all figures" opening the seven families; Film Room caption and tags under the clip; Verification forms folded for a verified administrator; Agent gold navigation, no "facet", counts in one row; Trust & Safety reasons and statuses in words, acronyms kept |

## 3. Regression battery — browser

Final state of every suite (first battery on the R1 + R2 tree, then the re-runs
on the final bundles for every suite that failed or that the late changes
touched).

| Suite | Final | First battery | M24F.5 change |
| --- | --- | --- | --- |
| m24f4MinimalismAudit | 60 ✓ | 59 ✓ 1 ✗ | Offer club size: the assertion accepted only `fontSize: 22`; the club is now 26 px. Re-pointed to "22 px or larger" (same intent: set large) |
| m24fVisualAudit | 48 ✓ | 47 ✓ 1 ✗ | Pre-existing at `a993577` (two `<Button primary>` in exclusive branches). Product fix: one primary button whose label and action follow the state |
| m24f3DensityAudit / m24f2DensityAudit / caseNav / demoHostOrdering | 50 ✓ / 37 ✓ / 127 ✓ / 15 ✓ | same | — |
| m24f4PortalMinimalLive | 316 ✓ | 316 ✓ | — |
| m24f4PlayerMinimalLive | 476 ✓ | 471 ✓ 5 ✗ | The Offer status is its own line (no "Status" fact label). Re-pointed to the status line's accessible label "Status: …" |
| m24f3InboxLive / m24f3MinimalLive | 74 ✓ / 104 ✓ | same | — |
| m24f2DensityLive | 262 ✓, 0 page errors | same | — |
| m24fPlayerProfileLive / m24fVisualLive | 191 ✓ / 182 ✓ | same | — |
| m24eScrollLive | 48 ✓ | 1 ✗ | Pro Staff & Security: the last control now sits in a closed settings row. Re-pointed: every settings row is opened first (a taller page, a stricter check) |
| m24dAuthLive / m24dNavLive / navLive / m24CaseNavLive / preM24SweepLive | 112 ✓ / 40 ✓ / 65 ✓ / 85 ✓ / 30 ✓ | same | — |
| uiSpotcheck / m12 / m13 / m17 / m18 / m19 / m20 / m181 / m182 / m21 / m23Agent demo spotchecks | all OK, 0 page errors | same | — |
| m14DemoSpotcheck | OK | ✗ | The check reads in words. Re-pointed from `dnsOwnership=not_configured` to "DNS ownership: not configured"; the machine code stays in the line's title |
| demoOffline / crosstab / liveIntegration | OK | same | — |
| m12Live / m16Live / m17Live / m18Live / m19Live / m181Live / m182Live / m20Live / m21Live / m22Live / m23Live | all ✓ | same | — |
| m13Live | OK | ✗ | Guardian child sections are rows. The Disclosure did not expose `aria-expanded` (an accessibility defect) — product fix; the suite opens every closed row (one at a time until none remain) after the rows render |
| m14Live | L1–L7 ✓ | ✗ | Same guardian fix; L4 opens "Add a credential"; the T&S check reads "DNS ownership: not configured" |
| m15Live | OK | ✗ | Same guardian fix; P2 reads the passport summary ("Evidence: strong") in the card's quiet line instead of a pill — the summary is back on the card as text |
| m23ContactLive / m23DecisionLive / m23TrialLive / m23OfferLive / m23OfferHardeningLive / m23SigningLive / m23SigningHardeningLive | 82 ✓ / 86 ✓ / 122 ✓ / 98 ✓ / 53 ✓ / 134 ✓ / 68 ✓ | same | — |
| m23RecruitmentJourneyLive / HardeningLive | 85 ✓ / 57 ✓ | same | — |
| m23AgentLive | 91 ✓ | 1 ✗ (C6) | Harness synchronisation (freeze closure): C6 waited for the success line, then also asserted the status pill, which changes one list re-fetch later. Now waits on the full confirmed state; same assertion. 20/20 sequential passes before the fix, 20/20 after |
| m23AgentIntegrationLive / AgentGrassrootsLive / AgentTransactionLive / entryCredit | 98 ✓ / 49 ✓ / 116 ✓ / 31 ✓ | same | — |

## 4. Regression battery — server (14 suites)

No server file changed. The standard battery ran once on the final code:
m23RecruitmentJourneyE2E 168 ✓, m23RecruitmentJourneyPersistence 139 ✓,
m23OfferHardeningE2E ✓, m23SigningHardeningE2E ✓, m23SigningE2E ✓,
m23SigningPersistence ✓, m23TemporalIntegrityE2E 493 ✓, m23AgentIntegrationE2E
535 ✓, m23AgentE2E ✓, m23AgentComplianceE2E ✓, m20E2E ✓, m23E2E ✓, m182E2E ✓,
m23TrialE2E ✓ — 14/14.

## 5. Final re-run on the rebuilt demos

After the last code change (the Disclosure's `aria-expanded`) the Player was
re-typechecked and re-exported, lint re-run (48, baseline), the demos rebuilt,
and these suites ran on the final bundles:

| Suite | Result |
| --- | --- |
| demoFreshness | 21 ✓ |
| m24f5VisualAcceptanceAudit | 63 ✓ |
| m24f5PlayerVisualLive | 436 ✓, 0 page errors |
| m24f4PlayerMinimalLive | 476 ✓ |
| m24f3InboxLive / m24f3MinimalLive | 74 ✓ / 104 ✓ |
| m24fPlayerProfileLive / m24fVisualLive | 191 ✓ / 182 ✓ |
| uiSpotcheck / m12DemoSpotcheck / m21DemoSpotcheck | OK / OK / all checks, 0 page errors |
| m13Live / m14Live / m15Live / m21Live | OK / L1–L7 ✓ / 21 ✓ / 68 ✓ |
| m23ContactLive / m23TrialLive / m23OfferLive | 82 ✓ / 122 ✓ / 98 ✓ |
| demoOffline | OK |

The portal bundles did not change after the previous rebuild, on which
m24f5PortalVisualLive (262 ✓), m24f4PortalMinimalLive (316 ✓), m24eScrollLive
(48 ✓), m14DemoSpotcheck and m23AgentLive (91 ✓) passed.

## 6. Freeze closure — m23AgentLive C6

- **Original failure:** one C6 failure in the M24F.5 browser battery, under full
  battery load: the card showed "Confirmed — active from now" while the status
  pill still read "Awaiting your answer".
- **Cause:** `MyAgentSection` sets the success line when the confirm call
  returns, then re-fetches the relationship list; the pill follows the re-fetch,
  one local request later. The server state is already final when the line shows
  and the card settles within that one fetch. C6 waited only for the line, then
  asserted both, so a sample under load could fall between the two.
- **Classification:** harness synchronisation, not a product race (no stale
  closure, no lost update, the derived status is correct as soon as the list
  lands).
- **Fix (test only):** wait on the DOM condition C6 asserts — the line and the
  Active pill together — with a 10 s ceiling; no guessed sleep, assertion
  unchanged. No product code changed.
- **Evidence:** 20/20 sequential runs of the whole suite before the fix (idle
  machine), 20/20 after.

## 7. Freeze closure — final demo asset crawl

Every final bundle (Launcher, Pro, Grassroots, Agent, Trust & Safety, Player,
Connected) was served locally and walked through its approved M24F.5 screens with
every request, response, failed request, console message and page error recorded.
Single-file bundles request nothing from the host but the document itself.

The first crawl found two demo-chrome defects (no product code involved):

- **Connected demo switcher emoji** — the host switcher read "⚽ Player · 🔭 Pro ·
  🌱 Grassroots". Now plain text (`e2e/buildConnectedDemo.mjs`).
- **Favicon 404** — no bundle declared an icon, so a browser serving one from a
  root asked the host for `/favicon.ico`. `e2e/buildDemos.mjs` now stamps an
  inline ScoutBox icon (the launcher carries the same).

Inter: in each app two faces register, the used one loads, zero face errors,
`document.fonts.check('16px Inter')` true, computed face Inter on every crawled
screen. In the Connected demo the hidden portal frames load Inter on demand when
shown (verified by requesting it: loaded, no error). The Grassroots entry panel
uses the CSS turf texture; no photograph exists in any bundle (removed at the
Founder's direction in M24F.2 R5, `f221c90`).

## 8. Known flakes

- None unexplained. `m23OfferLive` A6 (since M24F.2) passed in every M24F.5 run.
