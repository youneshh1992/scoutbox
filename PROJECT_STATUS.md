# ScoutBox — Project Status & Handoff

> Purpose of this file: let any Claude Code session (cloud or local) pick up this
> project with zero prior context. Keep it updated at the end of each working session.

**Last updated:** 2026-08-20 · **Milestone: 5 complete — social-platform patterns +
the USP set (Verified Clips, Film Room, feeds, streaks, combine, CV, fixture graph)** ·
Developed in this GitHub repo (`youneshh1992/scoutbox`), Claude Code web.

## Milestone 5 (2026-08-20): social-layout patterns + unique features

Adopted from the cross-platform analysis (everything except the club directory), all
server-enforced first and mirrored in both demo clients:

- **Home feeds both sides.** Club app now lands on a feed (`/org/feed`: new players,
  fresh footage with shortlist priority, reports coming due). Player Discover tab became
  a Home feed (`/player/feed`): weekly scout report card, streak, goal progress,
  scouting events, "what scouts noticed".
- **Film Room** (`/org/filmroom`) — full-screen vertical clip deck (arrow keys/buttons),
  Verified Clips surface first, overlay actions + structured scout tagging; every play
  is recorded as a clip view.
- **Verified Clip™** — `POST /player/media` with `attendanceId` links footage to a
  GPS+device-confirmed fixture (must include the actual file). Seal shows everywhere:
  Film Room, feeds, profiles, thread attachments. Seeded sample webm clips live in
  `scoutbox-server/assets/` (loaded at startup) and are inlined into the club demo.
- **Streaks / weekly goals / trust tiers / next-best-actions** — `domain.mjs`
  (`computeStreak`, `weeklyGoal`, `trustTier`, `nextActions`; kid-safe: self-competition
  only, no leaderboards). Activity recorded on uploads, attendance, stats, drills.
- **Richer messaging** — read receipts (`readBy`, `/channels/:id/read`), typing
  indicators (SSE `typing` events, `/channels/:id/typing`), attachments (player/guardian
  attach clips, orgs attach filed trial reports — validated server-side).
- **Per-clip analytics** — clip views + tag aggregation on media; 8-week view trend
  (`weeklySeries` in insights) drawn as bars on the player home.
- **"What scouts noticed"** — structured tag vocabulary (`SCOUT_TAGS`), aggregated
  anonymously to the player; ledger records `clip_tagged`.
- **At-home verified combine** — drills carry metrics/benchmarks; results logged with a
  value; attaching video marks them combine-verified (prototype: video presence;
  production = CV analysis). Visible to clubs on profiles.
- **Fixture-graph scouting** (`/org/fixtures`) — verified attendances grouped into real
  fixtures; club Fixtures screen opens each match to who provably played.
- **Portable Verified Sports CV** (`/player/cv`) — the player-owned record (identity,
  trust + tier, attendance, verified clips, trial reports, combine, timeline); CV
  preview card on the profile.
- **Weekly parent digest** (`/guardian/digest`) — per-child views, requests, streaks,
  activity; card at the top of the guardian dashboard.
- **Safeguarding Certified** — computed (`verified + contract + no unresolved urgent
  report`), shown in the club topbar, org listings and on requests to guardians.
- **Polish** — pull-to-refresh on player screens, skeleton loaders on the club feed.

Deliberately NOT adopted (the absence is the USP): public likes/comments/followers,
open DMs, algorithmic virality for minors, contact syncing.

Verified 2026-08-20 (Playwright + API, live server + offline demos): feed lands first
with certified badge; Film Room plays the seeded Verified Clip first and tags flow into
the player's "what scouts noticed"; fixtures list from attendance; player home shows
weekly report/streak/goal/next actions; profile shows tier + verified seal + CV; thread
carries a verified-clip attachment with read receipts; guardian digest renders. 17
domain tests pass.

## Milestone 4 (2026-07-23): closing the user-experience gaps

Everything below is server-enforced first, mirrored in both demo clients.

- **Message threads** — the payoff of the request flow now exists. A channel opens ONLY
  when a request is accepted (`openChannel`); org side `/org/channels`, adult players
  `/player/channels`, guardians `/guardian/channels`. Children have no threads, ever.
  Every message is moderated (contact details blocked) and lands on the ledger.
  Club app: Messages screen with thread view; player app: threads in Inbox (adults) and
  the guardian dashboard (minors' threads).
- **In-app notifications** — `db.notifications` per audience, `/…/notifications` (+ mark
  read) for org users, players and guardians; fired on request received, accepted,
  declined, message received, trial report filed, report resolved. Bell with unread badge
  in both apps. (Push/email delivery is production infra behind the same records.)
- **Real video upload & playback** — `POST /player/media` accepts a data URL (~12MB cap,
  in-memory store; production = object storage behind the same endpoint), served at
  `GET /media/:id`. Web file picker in Upload; playback in the club profile drawer and
  the player profile (`WebVideo`, native playback ships with expo-av).
- **"Who's watching you" insights** — `/player/insights` + `/guardian/children/:id/insights`:
  weekly/monthly view counts, per-org breakdown, recent attributed events. Card on the
  player Discover tab; per-child line in the guardian dashboard.
- **Trial logistics** — trial requests carry proposedDate/venue/notes (moderated); trials
  gain `reportDueAt` (+7 days); shown on both sides before accepting and on the Trials screen.
- **Guardian-initiated availability** — `/guardian/children/:id/availability`
  (open to trials / from end of season / not seeking) with dashboard controls.
- **Co-guardian** — `/guardian/coguardian` adds a second parent sharing the children;
  must still pass ID verification + disclaimer before acting.
- **Report outcomes** — reports resolve with an outcome (prototype 45s review timer;
  production = human T&S queue behind the same status fields) and notify the reporter;
  "safety centre" lists in both apps.
- **Search filters** — age group (U16/U18/18–21/senior), country, "new this week"
  (players now carry `createdAt`).
- **Persisted sessions** — both apps store the session in localStorage and restore on
  refresh (club re-mints its user id on restore since the server is in-memory).
- **Optional passwords** — signup accepts a password; login then requires it (plain-text
  prototype store, stripped from every API response; production = hashing + sessions).
- **Onboarding polish** — DOB auto-formats with live age feedback ("You're 14 — a parent
  or guardian sets up the account").

Verified 2026-07-23 (Playwright + API, live server): insights card and inbox badge render;
adult accepts trial → thread opens → messages flow both ways with org identity shown as
"Maria Keane · Head of Recruitment · Eastport FC"; org gets notified of replies; guardian
accepts → adult-to-adult thread works; moderation blocks a phone number inside a thread;
trial carries venue/date and a report deadline; demo builds replay all of it offline.

## Milestone 3 (2026-07-23): U18 + guardians

Adults-only launch is over: under-18 players now exist, protected by a guardian system
enforced server-side. Summary of the new rules (all in `scoutbox-server`):

- **Guardian accounts own every U18 profile.** `POST /auth/guardian/signup` →
  `/guardian/verify-id` (prototype IDV attestation) → `/guardian/disclaimer` →
  `/guardian/children`. Both gates are hard 403s. Minor self-signup → `403 GUARDIAN_REQUIRED`.
- **Scout → Parent, never Scout → Child.** Requests to minors get `routedTo: 'guardian'`;
  the guardian inbox (`/guardian/inbox`) shows club-first identity (org, Verified badge,
  sender's verified role); `/guardian/requests/:id/respond` opens an adult-to-adult
  channel on accept and creates the trial. The child's `/player/inbox` returns sanitized
  status notes only — no message content, no channel; child responds → `403 GUARDIAN_MANAGED`.
- **Verified clubs only** see minors (`verified` flag on org: company email domain +
  safeguarding contract). Unverified club → `403 VERIFIED_CLUBS_ONLY`; agency →
  `403 UNDER_18_WALL` (unchanged, now demoable — seed has Guni Adebayo 14 & Tomasz
  Kowalski 16 with verified guardians gd-amara / gd-marek).
- **Privacy for minors:** city + exact DOB stripped from every org view; profiles
  app-only; no comments/likes/followers anywhere in the API.
- **Moderation** (`domain.mjs moderateText`, prototype for an AI model): emails, phone
  numbers, social handles/platforms, URLs, off-platform meeting language →
  `400 MODERATION_BLOCKED` on request messages, media titles, timeline events.
- **Report & block:** `/player/report`, `/player/block`, `/guardian/report`,
  `/guardian/block`, `/org/report`. Urgent reports immediately suspend communication
  (blocks + freezes pending requests). One-click ⚑ Report/Block UI on every screen of
  both apps. All communications logged; guardians read the full ledger via `/guardian/log`.
- **Children keep the football:** media upload (moderated), verified attendance,
  timeline, stats editing (`POST /player/stats`) and drills (`/player/drills`) stay
  child-controlled; availability, Academy+, medical sharing and all club interaction are
  guardian-managed (medical via `/guardian/children/:id/medical/share`).
- **Player app:** guardian onboarding flow (4 steps), guardian dashboard route
  (`src/app/guardian.tsx`), child-aware tabs, and the Profile tab rebuilt to the
  approved design mock (avatar card + squad number, trust 59/100 card with breakdown
  bar, season-output tiles, availability chips, Academy+ card, contract status card
  with market value + agent).
- **Club app:** role picker at login (shown to parents), verified badges, U18
  guardian-managed profiles with "Contact Guardian" / "Invite to trial (via guardian)"
  actions, safety modal on every screen, unverified-club banner.

Verified end-to-end 2026-07-23 (Playwright, live server): club trial invite for the
14-year-old routes to the guardian; guardian sees "Eastport FC · Verified · Head of
Recruitment — Maria Keane" and accepts; child inbox shows only the sanitized update
with no accept button and no message text; child profile shows guardian-managed state;
moderation blocks a message containing a phone number; urgent guardian report suspends
the org's access. 13 domain tests pass (`npm test`).

## Migration note (2026-07-22)

The Mac-local Milestone 2 codebase was never pushed to this repo, so the full system was
**rebuilt from this handoff document** in a Claude Code web session and verified
end-to-end. Structure and behaviour follow this document; exact file contents differ
from the Mac originals. This repo is now the source of truth.

## What ScoutBox is

A football (multi-sport later) talent-discovery platform. Players build verified
profiles free from their phone; clubs and licensed agencies discover them through
a desktop recruitment OS. The core product promises: players never pay to be seen,
no unsolicited contact, every scouting action is attributed and auditable, and
minors are structurally invisible to agents.

## The three apps (this repo)

| Folder | What it is | Run |
|---|---|---|
| `scoutbox-server/` | Express sync backend both apps share. Enforces all deck rules server-side. In-memory DB seeded from `seed.mjs`. | `npm install && npm start` → port **4000** |
| `scoutbox-player/` | Player mobile app (Expo SDK 57 / React Native, expo-router, code under `src/app`). | `npm install && EXPO_PUBLIC_API_URL=http://localhost:4000 npx expo start --web` → port **8081** (omit the env var for self-contained demo mode) |
| `scoutbox-club/` | Club & agent desktop app (React 19 + Vite 8, landscape layout). | `npm install && npm run dev` → port **5173** (auto-connects to localhost:4000; override with `VITE_API_URL`; `VITE_DEMO=1` builds a self-contained demo) |

Start the server first. Both frontends then share one live dataset: a club's
contact/trial request appears in the player's Inbox instantly (SSE via `/events`);
a player's Academy+ toggle or upload appears in club search instantly.

To open the apps from other devices on the same Wi-Fi, run the frontends bound to
the network with the API env vars pointed at the host machine's LAN IP, e.g.:

```sh
VITE_API_URL=http://<host-ip>:4000 npm run dev -- --host          # club
EXPO_PUBLIC_API_URL=http://<host-ip>:4000 npx expo start --web --host lan  # player
```

**Demo logins (club app):** Eastport FC (club, Pro, Trusted Partner) ·
Harbour City FC (club, Academy) · North Star Sports Agency (agency — demonstrates
the under-18 wall). Pick an org, type any scout name, enter the workspace.

**Demo login (player app):** "Continue as a demo player" → Kola Adeyemi (maps to the
server's seeded `pl-adeyemi` in live mode).

## Deck rules — all enforced server-side in `scoutbox-server/server.mjs`, not just UI

- **Adults-only launch** — under-age sign-ups rejected by the API (`403 ADULTS_ONLY`), adult age per country (`domain.mjs`).
- **The under-18 wall** — agency accounts can never list, view or contact a minor, on every endpoint (`visibleToOrg`).
- **Scout Inbox** — no direct contact channel exists anywhere in the API; contact unlocks only when the player accepts a request (`contactChannel` stays null until acceptance).
- **Discovery Ledger** — every view/save/shortlist/contact/trial/signing timestamped to a named scout + org (append-only, `ledgerAppend`).
- **Accountability by user** — org requests without an individual `x-user-id` are refused (`401 USER_REQUIRED`). No shared accounts.
- **Proof Pack** — attribution evidence (first qualifying interaction, window, event log) generated on demand (`/org/players/:id/proofpack`).
- **Academy+** — opt-in only, player-controlled badges, boosted cohort in search, framed as a fresh start.
- **Fee protection** — attribution windows + anti-circumvention terms surfaced in Plan & compliance (`/org/plan`).
- **Trial Performance Reports** — MANDATORY after every trial (acceleration, sprint speed, distance, pass %, duel %, coach rating). Partial reports rejected (`400 REPORT_INCOMPLETE`); an org with an unfiled report cannot request new trials (`409 REPORTS_OUTSTANDING`); filed reports sync to the player profile and raise Trust Score.
- **Medical Reports** — player-controlled; stripped from every org view unless the player switches sharing on.
- **Availability + contract status** — player-displayed (available now / end of season / loans / overseas / not seeking; contract expiring etc.).
- **Verified Match Attendance** — fixture + venue + date + GPS + device id required (`400 ATTENDANCE_UNVERIFIABLE` otherwise); raises trust (prototype verification; production = geofence + device attestation).
- **Transfer Timeline** — career milestones on every profile.
- **Scout & Coach Reputation** — seeded track records + live rows computed from the Discovery Ledger (`/org/reputation`).
- **AI Similar Players Engine** — statistical similarity to reference archetypes (position, foot, age, output, physique) — a lead, not a verdict.

## Verified working (2026-07-22, end-to-end, headless browser + API tests)

- `scoutbox-server`: `npm test` → 11 trust/safeguarding domain tests pass.
- Guards confirmed against the running server: under-age signup **403 ADULTS_ONLY**,
  missing user id **401 USER_REQUIRED**, partial trial report **400 REPORT_INCOMPLETE**,
  new trial request with unfiled report **409 REPORTS_OUTSTANDING**.
- Club app (Playwright, real browser): login as Eastport FC → search (10 players,
  Academy+ cohort first) → profile view (ledger logged, similar players returned,
  medical locked notice shown) → contact request → ledger shows all rows.
- Player app (Playwright, live mode): onboarding age gate blocks a minor with the
  adults-only screen → demo identity login → **the club's contact request is in the
  player's Inbox** (org ids stripped, org name + scout name shown) → accept →
  contact channel opens. Trust breakdown renders and matches the server (59 for the
  seeded striker).
- Both frontends build clean: `tsc` strict + `vite build` (club), `tsc` +
  `expo export --platform web` (player). Node v24, npm 11.
- Note: the under-18 wall can't be demoed with current seed data — adults-only
  launch means no seeded minors exist for an agency to be blocked from. The code
  path is there (`isAdult` gate via `visibleToOrg`) and covered by `npm test`.

## Architecture notes

- Server storage is **in-memory** (restart = reset to seed). JSON snapshot / SQLite
  persistence is still a candidate next task. API surface is designed to swap to
  Postgres without changes.
- Live sync is Server-Sent Events (`GET /events`); clients refetch on any event.
  The player app falls back to 3s polling where `EventSource` is unavailable (native).
- Player app has two data clients: `src/data/httpClient.ts` (live server) and
  `src/data/mockClient.ts` (demo mode), selected by `EXPO_PUBLIC_API_URL` in
  `src/data/client.ts`.
- Player app: expo-router tabs (discover / inbox / profile / upload / you) under
  `src/app/(tabs)/`, onboarding flow with age gate (`src/app/onboarding.tsx`),
  domain layer (`src/domain/`) with trust-score + safeguarding logic mirrored by
  the server (`scoutbox-server/domain.mjs` is authoritative — keep in sync).
- Club app is React 19 + Vite 8, two source files of substance
  (`App.tsx`, `screens.tsx`), typed API client in `src/api.ts`. `src/demo.ts` is an
  in-browser mock (VITE_DEMO=1) used for self-contained demo builds only.

## Where we left off / candidate next steps (not yet chosen)

- Milestone 3 scope — to be defined by Younes from the original Claude chat sessions.
- Harden: persistence (JSON snapshot or SQLite), tests beyond `scripts/testTrust.mjs`, typecheck runs in CI.
- One-command startup for all three apps (launch config).
- Cloud deploy so the system is demoable anywhere (static demo builds of both apps
  were published as Claude artifacts from the 2026-07-22 session as a stopgap).

## Constraints to respect

- Local dev servers live inside whatever machine runs them; cloud Claude Code
  sessions can edit code and run the stack in-container, but the user's browser
  cannot reach those ports — use demo builds (artifacts) to hand the apps over.
- Never weaken a server-side rule in favour of UI-only enforcement — the deck's
  claims depend on the API refusing, not the frontend hiding.
