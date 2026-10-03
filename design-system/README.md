# ScoutBox design system (M24A)

The approved visual identity, implemented once and shared by the five
applications. The authoritative reference is
`reference/ScoutBox-Design-Explorer.html` (retained verbatim; open it in a
browser — it is a self-contained page). Nothing in this folder invents a value:
every colour, size and weight below is the reference's computed value.

## What is here

| File | Purpose |
|---|---|
| `fonts.css`, `fonts/` | M24E — Inter 4.1, bundled (`Inter-VariableFont_opsz,wght.ttf` upright and `Inter-Italic-VariableFont_opsz,wght.ttf` italic, weight axis 100–900, optical-size axis; SIL Open Font License 1.1, `fonts/Inter-OFL.txt`) is the product typeface: `--sb-font` on `html`, every control and every screen; nothing is fetched at runtime. Albert Sans (`AlbertSans[wght].ttf` + `AlbertSans-normal.woff2`, `fonts/OFL.txt`) is kept for the ScoutBox wordmark only (`--sb-font-brand`, `.wordmark`). The Player carries its own copies under `scoutbox-player/assets/fonts/` because Expo bundles assets from inside the app. See `M24E_INTER_TYPOGRAPHY.md`. (The M24F Instrument Serif for the word "Grassroots" was reverted at the Founder's direction: "Grassroots" is Inter again.) |
| `tokens.css` | Design tokens. `:root` is the platform light palette; `:root[data-theme="dark"]` the dark embossed palette shared by every app; `:root[data-app="agent"]` the Agent cream palette and gold label; `:root[data-app="grass"]` the Grassroots workspace surfaces and turf lines (the M24E scheme; the M24F Sage palette was reverted at the Founder's direction). The legacy names the screens read inline (`--bg`, `--panel`, `--line`, `--text`, `--muted`, `--accent`, `--accent-2`, `--gold`, `--danger`) are aliases of the new `--sb-*` tokens, so every existing screen follows the theme without a rewrite. |
| `platform.css` | The portal shell (204px sidebar, 67px top bar, 29/26px content gutter) and every component class the portals render — buttons, inputs, chips and dot statuses, panels, ledgers, drawers, dialogs, the command palette, the phone strip — resolved onto the class names the applications and their browser suites already use. Includes the Grassroots grain and pitch markings. |
| `icons.tsx` | The lucide icon set (ISC) as one React component. Path data is copied from `lucide-static`; legacy navigation names (`home`, `target`, `clipboard`, `building`, `inbox`, `help`, …) resolve to their lucide equivalents so `nav.ts` did not change. |
| `theme.tsx` | `useTheme(app)` — one appearance per application, persisted under `sb-theme:<app>`, defaults from the reference (Agent dark, everything else light); `ThemeToggle` — the header switch (`role="switch"`, `aria-checked` = dark); `PREPAINT_SCRIPT` — the one-line `<head>` script each `index.html` carries so a saved theme never flashes. |
| `text.ts` | `initials()` for avatar tiles. |
| `AuthShell.tsx` | M24C — the authentication composition every portal signs in through: the brand-green page, a centred two-panel card (soft-green introduction ≈45%, deep-green form ≈55%, stacked under 720px), the product mark above the form, `AuthTabs` only where sign-up really exists (Grassroots registration), `AuthField` labelled underlined inputs, `PasswordInput` with show / hide, `AuthAccessNote` for invitation-only access. M24D — choices are `AuthRow`s (name, one quiet line, an arrow; `aria-pressed` when it selects), `AuthNote` for quiet notes, a `summary` sentence under the headline (all a phone shows of the introduction); no pill, emoji or icon circle on any entry screen. Styles live under `.login.auth-page` in `platform.css`; they never touch the signed-in theme tokens. The Player renders the same composition stacked, in React Native (`app/onboarding.tsx`, `AUTH_PANEL` in `theme.ts`). |
| `caseNav.ts`, `CaseNav.tsx` | M24B — the category → subcategory navigation of one recruitment case (a Room, a client, a transaction): the model types, the hard rule `CASE_NAV_MAX_SUBS = 5` with `validateCaseNav`, strict link parsing (`parseCaseSegments`, `resolveTab` for the flat tab ids the server still emits), and the two-row control (segmented categories with `aria-current`, an ARIA tablist of pages, `casePanelProps` for the panel, `CaseCrumb`). Each application keeps its own model in `src/caseNav.ts`; the Player repeats the model in plain TypeScript. See `M24_RECRUITMENT_NAVIGATION_IA.md`. |
| `reference/` | The approved design explorer, unchanged. |

## How an application uses it

- **Portals (Pro, Grassroots, Agent, Trust & Safety)** — `src/styles.css` is
  `@import '../../design-system/platform.css'` plus any app-specific rule;
  `src/icons.tsx` re-exports `Icon`; `App.tsx` calls `useTheme('pro' | 'grass' | 'agent' | 'safety')`
  and passes the theme to `TopBar` and the entry screen; `index.html` carries
  the pre-paint script and sets `data-app`. Vite resolves React for the shared
  TSX through `resolve.dedupe`, the TypeScript projects through `paths`, and
  the dev server serves the font files through `server.fs.allow`. The demo
  bundle inlines the fonts (`assetsInlineLimit` when `VITE_DEMO=1`).
- **Player (Expo)** — native code cannot import CSS, so the same palette lives
  in `scoutbox-player/src/theme.ts` (`palettes.light` / `palettes.dark`,
  `ThemeProvider`, `useColors`, `useStyles`), the fonts are static instances in
  `scoutbox-player/assets/fonts` (generated from the variable file with
  fontTools), every piece of text goes through `components/Text.tsx` (which
  resolves the requested weight to the right face), the icons are
  `components/Icon.tsx` on `react-native-svg` from the same lucide data, and
  the pitch is `components/PitchBackdrop.tsx`.

## Theme switching

Every application shows the switch in its header (portals: the top bar and the
entry screen; Player: every page header, onboarding and the guardian page).
Each application persists its own choice — `sb-theme:pro`, `sb-theme:grass`,
`sb-theme:agent`, `sb-theme:safety`, `sb-theme:player` — so switching one
never changes another. On the web the choice is read before first paint; on
iOS and Android the Player stores it in a small file in the app's document
directory (`expo-file-system`) and applies it as soon as the app starts.

## Palettes at a glance

| | Light | Dark |
|---|---|---|
| Workspace | `#f6f7f3` (Agent `#f9f6ef`, Grassroots `#e5f5e9`) | `#202223` (Grassroots `#252e26`) |
| Sidebar | `#ffffff` (Agent `#fdfaf4`) | `#121415` |
| Top bar | `#fcfdfa` (Agent `#fbf8f1`) | `#1a1c1d` |
| Panels | `#ffffff` (Agent `#fdfbf6`) | `#272a2b` |
| Rule | `#e1e6df` (Agent `#ebe4d7`) | `#393c3d` |
| Ink | `#1e2923` (Agent `#302d25`) | `#ffffff` |
| Primary action | `#00e676` with `#113822` text | same |
| Agent label | `#a67c2e`, solid, weight 700, 12px | same |
