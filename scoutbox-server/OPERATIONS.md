# ScoutBox server operations (Milestone 13)

## Secrets
Secrets live in the **environment**, never in the database or backups:
- `ADMIN_KEY` — Trust & Safety console key (dev default `scoutbox-admin`; set a real one in production).
- `DELIVERY_CALLBACK_SECRET` — HMAC secret for provider delivery callbacks (dev default `local-fake-callback-secret`).
- `TEST_IDP_SECRET` — local test IdP signing secret (dev only; the test IdP is disabled outside dev).
- Media-URL signing keys are generated per boot (M11).
Webhook endpoint secrets and API-key hashes are tenant data and DO live in the
database; API keys themselves are stored as SHA-256 hashes and shown once.

Flags: `ALLOW_LOCAL_WEBHOOKS=1` (loopback webhook destinations, tests only),
`M13_FAST_RETRY=1` (compressed retry ladders + fast verification sweep, tests
only), `M13_QUIET_LOGS=1` (suppresses per-request log lines),
`TEST_LICENCE_REGISTRY=1|down` (enables the LOCAL licence-register test
fixture / simulates its outage — test environments only; production registers
are `not_configured`), `ALLOW_DEV_LOGINS` / `NODE_ENV` (see M11).

## Structured logs & correlation
Every request logs one JSON line `{t,id,m,p,s,ms}` — correlation id (accepts
inbound `X-Request-Id`, echoes it back), method, path, status, duration.
Tokens, auth headers, bodies and emails are never logged.

## Health & metrics
- `GET /healthz` — liveness. `GET /readyz` — snapshot store writable + data loaded.
- `GET /admin/metrics` — request counters, failed uploads, delivery/webhook
  failures and backlogs, recent ops events. Counters are per-process since
  boot; they are local development metrics, not an SLA measurement.
- `POST /admin/delivery/inject-failure` — inject provider failures to verify
  monitoring + retry behaviour (used by `scripts/m13E2E.mjs`).

## Backups
`POST /admin/backup` writes `DATA_DIR/backups/<timestamp>/`:
- `db.json` — full consistent snapshot (same shape the store imports on first boot),
- `media/` — media files,
- `manifest.json` — SHA-256 checksums, sizes, counts, restore instructions.
`POST /admin/backup/verify {dir}` re-checksums a backup.
Backups contain no environment secrets, but they contain personal data —
store them with the same care as the live data directory.

## Restore (never over a live directory)
1. Copy the backup directory to a **new, empty** location.
2. Start the server with `DATA_DIR=<that location>` — the store imports
   `db.json` on first boot and renames it `db.json.migrated`.
3. Smoke-check `/readyz`, a login, and a representative read.
`scripts/m13E2E.mjs` performs exactly this cycle (backup → verify → copy →
boot second server → login + player list) on every run.

## Load — measured result (2026-09-09)
`node scripts/m13Load.mjs` — bounded, isolated, agreed-in-code limits:
- environment: local container, single node process, throwaway seeded DB (14 players, 5 orgs)
- 600 requests, concurrency 12, mixed read-heavy workload with writes
- wall 0.4 s · ~1392 req/s · latency p50 7 ms · p90 14 ms · p99 31 ms · max 39 ms · 0 errors
This demonstrates the request path holds under modest local concurrency. It
is **not** a capacity claim, an SLA, or a statement about production hardware
or real dataset sizes.

## Jobs & durability
All background work (webhook deliveries, delivery-centre dispatches,
follow-ups, transition expiry, review reminders) is persisted state swept by
interval timers with bounded retries — `scripts/m13E2E.mjs` proves a SIGKILL
mid-queue loses nothing.
