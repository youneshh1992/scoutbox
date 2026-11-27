# ScoutBox

A football recruitment platform: players (and their guardians) build an evidenced football profile, and clubs,
grassroots clubs and agents discover and recruit them, with safeguarding for under-18s built in.

| Folder | What it is | Run (from the folder) | Port |
|---|---|---|---|
| `scoutbox-server/` | The API all apps share (Gleam on Erlang/OTP, SQLite at `data/scoutbox.db`) | `gleam run` | 4000 (`/health`) |
| `scoutbox-player/` | Player app (Expo / React Native; web, iOS, Android) | `npx expo start --web` | 8081 |
| `scoutbox-club/` | **ScoutBox Pro**: the professional club portal (React, Vite) | `npm run dev` | 5173 |
| `scoutbox-grassroots/` | **ScoutBox Grassroots**: the portal for amateur and semi-pro clubs | `npm run dev` | 5175 |
| `scoutbox-agent/` | **ScoutBox Agent**: the workspace for licensed football agents | `npm run dev` | 5176 |
| `scoutbox-admin/` | Trust & Safety console (dev key `scoutbox-admin`) | `npm run dev` | 5174 |
| `design-system/` | Shared tokens, styles and components for the web portals | | |
| `e2e/` | End-to-end tests and the self-contained demo builds | | |
| `docs/` | Decisions, product rules, UI approvals, server architecture: **start at [`docs/README.md`](docs/README.md)** | | |

## Running it locally

Node 22.18 or later for the apps and scripts, and [Gleam](https://gleam.run/getting-started/installing/) 1.19 with
Erlang/OTP 29 for the server. `npm run setup` checks all three.

```bash
npm run setup      # once: installs every app from its lockfile and builds the server's patched SQLite driver
npm run dev        # server + Player + Pro + Grassroots + Agent (dev:all adds the T&S console)
npm run reseed     # with the server stopped: archive the database so the next start seeds fresh
```

The launcher checks prerequisites, won't start twice, and prints the URLs once each app is serving.
Apps talk to `http://localhost:4000` by default. Override with `VITE_API_URL` / `EXPO_PUBLIC_API_URL`
(see each app's `.env.example`). Demo mode with mock data is explicit: `VITE_DEMO=1` / `EXPO_PUBLIC_DEMO=1`.

The seed's people and clubs (Kola, Amara, Eastport FC, Harbour City FC, Hackney Marsh Rovers, North Star Sports Agency, …)
are passwordless development logins, refused in production. To try a phone on the same Wi-Fi, start the Player with
`EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:4000 npx expo start` and scan the QR code with Expo Go.

Running the server and its settings: [`scoutbox-server/README.md`](scoutbox-server/README.md). The data-layer rules:
[`docs/architecture.md`](docs/architecture.md).

## Formatting

All code is formatted by [Biome](https://biomejs.dev) (`biome.json`). `npm run setup` installs a pre-commit hook that
formats the files you commit; CI fails on anything unformatted. `npm run format` formats everything. Formatting-only
commits are listed in `.git-blame-ignore-revs`, so `git blame` skips them.

## Tests

```bash
cd scoutbox-server && gleam test               # server unit tests and blessed fixtures
cd scoutbox-server && npm run e2e                # end-to-end batteries (each starts its own servers on temporary data dirs)
npm run test:server                              # both
cd scoutbox-player && npm test                   # Player (Jest, jest-expo)
NODE_PATH=e2e/node_modules node e2e/<suite>Live.test.mjs   # a browser suite against its own server and builds
```

CI (`.github/workflows/ci.yml`) runs the server's checks, tests and batteries, builds and boots the container image,
and type-checks and builds every app. The browser suites in `e2e/` are run by hand; several are out of date with
the apps (`docs/known-issues.md`).

## Demo builds

`node e2e/buildDemos.mjs`, then `node e2e/demoFreshness.test.mjs`. The output is self-contained HTML files in
`e2e/dist/` (Player, Pro, Grassroots, Agent, admin). See [`docs/design.md`](docs/design.md#demo-artifact-build-procedure).

## Deployment

Not live. `Dockerfile`, `fly.toml` and `render.yaml` are kept for when it is; see
[`docs/product/platform.md`](docs/product/platform.md) and [`docs/known-issues.md`](docs/known-issues.md) first.
