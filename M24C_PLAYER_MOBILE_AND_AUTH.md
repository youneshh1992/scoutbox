# M24C — ScoutBox Player as a phone application, and the authentication redesign

Two corrections, implemented in the working applications (no mockup):

1. **ScoutBox Player renders as the approved mobile application on every
   surface** — iOS, Android, the web preview and a wide desktop browser.
2. **Every application signs in through the new two-panel authentication
   composition** (reference B), with ScoutBox branding, the correct product
   identity and only the sign-in / sign-up flows that really exist.

References: `design-system/reference/ScoutBox-Design-Explorer.html` (A — the
Player's authenticated screens) and the supplied photograph of a two-panel
login (B — the composition only; no monitor, perspective, third-party brand,
prices or music copy were reproduced).

## 1. Why Player rendered like a desktop page, and the correction

**Cause.** The Expo web build had no mobile viewport. Every screen capped its
scroll content at 560 px and centred it, but the SafeAreaView, the header
actions, the pitch backdrop and the expo-router tab bar filled the whole
browser: at 1440 px the five bottom tabs spread edge to edge, the pitch
markings painted the full page and the onboarding hero stretched with it. No
portal shell, desktop breakpoint, shared navigation or wrong entry point was
involved; the app simply had nothing that said "this is a phone".

**Correction.** `scoutbox-player/src/components/MobileViewport.tsx` wraps the
root `Stack` in `app/_layout.tsx`: on the web the whole application — header,
content column and bottom navigation — lives in a centred column of at most
430 px on a quiet surround (`frame` in the palette; the page body paints it
too), with a hairline either side when the window is wider. On iOS and
Android the wrapper is transparent. Every route's 560 px cap was removed so
the screen fills the viewport, with the reference's `12px 18px 23px` body
padding. Nothing is scaled with a transform, and there is no breakpoint that
changes the structure. Measured in the rebuilt web export (Playwright):

| width | document width | viewport column | bottom tabs | sidebar / portal shell |
|---|---|---|---|---|
| 320 | 320 | 320 px at 0 | 5, bottom 827 of 844 | none |
| 390 | 390 | 390 px at 0 | 5, bottom 827 | none |
| 430 | 430 | 430 px at 0 | 5, bottom 827 | none |
| 1440 | 1440 | 430 px at 505 | 5, inside the column (right edge 924) | none |

## 2. Player screens matched to the reference

`src/components/Reference.tsx` holds the approved phone components, one for
one with the reference's `.p-*` rules (sizes are the reference's computed
values; colours come from the active palette so light and dark both match):
`Greeting`, `SectionHead` (+ count bubble / text link), `MobileRow`,
`IconTile`, `PassportCard` (the dark-green `#173b27` card), `DevelopmentCard`,
`ProfileIntro`, `StatusDot`, `HistoryList` (numbered records),
`TrainingVisual` (the Box Cam hero with the faint pitch), `SessionFacts`,
`LightLabel`, `Footnote`, `RefCard`, `TextButton`.

- **Home** (`(tabs)/discover.tsx`): date kicker + "Good morning, {first
  name}", the Football Passport card (position · city · availability, "View
  your Passport" → Football), **Needs your attention** with a count — pending
  requests and unread club replies from the session the app already holds —
  then **Your development** with the next action and "Start a practice
  session" → Box Cam. Everything the Home carried before (weekly report,
  pathway, clubs within reach, what scouts noticed, profile strength,
  insights, visibility, directory, promises) follows under "Around your
  profile". No illustrative record was copied into data.
- **Football Passport** (`(tabs)/football.tsx`, `TrustProfileSection.tsx`,
  `M15Sections.tsx`): the profile introduction (large avatar, name, position
  · city, status dot), the page tabs (Passport · Development · Box Cam ·
  Combine — the existing functions), the Trust card in the reference's form
  (label, band heading, 32px score, disclaimer, "Why this score?" as a text
  link that opens the derivation), and the club history as numbered records.
  Every Passport action (achievements, career entries, corrections, shares)
  is unchanged.
- **Box Cam** (`M16Sections.tsx`): "Football / Box Cam — Your next session",
  the training visual, the drill as a heading with its Practice label, the
  setup line, the target facts (timer / ball), the lime **Start Box Cam** and
  the live-observation control exactly as before, **Recent sessions** as
  numbered records (day · date · reps or time · the server's state), the
  footnote, and the rest of Box Training (activity, assignments, verification
  states, bests, challenges, sharing) under it.
- **Messages** (`Threads.tsx`): thread rows with the club's avatar; an open
  thread as the person header (club, person · role, Back), the safety strip
  ("Accepted conversation · Report or block anytime"), a date divider,
  bubbles (theirs on a hairline, mine on the soft green, "You · 10:28 ·
  Read"), and the rounded compose pill with the green send disc. Sending,
  retries, read receipts, typing pings and clip attachments are unchanged.
- Bottom navigation: Home · Football · **Explore** (the Opportunities route,
  unchanged) · Inbox · You; Box Cam stays reachable under Football and the
  Upload / Profile routes keep working.
- The pitch texture stays behind content (pointer-events none, hidden from
  assistive technology, no layout, no animation).

## 3. Authentication (all applications)

`design-system/AuthShell.tsx` + the `.login.auth-page` block in
`design-system/platform.css`. **M24C.3 palette** (the `--auth-*` tokens;
`AUTH_PANEL` / `AUTH_PAGE` on the Player): the page and the form are the
dark football green `#173B27`, the introduction is the ScoutBox green
`#00E676` with `#113822` text, the submit is `#00E676` with `#113822` text
(pressed `#113822`), pale supporting surfaces are `#E5F5E9`, text on dark
green is white with `#CFDFD0` for supporting copy and placeholders,
underlines are `#CFDFD0` at 35 %, focus is `#00E676`. Behind the card the
pitch motif in white at 8 % with grain and mowing bands under 2 %, oversized
on desktop, upright and cropped on a phone, never in front of a tap or in
the accessibility tree, never moving; no embossing on the panels.
**Grassroots** gives its bright introduction the turf — blades and mowing
bands in the deep green, no lines. **Agent** builds its entry screen from
the Agent application's own two backgrounds — the sidebar surface for the
introduction and the workspace for the form and the page — so it follows the
saved cream / dark appearance, with the gold label on its cream badge. The
wordmark reads **ScoutBox▪™** on every entry screen. One centred card of at
most 1000 px (introduction ≈45 %, form ≈55 %, 14 px radius, soft shadow,
44 px padding, form content 360 px wide), the product identity beside the
wordmark, `AuthTabs` only where sign-up exists, `AuthField` labelled
underlined inputs, `PasswordInput` with show / hide, and the compact rounded
submit. Under 720 px the panels stack. The entry surface keeps its brand
colours whatever theme is saved. (M24E: the theme toggle that used to sit on
the entry page is gone — the entry screens have one fixed appearance, see
`M24E_AUTH_SINGLE_MODE.md`; the stored choice is still restored in the
workspace after sign-in.) Nothing here touches the signed-in theme tokens.

| App | Identity | Flows shown | Credentials (unchanged backend) |
|---|---|---|---|
| ScoutBox Pro | `ScoutBox ▪ Pro` | sign in + "access is provisioned" note | organisation, name, club password (if provisioned), role → `/auth/org/login` |
| ScoutBox Grassroots | `ScoutBox ▪ Grassroots` | **Sign in / Register club** tabs (the one real public registration, `/auth/org/register-grassroots`) | as Pro; registration collects club, federation, registration id, town, ground lat/lng, your name |
| ScoutBox Agent | `ScoutBox ▪ Agent` (solid `#A67C2E` gold on a restrained cream badge) | sign in + "granted by your agency's administrator" note; the demo roster only in demo builds | agency, name, agency password, role |
| ScoutBox Trust & Safety | `ScoutBox ▪ Trust & Safety` | admin key only + "staff access is issued by ScoutBox" note | admin key |
| ScoutBox Player | `ScoutBox▪ Player` | **Sign in / Sign up** (stacked for a phone) | sign in: guardian email + password (`/auth/guardian/login`) or player id + password (`/auth/player/login`); sign up: the existing player (18+) / guardian / pairing-code flows with every verification step; the demo identities only when the server offers them |

Player authentication stays inside the mobile viewport at every browser
width: wordmark and product near the top, a compact green introduction, the
deep-green form directly below (`AUTH_PANEL` in `theme.ts`, rendered through
`ThemeOverride` so every existing step keeps its brand colours), one column,
44 px targets, scrolling on short screens, keyboard avoidance on iOS, and no
authenticated bottom navigation before sign-in. The promises and under-18
rules remain on the entry screen below the form.

Preserved: endpoints and credential requirements, roles and organisation
boundaries, guardian / minor rules, session persistence, logout and account
switching, the server's refusals (shown as real errors with the
non-sensitive input kept), one submission at a time (`busy` state, disabled
submit), no fake social sign-in, no public staff or agency registration, no
development credentials outside demo / dev builds, no password or token
logged.

## 4. Verification

See the report returned with this change. Native iOS and Android rendering
is **unverified** in this environment (no simulator or device); the native
code paths are the same React Native components, with the wrapper a no-op.

## 5. Launching

```
# backend
cd scoutbox-server && node server.mjs            # :4000
# portals
cd scoutbox-club && npx vite                      # Pro
cd scoutbox-grassroots && npx vite                # Grassroots
cd scoutbox-agent && npx vite                     # Agent
cd scoutbox-admin && npx vite                     # Trust & Safety (ADMIN_KEY on the server)
# player (web preview; a wide window shows the 430px phone column)
cd scoutbox-player && npx expo start --web
# player on a device / simulator
cd scoutbox-player && npx expo start               # then i / a
```

Demo bundles (no server): `node e2e/buildDemos.mjs` → `e2e/dist/*.html`;
the published demo artifacts are rebuilt from these.

## 6. Files

- Player: `app/_layout.tsx`, `components/MobileViewport.tsx`, `theme.ts`
  (`frame`, Box Cam / chat colours, `AUTH_PANEL`, `ThemeOverride`), every
  route's scroll style, `(tabs)/discover.tsx`, `(tabs)/football.tsx`,
  `components/Reference.tsx`, `TrustProfileSection.tsx`, `M15Sections.tsx`,
  `M16Sections.tsx`, `Threads.tsx`, `NotificationBell.tsx` (sheet width),
  `ui.tsx` (`pill` button), `app/onboarding.tsx`, `i18n.ts` (EN + FR).
- Portals: `design-system/AuthShell.tsx`, `design-system/platform.css`,
  `design-system/README.md`, the `Login` in `scoutbox-club/src/App.tsx`,
  `scoutbox-grassroots/src/App.tsx`, `scoutbox-agent/src/App.tsx`, and the
  entry screen in `scoutbox-admin/src/App.tsx`.
- Tests: `e2e/navLive.test.mjs` N17 (the login assertions follow the new
  composition: panels side by side at 1440, stacked fields, Tab reaches the
  submit within five presses because the password field now carries a
  show / hide control).
- Frames: `design-system/screenshots/m24c-*.png`.
