# ScoutBox — Project Status & Handoff

> Purpose of this file: let any Claude Code session (cloud or local) pick up this
> project with zero prior context. Keep it updated at the end of each working session.

**Last updated:** 2026-07-22 · **Milestone: 2 complete (rebuilt on Claude Code web)** ·
Now developed in this GitHub repo (`youneshh1992/scoutbox`), branch history starts from
the cloud migration.

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
