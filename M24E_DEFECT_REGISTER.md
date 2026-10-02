# M24E — Defect register

Severity: Critical / High / Medium / Low. State: Fixed / Open / Not a
defect (recorded for the record). Product behaviour (lifecycle,
authorisation, roles, minor safeguards, recruitment semantics, Trust Score,
Matching, Box Cam, Agent boundaries, schema) was not changed by any entry.

| # | Severity | Where | What | State |
|---|---|---|---|---|
| E1 | **High** | Trust & Safety console, ≤ 900px (phone, landscape 640×360 / 844×390) | The sidebar is a fixed drawer at ≤ 900px (`platform.css`) but the console never had a menu button or drawer state: the sidebar was translated off screen with nothing to bring it back, so there was no navigation and — after M24E added it there — no Sign out on a phone or in landscape. Found by `m24eScrollLive` P (Trust & Safety 640×360). | Fixed: `scoutbox-admin/src/App.tsx` has the same hamburger (`.nav-hamburger`, `aria-expanded`, `aria-controls="app-sidebar"`), veil, `drawer-open` state (closed by choosing a section, the veil or Escape, focus back on the button) and `.nav-scroll` region as the other portals. Regression: `m24eScrollLive` P Trust & Safety 640×360 opens the drawer, sees Sign out inside it, picks Verification and sees the drawer close. |
| E1b | Medium | Every portal's sidebar drawer on a landscape phone (640×360, 844×390) | With the drawer open the account block ended 23px below the viewport (399px of sidebar in 360px); Sign out was reachable only by scrolling the sidebar itself. Found by the E1 regression. | Fixed: `platform.css` `@media (max-height: 420px)` tightens the sidebar padding, the wordmark / organisation spacing and the navigation region's minimum height (96px) so the exits fit. Regression: the same `m24eScrollLive` check requires Sign out on screen inside the open drawer. |
| E2 | High | Pro, Grassroots, Trust & Safety entry screens at 640×360 and 1024×600 (before M24E) | The entry page was `min-height: 100vh` with the card centred; when the viewport was shorter than the card the first rows were clipped behind the top edge and the page did not scroll from the top. | Fixed in M24E: `.login.auth-page { height: 100dvh; overflow-y: auto }`, `.auth-card { margin: auto 0; flex-shrink: 0 }`. Regression: `m24eScrollLive` A (nine viewports × four portals). |
| E3 | High | Pro / Grassroots / Agent sidebar at short heights (1024×600, 640×360) | With Recruitment open the sections pushed the account block (and now the exits) below the sidebar's bottom edge; the sidebar itself scrolled only as a whole, so Sign out / Switch disappeared. | Fixed in M24E: `.nav-scroll` region (`flex: 1 1 auto; min-height: 140px; overflow-y: auto`) around the sections; brand, organisation and the account block stay. Regression: `m24eScrollLive` S. |
| E4 | Medium | Pro bell panel, thread view, command palette at 600px heights | Fixed pixel heights (320 / 420px) overflowed short viewports; the last result or the composer was under the edge. | Fixed in M24E: heights bound to the viewport (`max-height: calc(100vh − …)`, `overflow-y: auto`). Regression: `m24eScrollLive` M. |
| E5 | Medium | Every entry screen | A theme toggle on the entry screen let the pre-sign-in surface follow `data-theme` (Agent's entry mapped onto the saved cream / dark workspace tokens); the brief requires one fixed appearance. | Fixed in M24E: five toggles removed; the Agent entry has fixed tokens; the Player's surround is painted the entry green on `/onboarding`. Regression: `m24dAuthLive` M24E block (same colours with `dark` and `light` saved; no `role="switch"`). |
| E6 | Medium | Pro, Grassroots, Agent, Trust & Safety, Player | No visible way out of an authenticated session except the Player's "Log out" on the Account tab; the Trust & Safety console had no exit at all. | Fixed in M24E: Sign out + Switch organisation / club / profile in the portal account blocks, Sign out in Trust & Safety, Sign out + Switch account on the Player (You › Account, guardian dashboard). Regression: `m24dAuthLive` M24E block, `preM24SweepLive` S5. |
| E16 | **High** | The single-file portal demos (`e2e/dist/scoutbox-{club,grassroots,agent,admin}-demo.html`, the published artifacts) | The Inter variable faces (880 / 910 KB) are above Vite's asset inline limit, so the built CSS refers to them as `url(/assets/Inter-…ttf)`; `e2e/inline.mjs` only turned double-quoted `"/assets/…"` references (the Player export's form) into data: URIs, so the four portal demos requested `/assets/…ttf`, got 404 and fell back to the system font. Found by `m18DemoSpotcheck` (a console 404 on boot) in the battery; the earlier spotchecks passed because they do not count console errors. | Fixed: `inline.mjs` also rewrites unquoted / quoted `url(/assets/…)` font references; demos rebuilt; `m18DemoSpotcheck`, `demoFreshness`, `demoOffline`, `uiSpotcheck`, `demoHostOrdering` and every DemoSpotcheck rerun on the rebuilt demos; `m24eScrollLive` F proves computed Inter on the live bundles (served with their asset files, so they were never affected); the visual captures came from those live bundles. |
| E7 | Low | `e2e/m24eScrollLive.test.mjs` (first run) | The horizontal-overflow check read the entry page's own `scrollWidth`, which includes the 1640px pitch drawing that the page clips with `overflow-x: hidden`; a false "horizontal overflow" at 844×390. | Fixed in the test: the document must have no horizontal overflow and the card must lie inside the viewport. |
| E8 | Low | `e2e/m24eScrollLive.test.mjs` (second run) | The long-selector proof expected fifteen rows on the Pro entry; Pro lists `/orgs?platform=main` (professional organisations only), so the ten registered federation clubs appear on Grassroots alone. | Fixed in the test: the fifteen-row proof runs on Grassroots; Pro and the Agent roster use the same row component (noted in the output and in `M24E_SCROLLABILITY.md`). |
| E9 | Low | `e2e/m24dAuthLive.test.mjs`, `m24eScrollLive` F (first runs) | `document.fonts.check` was read before the 880 KB Inter face had finished loading, so "Inter loaded" was false at the first viewport. | Fixed in the tests: the checks await `document.fonts.ready` and `fonts.load(...)` for the 400 / 600 / italic faces before reading computed styles. |
| E10 | Low | `e2e/m24dAuthLive.test.mjs` (Agent revocation check) | The check called a route that does not exist (`/org/agent/me`). | Fixed in the test: the revoked token is tried on `/org/agent/clients` (401). |
| E12 | Low | `e2e/m24eScrollLive.test.mjs` (E1 regression) | The drawer check measured Sign out as soon as `drawer-open` appeared, while the 0.18s slide was still moving the sidebar in from the left; a false "off screen". | Fixed in the test: it waits for the slide to finish before measuring. |
| E13 | Low | `e2e/m24eScrollLive.test.mjs`, `m24dAuthLive.test.mjs` (Player tab bar) | The tab bar was located by `a[href="/you"]`; expo-router carries the current query on the tab links, so on `/you?tab=account` the link is `/you?tab=account` and the wait timed out. Not a product defect: the bar is there. | Fixed in the tests: prefix match `a[href^="/you"]`. |
| E14 | Low | `e2e/m24eScrollLive.test.mjs` F (Trust & Safety) | The signed-in font check looked for a form label; a fresh live Trust & Safety console has no form on any section until there are cases (Overview, Verification and Cases render only headings, stats and empty-state copy), so the check read `null`. Not a product defect. | Fixed in the test: where a section has no form the sub-navigation / top-bar controls stand in; the key field on the entry screen is already checked by `m24dAuthLive`. |
| E15 | Low | `e2e/m24eScrollLive.test.mjs` F (Player) | "Every piece of text is Inter" counted the wordmark, which is by design the one brand-face exception (`AlbertSans-ExtraBold`). Not a product defect. | Fixed in the test: the wordmark text is excluded from that set and asserted separately as the brand face. |
| E11 | Not a defect | Test environment | `m24dAuthLive` reused a Player export built for the scroll suite's API port (4063) while its own server listened on 4062, so the demo identities never loaded and "Enter" never appeared. | Rebuilt the Player export for the suite's port; the suite builds its own bundles when `KEEP_DIST` is not set. |

## Precheck deviation

The mandate's precheck requires a clean tree. The tree held seventeen
uncommitted M24E edits made by this session's own earlier turn (theme
toggles removed from the five entry screens, the exits in the portal
account blocks, Trust & Safety `signOut`, `.nav-scroll`, the entry page
scroll rule, the Player's fixed entry surround, the Player "Sign out"
label, the `preM24SweepLive` S5 selector). They were M24E work in
progress, not foreign changes; the pass built on them rather than
discarding them. Branch, remote tip, schema and merge state matched.

## Inter source

The two files named in the brief did not reach this environment. The same
faces were taken from Inter's official 4.1 release archive (SIL OFL 1.1)
and stored under the names the brief uses; see `M24E_INTER_TYPOGRAPHY.md`.

## Open

None at the time of the final report (see `M24E_TEST_REPORT.md`).
