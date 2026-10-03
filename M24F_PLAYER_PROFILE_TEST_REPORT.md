# M24F.1 — Player profile: test report

Baseline `88993b8` (M24F with the Grassroots scheme restored). Everything
below ran on the final tree of this pass, in this environment (Chromium,
live `scoutbox-server`, the Expo web export and the five demo bundles).

## New suite — `e2e/m24fPlayerProfileLive.test.mjs`

191 checks, 0 failed, 0 page errors (103 s). Live Player bundle against a
live server (Kola Adeyemi, seeded; a freshly signed-up player) and the
demo bundle (Kola with the pending trial invitation).

| Area | What is asserted |
|---|---|
| Data | the header reads `GET /player/me`: name, position · place, the availability word, the Verified state and the age in the essentials equal the server's values — nothing fabricated |
| Viewports | 320×568, 360×640, 390×844, 430×932, 640×360: the name is the heading at ≥26px/700, Inter on the name, the line and the tabs, four `role="tab"` sections in a `tablist` (one selected, all ≥44px), no pill on the header or the Overview, no full-width bordered card without an action, no horizontal overflow |
| Reachability | every section scrolled to its end: the last element sits above the bottom navigation (never covered), no horizontal overflow, no pictograph, no club-private word (watchlist, priority, Second Look, decision rationale, internal note, Recruitment Room, private assessment, scouting opinion, shortlist) |
| Keyboard / links | Enter on a focused tab opens its section and keeps focus; `?section=` in the URL; `/you?tab=profile&section=journey` and `/profile?section=evidence` open the right section; browser back and forward return to the previous profile location |
| Current action | demo: ONE action — the seeded club's trial invitation — with exactly one primary button, "View invitation", opening the Inbox; live fresh server: "You're up to date." and no action surface |
| Long name | a 51-character name and a 42-character place signed up on the live server (`POST /auth/player/signup`) and signed in through the Player sign-in: the name wraps inside the gutters at full size at 320 and 390, the place wraps, no overflow |
| Photo | no photograph on file: the initials avatar, no `img` in the header (no broken image) |

## Suites updated for the four sections

| Suite | Change |
|---|---|
| `uiSpotcheck` | the season and the cohort are read on Performance, the references on Evidence; the You link is matched by prefix (expo-router keeps `?section=` on the tab link) |
| `m12DemoSpotcheck`, `m12Live` | the Evidence passport is read on the Evidence section; prefix match for the You link |
| `m24fVisualAudit` | +1 check: no product source builds a pictograph from code points (the old profile's country flag) — 45 checks |

## Regression battery (final tree)

| Suite | Result |
|---|---|
| Typecheck | 5 / 5 |
| Build / export | 5 / 5 (four Vite builds, the Expo web export) |
| Player lint | 36 errors / 15 warnings — the 36 errors are the pre-existing baseline; two baseline warnings fewer, none new |
| m24fVisualAudit | 45 passed |
| m24dAuthLive / m24eScrollLive / m24fVisualLive | 112 / 48 / 182 passed |
| m24CaseNavLive / m24dNavLive / navLive | 85 / 40 / 65 passed |
| preM24SweepLive | 30 passed |
| Player journeys: m23Contact / Decision / Trial / Offer / OfferHardening / Signing / SigningHardening / RecruitmentJourney / RecruitmentJourneyHardening | 82 / 86 / 122 / 98 / 53 / 134 / 68 / 85 / 57 passed |
| m12Live, m13Live, m14Live, m15Live, m16Live, m21Live, m23Live, entryCredit | all green |
| liveIntegration, crosstab, demoOffline, demoHostOrdering, m13 / m14 / m23Agent demo spotchecks | all green |
| Final pass on the rebuilt demos and fresh Player bundles | demoFreshness 21 / 21 · demoHostOrdering 15 · uiSpotcheck green · m12DemoSpotcheck green · m12Live green · m24fPlayerProfileLive 191 passed, 0 page errors · m24fVisualAudit 45 |

## Domain

Lifecycle changed: NO. Player authorization changed: NO. Trial / Offer /
Signing semantics changed: NO. Trust Score semantics changed: NO (it is
not on the profile; where the CV quotes it, it says "evidence confidence
— not a rating"). Schema changed: NO (`SCHEMA_VERSION = 2308`). No server
file touched.

## Defects

Open critical: 0. Open high: 0. Open reasonably-fixable medium: 0. Open
relevant low (security, privacy, authorization, data integrity): 0.

Found and fixed during the pass: the country flag built from code points
on the old profile (the one product emoji the M24F literal scan missed) —
removed, and the gate now forbids the construction.
