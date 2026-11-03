# ScoutBox

A football recruitment platform: players (and their guardians) build an evidenced football profile, and clubs,
grassroots clubs and agents discover and recruit them, with safeguarding for under-18s built in.

| Folder | What it is | Run (from the folder) | Port |
|---|---|---|---|
| `scoutbox-server/` | The API all apps share (Node, Express, SQLite at `data/scoutbox.db`) | `npm start` | 4000 (`/health`) |
| `scoutbox-player/` | Player app (Expo / React Native; web, iOS, Android) | `npx expo start --web` | 8081 |
| `scoutbox-club/` | **ScoutBox Pro**: the professional club portal (React, Vite) | `npm run dev` | 5173 |
| `scoutbox-grassroots/` | **ScoutBox Grassroots**: the portal for amateur and semi-pro clubs | `npm run dev` | 5175 |
| `scoutbox-agent/` | **ScoutBox Agent**: the workspace for licensed football agents | `npm run dev` | 5176 |
| `scoutbox-admin/` | Trust & Safety console (dev key `scoutbox-admin`) | `npm run dev` | 5174 |
| `design-system/` | Shared tokens, styles and components for the web portals | | |
| `e2e/` | End-to-end tests and the self-contained demo builds | | |
| `docs/` | Decisions, product rules, UI approvals, the migration plan: **start at [`docs/README.md`](docs/README.md)** | | |

## Running it locally

Node ≥22.16 on the 22 line, or ≥24. The server uses `node:sqlite`.

```bash
npm run setup      # once: installs every app from its lockfile
npm run dev        # server + Player + Pro + Grassroots + Agent (dev:all adds the T&S console)
npm run reseed     # with the server stopped: archive the database so the next start seeds fresh
```

The launcher checks prerequisites, won't start twice, and prints the URLs once each app is serving.
Apps talk to `http://localhost:4000` by default. Override with `VITE_API_URL` / `EXPO_PUBLIC_API_URL`
(see each app's `.env.example`). Demo mode with mock data is explicit: `VITE_DEMO=1` / `EXPO_PUBLIC_DEMO=1`.

The seed's people and clubs (Kola, Amara, Eastport FC, Harbour City FC, Hackney Marsh Rovers, North Star Sports Agency, …)
are passwordless development logins, refused in production. To try a phone on the same Wi-Fi, start the Player with
`EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:4000 npx expo start` and scan the QR code with Expo Go.

Running the server, its environment variables and the data-layer rules: [`scoutbox-server/OPERATIONS.md`](scoutbox-server/OPERATIONS.md).

## Tests

```bash
cd scoutbox-server && npm test                   # server unit suites
cd scoutbox-player && npm test                   # Player (Jest, jest-expo)
npm run test:server                              # server unit suites + connected end-to-end
cd scoutbox-server && npm run e2e                # API end-to-end (starts its own server on a temporary data dir)
```

CI (`.github/workflows/ci.yml`) runs the server suites and end-to-end batteries, and type-checks and builds every app.

## Demo builds

`node e2e/buildDemos.mjs`, then `node e2e/demoFreshness.test.mjs`. The output is self-contained HTML files in
`e2e/dist/` (Player, Pro, Grassroots, Agent, admin). See [`docs/design.md`](docs/design.md#demo-artifact-build-procedure).

## Deployment

Not live. `Dockerfile`, `fly.toml` and `render.yaml` are kept for when it is; see
[`docs/product/platform.md`](docs/product/platform.md) and [`docs/known-issues.md`](docs/known-issues.md) first.
