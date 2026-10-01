# M24A — approved design implemented on the five applications

Reference: `design-system/reference/ScoutBox-Design-Explorer.html` (the
supplied `ScoutBox-Design-Explorer.html`, retained verbatim). Start state:
`5268578` (the frozen pre-M24 baseline). Nothing was pushed, merged or
deployed; no business rule, route, API or permission changed.

## 1. Application by application

| App | Where | What changed |
|---|---|---|
| **ScoutBox Pro** (`scoutbox-club`) | Vite / React | The portal shell from the reference: 204px white sidebar with the wordmark and green square, the edition label, the organisation block (initials tile, name, plan), the navigation as 40px rows with lucide icons and uppercase group labels, the account block (initials, name, role, verification link, language, Switch org); the 67px top bar with the breadcrumb (`Pro / section / page`), the appearance switch, "Search workspace ⌘K", the live dot, the bell and Report / Block; 29/26px content with the reference page heading. Every component class the screens use (buttons, inputs, chips, list rows, stat tiles, ledgers, notices, drawers, dialogs, palette, phone strip) is restyled to the reference's light surfaces and dark embossed surfaces. Entry screen restyled. |
| **ScoutBox Grassroots** (`scoutbox-grassroots`) | Vite / React | Same shell. Workspace `#e5f5e9` (light) / `#252e26` (dark) with the reference's turf grain and faint white pitch markings (`rgba(255,255,255,.52)` / `.10`) behind the content; sidebar, header, cards, tables and buttons stay white / panel surfaces. |
| **ScoutBox Agent** (`scoutbox-agent`) | Vite / React | Same shell. Opens dark (reference default). Light is the approved cream: workspace `#f9f6ef`, sidebar `#fdfaf4`, top bar `#fbf8f1`, panels `#fdfbf6`, borders `#ebe4d7`, with the remaining tones (`#f5efe4`, `#fcf9f3`, `#f8f3e9`, `#f6f0e5`, `#f3ecde`, `#e9e0cf` …) taken from the reference. "Agent" beside the wordmark is solid `#a67c2e`, weight 700, 12px, no gradient, no stripe, no shimmer, in both themes. Primary actions stay `#00e676`. Client and transaction detail tabs use the reference underline tabs. |
| **Trust & Safety** (`scoutbox-admin`) | Vite / React | Same shell (brand, "Safety workspace" block, grouped navigation with icons, account block); the page-level tab row as the platform's underline tabs; the breadcrumb top bar with the appearance switch and Refresh. Permissions and the admin-key gate untouched. |
| **ScoutBox Player** (`scoutbox-player`) | Expo 57 / expo-router / React Native | A theme provider with the reference's light and dark palettes; Albert Sans on every piece of text through an app-level `Text`/`TextInput` wrapper (static faces bundled for iOS/Android, the same faces on the web); the reference phone header (wordmark on Home, back chevron + title elsewhere, appearance switch, round bell with a green dot, round Report control); the reference bottom navigation (lucide icons, 11px labels, active destination on a soft green pill); 12px hairline cards, soft 5px chips, full-width lime primary actions with dark-green text, underline page tabs; and the pitch markings over a turf grain behind every screen — absolutely positioned, `pointerEvents="none"`, hidden from assistive technology, no layout cost. |

### Reference screens → product routes

| Reference | Product |
|---|---|
| Pro · Player discovery | `#/search` (Players) |
| Pro · Recruitment room | `#/recruitment/rooms/:id` (Room hub, Offer / Signing tabs) |
| Pro · Director's desk | `#/recruitment/dashboard` (Director Dashboard) and `#/` (Home) |
| Grassroots · Club & squad | `#/` (Home) and `#/planner` (Squad) |
| Grassroots · Trial day | `#/trialdays` |
| Grassroots · Guardian conversation | `#/messages` |
| Agent · Agency overview | `#/` (Home) |
| Agent · Clients, Client detail (7 tabs), Client opportunities | `#/clients`, `#/clients/:id` (Overview, Representation, Opportunities, Club contacts, Trials, Offers, Activity), `#/opportunities` |
| Agent · Transactions, Transaction workspace (6 tabs) | `#/transactions`, `#/transactions/:id` |
| Agent · Conflicts & compliance | `#/compliance` |
| Agent · My profile & verification | `#/profile` |
| Agent · Agency team | `#/agency` |
| Agent · Operational inbox | `#/inbox` |
| T&S · Review queue | Cases → Report queue |
| T&S · Verification | Verification → Club verification / Guardian IDV / Staff checks / Coaches |
| T&S · Safeguarding case | Safety → Suspensions / Moderation log / Thread audit |
| Player · Home | `/(tabs)/discover` |
| Player · Football Passport | `/(tabs)/football` (Passport tab) |
| Player · Box Cam practice | `/(tabs)/football` (Box Cam tab) |
| Player · Club conversation | `/(tabs)/inbox` and the thread view |

Every other existing route keeps its function and takes the same shell,
tokens, type and components (the design system restyles the classes the
screens already use).

## 2. Files and components

- **New** `design-system/`: `fonts.css`, `fonts/` (Albert Sans variable TTFs + woff2 subsets, OFL), `tokens.css`, `platform.css`, `icons.tsx` (lucide, 77 icons), `theme.tsx` (`useTheme`, `ThemeToggle`, pre-paint script), `text.ts`, `README.md`, `reference/ScoutBox-Design-Explorer.html`, `screenshots/` (18 frames of the rebuilt apps, both themes, 1440 / 1024 / 390 and Player 390 / 320).
- **Tests**: `e2e/m21Live.test.mjs` — one start-of-section check made case-insensitive (the approved headings are sentence case); nothing else in the suites changed.
- **Portals** (each of `scoutbox-club`, `scoutbox-grassroots`, `scoutbox-agent`): `src/styles.css` (imports the design system), `src/icons.tsx` (re-export), `src/navui.tsx` (brand, org block, top bar toolbar, theme switch), `src/App.tsx` (`useTheme`, account block, content heading, entry screen), `src/i18n.ts` (`theme.*`, `navsec.searchWorkspace`, EN + FR), `index.html` (pre-paint theme script), `vite.config.ts` (`resolve.dedupe`, `server.fs.allow`, demo `assetsInlineLimit`), `tsconfig.json` (`paths` for the shared TSX).
- **Trust & Safety** (`scoutbox-admin`): `src/App.tsx` (shell, theme), `src/styles.css`, `index.html`, `vite.config.ts`, `tsconfig.json`.
- **Player** (`scoutbox-player`): `src/theme.ts` (palettes, `ThemeProvider`, `useColors`, `useStyles`), `src/components/Text.tsx`, `Icon.tsx` + `lucide.json`, `PitchBackdrop.tsx`, `ThemeSwitch.tsx`, `ui.tsx`, `PageChrome.tsx`, `NotificationBell.tsx`, `PopupBanner.tsx`, `ReportSheet.tsx` (round Report control), `src/app/_layout.tsx` (fonts, provider, status bar), `src/app/(tabs)/_layout.tsx` (bottom navigation), every screen and section (theme hooks, `Text` wrapper, pitch backdrop), `src/i18n.ts` (`theme*` keys), `assets/fonts/` (ten static Albert Sans instances + OFL), `package.json` (`react-native-svg` 15.15.4, `expo-file-system` 57.0.1 — the SDK-pinned versions).
- **Launcher and demos**: `e2e/launcher.html` (restyled, every tile points at the rebuilt app), `e2e/inline.mjs` (inlines the Player's bundled fonts into the single-file demo), `e2e/sourceFingerprint.mjs` (the design system is part of each portal's fingerprint).

## 3. Verification performed

All of it on the final tree (after the last styling change), in this
environment (Linux, Chromium via Playwright). The run log is §7.

| Check | Result |
|---|---|
| TypeScript, five apps (`tsc --noEmit`) | 5 / 5 clean |
| Production builds: four Vite portals (`vite build`) + Player web export (`expo export --platform web`) | 5 / 5 green; each portal bundle carries the six Albert Sans assets |
| Demo bundles (`e2e/buildDemos.mjs`, then `buildConnectedDemo.mjs`) | 5 single-file demos + the connected demo rebuilt; fonts inlined (portals: four woff2 data URIs; Player: ten TTF data URIs) |
| `demoFreshness` | 21 / 21 — every bundle's source fingerprint matches the tree (the design system is part of each portal's fingerprint) |
| Browser battery against live apps + server, 22 suites (the pre-M24 gate set: `preM24SweepLive`, both recruitment-journey suites, `entryCredit`, signing / offer (+hardening), `navConfig`, `m15Live`, `m12Live`, `m21Live`, the five M23 Agent suites, `m23ContactLive`, `m23TrialLive`, `m23DecisionLive`, `m23Live`, `navLive`) | 22 / 22 green. Two suites failed on the first pass against the new UI and were brought back: `navLive` N1 (the edition label had been placed inside `h1.page-title`; it is now a sibling crumb so the title reads `Section / Page` again) and N13 (the phone section strip's buttons must be ≥13px; set to 13px); `m21Live` H8 (the test expected the Development section heading in upper case; headings are sentence case in the approved design, so the test's start-of-section check is now case-insensitive — the assertion itself is unchanged). The two journey suites failed once on the Player bell's label and pass with the exact `Notifications` label restored. |
| Demo-bundle suites: `demoOffline`, `crosstab`, `m12DemoSpotcheck`, `m23AgentDemoSpotcheck`, `m21DemoSpotcheck`, `demoHostOrdering` | 6 / 6 green on the rebuilt bundles |
| Page errors / console errors while capturing every official demo (five apps, both themes, 1440 / 1024 / 390; Player 390 / 320) | 0 / 0 |
| Fonts | Portals: `document.fonts.check('16px "Albert Sans"')` true in all 8 app × theme contexts; Player: `AlbertSans-Regular` loaded, families on screen are the AlbertSans faces only |
| Theme persistence | Portals: a saved `sb-theme:<app>` is applied before first paint by the `<head>` script (no flash) and read by `useTheme`; keys are per app. Player: light → switch → dark → reload → dark, and dark → switch → light → reload → light, both confirmed on the web export (file-based persistence on native not run — see §4) |
| Switch semantics | `role="switch"`, `aria-checked` = dark, visible label (Light / Dark), keyboard-operable (Space / Enter), focus ring from the platform focus token |
| Responsive | No horizontal overflow at 390 and 320 (Player) and at 390 (portals, where the sidebar collapses behind the hamburger and the section strip takes over); 1024 keeps the sidebar |
| Visual comparison | 96 reference-vs-implementation pairs (same route, theme and viewport) in the comparison page delivered with the handoff; 18 curated frames in `design-system/screenshots/` |

Not run here: iOS / Android (no simulator in this environment); see §4.

## 4. Known differences from the reference, and why

- **Navigation depth.** The reference shows three short groups per portal. The real portals carry every destination that exists (Pro: 35), so the sidebar keeps its accordion (section rows → group labels → pages) in the reference's visual language rather than a fixed six-item list. Nothing was removed.
- **Page content.** The reference screens are illustrative compositions (a candidate list with a Passport preview, a three-figure strip, a quote). The real screens keep their own working content and receive the shell, type, tokens and component styles; where a real screen has the same element (stat tiles, ledgers, status chips, tabs) it now looks like the reference's.
- **Report / Block.** The reference header has no report control; ScoutBox keeps one on every screen (safeguarding §33). It is drawn in the toolbar's style (flag icon; round control on the Player).
- **Help.** The reference toolbar has a "?" button; there is no help destination in the product, so no placeholder was added.
- **Search placement.** The reference puts "Search workspace ⌘K" in the top bar; the portals' command palette now opens from there (it used to sit in the sidebar).
- **Dark "quiet" text.** The reference's dark theme sets every text colour to white (its own `* { color:#fff }`); that value is kept exactly, so hierarchy in dark comes from size and weight, as in the reference.
- **Player grain on native.** The turf grain is two repeating CSS gradients. It is painted on the web build; on iOS and Android the pitch markings carry the texture and the grain is not drawn (there is no gradient primitive without a further dependency).
- **Player greeting.** The reference Home opens with "Good morning, Kola" and a date; the product's Home has no greeting and none was fabricated.
- **Native verification.** No iOS/Android simulator is available in this environment: the Player was verified on its web build (Chromium). Native font registration, the file-based theme persistence, the SVG icons and the pitch layer are written for native and typecheck, but have not been run on a device — **outstanding**.

## 5. Startup

```
npm run setup            # once: installs every app (see README)
npm run dev              # server :4000, Pro :5173, Grassroots :5174, Player :8081
npm run dev:all          # … plus Trust & Safety
cd scoutbox-agent && npm run dev   # Agent :5176
```
Self-contained demos (no server): `cd e2e && node buildDemos.mjs` writes
`e2e/dist/scoutbox-{club,grassroots,agent,admin,player}-demo.html` and
`e2e/launcher.html` links them; serve `e2e/dist` over http (the Player demo
needs http, not file://).

## 6. Previews

See the handoff message for the clickable links (artifact pages built from
the demo bundles above). They show the real rebuilt applications in demo mode
on synthetic data; a live preview needs the dev server running.

## 7. Run log

```
# typecheck + production builds (final tree)
tsc scoutbox-club rc=0
tsc scoutbox-grassroots rc=0
tsc scoutbox-agent rc=0
tsc scoutbox-admin rc=0
tsc scoutbox-player rc=0
build scoutbox-club rc=0 6 font assets
build scoutbox-grassroots rc=0 6 font assets
build scoutbox-agent rc=0 6 font assets
build scoutbox-admin rc=0 6 font assets
export player rc=0

# demo bundles
buildDemos.mjs rc=0 · buildConnectedDemo.mjs rc=0 · demoFreshness: 21 checks passed

# browser battery (22 suites, live apps + server; first pass, with the two re-run lines after their fixes)
preM24SweepLive            rc=0   100  s fails=0   preM24SweepLive: 30 checks passed (22 negative)
m23RecruitmentJourneyHardeningLive rc=0 (re-run after the bell label fix: 57 checks passed)
m23RecruitmentJourneyLive  rc=0 (re-run after the bell label fix: 85 checks passed)
entryCredit                rc=0   24   s fails=0   entryCredit: 31 checks passed — the credit is present on Club, Grassroots, Agent, Admin
m23SigningHardeningLive    rc=0   42   s fails=0   M23 P7.1 SIGNING HARDENING LIVE: 68 checks passed (16 negative, 24%)
m23SigningLive             rc=0   40   s fails=0   M23 P7 SIGNING LIVE: 134 checks passed (48 negative, 36%)
m23OfferHardeningLive      rc=0   36   s fails=0   M23 P6.1 OFFER HARDENING LIVE: 53 checks passed (26 negative, 49%)
m23OfferLive               rc=0   36   s fails=0   M23 P6 OFFER LIVE: 98 checks passed (30 negative, 31%)
navConfig                  rc=0   1    s fails=0   navConfig: 359 checks passed
m15Live                    rc=0   55   s fails=0   m15Live: 21 checks passed — P1–P8 + T&S complete
m12Live                    rc=0   20   s fails=0
m21Live                              rc=0   79   s fails=0   M21 live journeys: 68 checks passed
m23AgentGrassrootsLive     rc=0   20   s fails=0   M23 P5.6F GRASSROOTS LIVE (reconstructed): 49 checks passed (27 negative, 55%)
m23AgentLive               rc=0   54   s fails=0   M23 P5.6B AGENT LIVE: 91 checks passed (26 negative, 29%)
m23AgentComplianceLive     rc=0   101  s fails=0   M23 P5.6C COMPLIANCE LIVE: 86 checks passed (25 negative, 29%)
m23AgentTransactionLive    rc=0   117  s fails=0   M23 P5.6D TRANSACTION LIVE: 116 checks passed (46 negative, 40%)
m23AgentIntegrationLive    rc=0   66   s fails=0   M23 P5.6E integration live: 98 checks passed, 39 negative/privacy/safeguarding checks (40%
m23ContactLive             rc=0   36   s fails=0   M23 P3 CONTACT LIVE: 82 checks passed (33 negative, 40%)
m23TrialLive               rc=0   40   s fails=0   M23 P4B TRIAL LIVE: 122 checks passed (53 negative, 43%)
m23DecisionLive            rc=0   32   s fails=0   M23 P5 DECISION LIVE: 86 checks passed (25 negative, 29%)
m23Live                    rc=0   5    s fails=0   m23Live: 39 checks passed — P2 sweep corrections verified end to end
navLive                              rc=0   102  s fails=0   navLive: 64 checks passed — N1–N17 complete

# demo-bundle suites (rebuilt bundles)
demoOffline              rc=0   5    s fails=0   
crosstab                 rc=0   20   s fails=0   
m12DemoSpotcheck         rc=0   7    s fails=0   
m23AgentDemoSpotcheck    rc=0   11   s fails=0   
m21DemoSpotcheck         rc=0   22   s fails=0   
demoHostOrdering         rc=0   1    s fails=0   demoHostOrdering: all 15 checks passed

# captures (official demo bundles)
club: page errors 0 · grassroots: page errors 0 · agent: page errors 0 · admin: page errors 0 · player: page errors 0; console errors 0
fontLoaded true in 8/8 portal contexts · player persist light→dark→reload=dark, dark→light→reload=light
```
