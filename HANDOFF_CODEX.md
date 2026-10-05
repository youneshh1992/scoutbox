# ScoutBox — repository handoff (to Codex)

> Historical handoff, 4 October 2026. For the subsequent Founder-approved
> vivid Player UI and current rebuild instructions, read `HANDOFF_CLAUDE_UI.md`
> and `BRAND_RULES.md` first. The minimalism/freeze statements below describe
> the previous baseline, not the current approved Player design.

Prepared 2026-10-04 on branch `handoff/codex-m24f5`, built on the last
implementation commit `d39754ba17b23c96ca9b69d9964188f2f367d2fc` of
`claude/desktop-project-migration-wyk3ec` (GitHub still holds that branch at
`5268578548a0d9c976242c08c3736b611ea2de13`; the 49 commits between are local work
included here). The only additions on this branch are this document and three
capture / crawl scripts under `e2e/tools/`. No application code was changed for
the handoff.

**The design process is ongoing.** Passing tests below are engineering evidence
only; they are not Founder visual approval, and the UI is not declared finished.

## 1. Architecture and app locations

| Path | What it is | Stack |
| --- | --- | --- |
| `scoutbox-server/` | Backend for every app: domain rules, auth, recruitment lifecycle (Contact → Trial → Assessment → Decision → Offer → Signing), Agent compliance, Trust Score, Box Cam. Schema version **2308** (`m182/migrations.mjs`, `SCHEMA_VERSION`). Runtime data in `scoutbox-server/data/` (git-ignored) | Node 22, Express, file-backed store |
| `scoutbox-club/` | **Pro** portal (professional clubs) | Vite + React + TS |
| `scoutbox-grassroots/` | **Grassroots** portal (grassroots clubs). Many screen files are near-duplicates of `scoutbox-club/src` — change both | Vite + React + TS |
| `scoutbox-agent/` | **Agent** portal | Vite + React + TS |
| `scoutbox-admin/` | **Trust & Safety** console | Vite + React + TS |
| `scoutbox-player/` | **Player** app + Guardian (web build used for demos) | Expo / React Native Web, expo-router |
| `design-system/` | Shared portal CSS (`platform.css`, `tokens.css`), Inter + Albert Sans fonts with OFL licences (`fonts/`), `AuthShell.tsx`, `About.tsx`, `caseNav.ts`, `humanize.ts`, `time.ts`, screenshots | CSS / TSX |
| `e2e/` | Static audits, live browser suites, demo builders, capture tools | Node + playwright-core |
| `scripts/`, `Dockerfile`, `fly.toml`, `render.yaml`, `DEPLOY.md` | Deployment material (nothing was deployed in M24) | — |

Milestone documents (`M12_…` → `M24F5_…`) sit at the repository root;
`PROJECT_STATUS.md` is the older running status file (last updated at M18).

## 2. Current UI milestone and outstanding Founder requests

Current milestone: **M24F.5 — final Founder visual acceptance pass**, implemented
and frozen locally (`832642f`, `a2a7385`, `a473877`, then freeze closure
`58f5ee7`, `d39754b`). See `M24F5_VISUAL_ACCEPTANCE.md`,
`M24F5_KEPT_SCREEN_REVIEW.md`, `M24F5_TEST_REPORT.md`.

Outstanding Founder items:

1. **Founder visual approval of M24F.5 — pending.** Not given.
2. **M24F.5.1 — Grassroots sign-in grass photograph — blocked** (section 6).
3. Backup push of the M24 work to GitHub — not yet authorised (only this handoff
   branch is proposed for push).
4. Commit attribution: commits are authored and committed as the repository
   owner's email; GitHub may show them as "Unverified". History has deliberately
   not been rewritten.

Founder design direction already applied (do not regress): hard minimalism —
roots show one primary line, at most one short secondary line and a chevron;
detail one tap deeper; no sub-note habit; at most one short root sentence except
legal, safeguarding, consent or error wording; cards, pills and borders only
where they carry meaning; Player Home has no greeting / day / date / "View your
Passport" / "Verified clubs can see you"; Explore preserved as the Founder liked
it; Grassroots light = navy sidebar on a cool light canvas; Agent active
navigation gold; Director Dashboard executive layer only on its root.

## 3. Protected product and security invariants

- **Safeguarding / minors:** guardian control of under-18 profiles; guardian-
  managed markers; under-18 invitations only through a guardian; no-ghosting rule
  on Grassroots open days; minors-readiness wording in Agent compliance; trial
  safety pack. Never weaken or hide behind decoration.
- **Authentication / authorisation / tenant isolation:** server-side
  authorisation on every route; no cross-organisation reads; no public Pro
  registration; T&S console behind its key.
- **Recruitment lifecycle semantics:** Contact, Trial, Assessment, Decision,
  Offer and Signing are distinct states with their own contracts
  (`M23_*` documents). **Offer ≠ Signing** — "Offer acceptance is not a
  signature." stays under every offer.
- **Box Cam ≠ Assessment** — never labelled or merged with human assessment.
- **Trust Score ≠ talent score** — evidence confidence only ("Evidence
  confidence only" on the Player; "not football ability" in Pro).
- **Nobody Missed ≠ ranking** — evaluation coverage, with its honesty line.
- **Navigation:** ≤ 5 items per group (`caseNav` validator, `navConfig` suite).
- **Typography:** Inter is the computed UI face in all five apps; the only
  exception is the ScoutBox wordmark (Albert Sans). (An earlier Instrument Serif
  "Grassroots" was reverted at the Founder's direction.)
- **Zero emoji** in ScoutBox-authored UI; no seconds in ordinary timestamps.
- **No runtime external requests** from the demo bundles (fonts and assets are
  bundled).

## 4. Commands

Prerequisites: Node 22, `npm install` in each app folder and in `e2e/`, a
Chromium for playwright-core (set `CHROMIUM_PATH`; the session used
`/opt/pw-browsers/chromium`).

```bash
# Backend
cd scoutbox-server && npm start                      # http://localhost:4000 (copy .env.example → .env; ALLOW_DEV_LOGINS for dev)
# Portals (each reads VITE_API_URL; VITE_DEMO=1 for demo mode)
cd scoutbox-club && npm run dev                      # Pro
cd scoutbox-grassroots && npm run dev                # :5175
cd scoutbox-agent && npm run dev                     # :5176
cd scoutbox-admin && npm run dev                     # :5174
cd scoutbox-player && npx expo start --web           # EXPO_PUBLIC_API_URL / EXPO_PUBLIC_DEMO

# Five-app gate
for a in club grassroots agent admin player; do (cd scoutbox-$a && npx tsc --noEmit -p .); done
for a in club grassroots agent admin; do (cd scoutbox-$a && npx vite build); done
(cd scoutbox-player && npx expo export --platform web --output-dir dist-gate)
(cd scoutbox-player && npx expo lint)                # baseline: 48 problems (35 errors, 13 warnings)

# Self-contained demo bundles (git-ignored output: e2e/dist/*.html)
cd e2e && node buildDemos.mjs && node buildConnectedDemo.mjs && node demoFreshness.test.mjs

# Tests (run from e2e/; static audits are instant, live suites start their own server/builds)
node m24f5VisualAcceptanceAudit.test.mjs
node m24f5PlayerVisualLive.test.mjs                  # needs e2e/dist (buildDemos)
node m24f5PortalVisualLive.test.mjs                  # needs e2e/dist
node m23AgentLive.test.mjs                           # any *.test.mjs runs the same way
# Server suites
cd scoutbox-server && node scripts/m23RecruitmentJourneyE2E.mjs   # etc.

# Screenshots / crawl (from e2e/, after buildDemos)
CHROMIUM_PATH=… node tools/captureScreens.mjs <outdir> <prefix> all
CHROMIUM_PATH=… node tools/captureKeptScreens.mjs <outdir>           # the 50 re-reviewed screens
CHROMIUM_PATH=… node tools/assetCrawl.mjs                            # requests, fonts, images, emoji
```

## 5. Latest results, known issues, screenshots

Full detail: `M24F5_TEST_REPORT.md`. Summary at `d39754b`:

- Typecheck 5/5, build/export 5/5, demo freshness 21/21, Player lint 48
  (baseline, no new regression). Schema 2308; no server file changed in M24F.5.
- `m24f5VisualAcceptanceAudit` 63/63; `m24f5PlayerVisualLive` 436/436;
  `m24f5PortalVisualLive` 262/262 (0 page errors).
- Full browser battery (≈ 60 suites) and server battery (14 suites) green on the
  M24F.5 tree after investigated fixes / re-points (listed in the test report).
- `m23AgentLive` C6: harness synchronisation fixed in `58f5ee7`; 20/20 sequential
  passes before and 20/20 after. Known unexplained flakes: none.
- Final asset crawl of every demo bundle: 0 failed requests, 0 HTTP errors,
  0 external requests, 0 console or page errors, 0 broken images, 0 emoji;
  Inter loads in every app.
- Open defects at freeze: none Critical / High / fixable Medium / relevant Low.
- Screenshots: `design-system/screenshots/m24f5-*.png` (25 acceptance screens +
  49 `m24f5-kept-*` captures covering the 50 re-reviewed screens — two Explore routes share one capture), metrics
  `m24f5-final-metrics.json`, `m24f5-kept-index.json`. Earlier milestones keep
  their own `m24f4-*`, `m24f3-*`, … captures in the same folder.

## 6. Grassroots sign-in photograph — status

- **Founder request (M24F.5.1):** a *real* grass photograph on the LEFT panel of
  the Grassroots unauthenticated sign-in / sign-up screen only, colour-graded
  toward ScoutBox green (#33EE7C), one subtle centre-circle / halfway-line, no
  diagonals; nowhere else.
- **Current tree:** no photograph. The left panel uses a CSS turf texture
  (`design-system/platform.css`, `:root[data-app="grass"] .auth-promo`). That
  state came from M24F.2 R5 (`f221c90`), recorded as "restored … at the Founder's
  direction"; the Founder has since said that removal was a misreading.
- **Actual Founder approval:** none for any specific photograph. The Founder's
  instruction is to use the photograph **the Founder supplied**; that asset is
  not in the repository or this session (the session's uploaded images are a
  Spotify layout reference, a ScoutBox Pro sign-in screenshot, an Agent overview
  screenshot and a wordmark crop — none is grass).
- **Proposed, not approved:** the only grass photograph in the project's history
  is `design-system/assets/grassroots-auth-grass.jpg` (620×868, 206 KB, CC0
  rawpixel "Free grass closeup image", tinted; licence text
  `design-system/assets/GRASS-PHOTO-LICENCE.txt`), present at `7b7bb4d` /
  `5d94a8d` and removed in `f221c90`. Restoring it (`git show 5d94a8d:<path>`)
  was offered to the Founder as an option; it has **not** been approved.
- **Next step:** Founder either approves the historical CC0 photo or supplies the
  intended photograph; then implement M24F.5.1 as specified (scope test, live
  test at 390/430/768/1024/1440, crawl, screenshots, one commit).

## 7. Not in the repository

- `node_modules/` (all apps and `e2e/`) — install with npm.
- A Chromium build for playwright-core (`CHROMIUM_PATH`).
- Demo bundles `e2e/dist/*.html` and live-suite builds `dist-live*/` —
  generated, git-ignored.
- The demo launcher page and the published review page / demos — private
  claude.ai artifacts, not repository files.
- Server runtime data (`scoutbox-server/data/`) and real secrets — never
  committed; `.env.example` files hold empty templates only.
- The Founder-supplied grass photograph (section 6).
- Recovery bundles (`5268578..HEAD`) were created in the Claude session's
  scratchpad, outside the repository.
