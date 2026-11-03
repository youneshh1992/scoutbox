# ScoutBox server: developer operations

This is the working guide for the sync backend in `scoutbox-server/`. There is no live
deployment and no production data. Every database is seed or test data, so if a data
directory gets into a bad state, delete it and boot again. The previous long-form runbook
is archived in git under the tag `docs-archive-2026-11`. The migration's status and how to do the next step:
[`../docs/architecture/migration.md`](../docs/architecture/migration.md).

## Running locally

- **Node.js 22.16+ on the 22 line, or 24.0+.** The server uses the built-in `node:sqlite`
  module and relies on `DatabaseSync.isTransaction`. `runtime.mjs` defines this check.
  On an unsupported runtime the process stops at startup, before touching `DATA_DIR`:
  `SQLITE_REQUIRED` means the module is missing, and `NODE_UNSUPPORTED` means Node is
  too old. There is no JSON or in-memory fallback.
- **Install and start:** `cd scoutbox-server && npm install && npm start`. The server
  listens on `PORT`, which defaults to `4000`.
- **Data directory:** `DATA_DIR` defaults to `scoutbox-server/data/`. It holds
  `scoutbox.db` (SQLite), `media/` (uploaded files on local disk) and `backups/`. Tests
  point `DATA_DIR` at throwaway temporary directories. Point it at a fresh directory
  whenever you want a clean world.
- **First boot = demo seed.** `seed.mjs` (`buildSeed()`) always builds the in-memory
  demo world. When the directory has never been saved to, this seed initialises the
  tables. On later boots the saved database is authoritative, even when a table is empty,
  and the seed is never imported over it. No separate "empty production" initialisation
  exists. `NODE_ENV=production` changes behaviour, not data:
  - passwordless seeded demo logins are refused (`DEV_LOGIN_DISABLED`);
  - the fault-injection layer and the test identity provider are disabled;
  - the unsafe-configuration checks below become fatal at boot.
- **A legacy `db.json`** found in an empty `DATA_DIR` is imported once and renamed
  `db.json.migrated`. A backup is restored the same way (see Backups). If the file cannot
  be imported, the boot stops with `LEGACY_IMPORT_FAILED` and leaves the file untouched.

### Tests and scripts (`package.json`)

| Command | What it does |
|---|---|
| `npm test` | Runtime contract, data-layer, repository, migration and per-domain batteries, plus their real-server variants. Each one runs on temporary directories. |
| `npm run e2e` | `scripts/apiE2E.mjs` against a running server (`API_URL`, default `http://localhost:4000`). |
| `npm run perf:data-layer` | Data-layer micro-benchmark. |
| `node scripts/m13E2E.mjs` | Delivery, webhook, backup and restore end to end (sets `M13_FAST_RETRY`, `ALLOW_LOCAL_WEBHOOKS`). |
| `node scripts/m13Load.mjs` | Small local load probe. Not a capacity claim. |

Test-only knobs: `TEST_ONLY=<name>` filters cases inside some batteries (for example,
`testUnitOfWork`, `testRecruitmentServer`). `SCOUTBOX_TEST_NODE_BINS=/a/node:/b/node`
makes the runtime test also probe real Node binaries.

## Environment variables

`m181/capabilities.mjs` is the registry. `GET /capabilities` reports what is configured
without revealing any values. `productionConfigProblems()` refuses to boot in production
on the fatal cases listed below. Names in **bold** are the ones the code actually reads.
Where `capabilities.mjs` checks a different name, the Note column says so (see the
mismatches section).

| Variable | Purpose | Default / required |
|---|---|---|
| **`PORT`** | HTTP port | `4000` |
| **`DATA_DIR`** | Database, media and backups directory | `scoutbox-server/data` |
| **`NODE_ENV`** | `production` switches off dev shortcuts and makes config checks fatal | development |
| **`ALLOW_DEV_LOGINS`** | `1` re-enables passwordless demo logins under `NODE_ENV=production` (logs a warning) | off. Note: the capabilities boot check tests `SCOUTBOX_ALLOW_DEV_LOGIN` instead, so it never fires |
| **`ADMIN_KEY`** | Shared key for `/admin` (header `x-admin-key`) | `scoutbox-admin`. Production: required, 16+ chars, not the default (`ADMIN_KEY_UNSAFE`) |
| **`SESSION_TTL_DAYS`** | Session lifetime, judged against the current value (a change applies to existing sessions) | `30` |
| **`SCOUTBOX_ALLOWED_ORIGINS`** | Comma-separated CORS allowlist | unset = permissive in dev |
| **`SCOUTBOX_TRUST_PROXY`** | Proxy hops or subnets to trust for client IP (`0`, `1`, `true`, `loopback, 10.0.0.0/8`) | unset = trust none. Invalid value is fatal in production (`TRUST_PROXY_INVALID`) |
| **`SCOUTBOX_RATE_LIMIT_PROVIDER`** | Rate-limit backend | `memory`. Any other value refuses to start: no shared backend exists |
| **`MEDIA_SECRET`** | HMAC key for signed media URLs | unset = a random key stored in the snapshot (`db.secrets.mediaSign`). Note: capabilities checks `SCOUTBOX_MEDIA_SECRET` and requires it in production (`MEDIA_SECRET_MISSING`), but the server never reads that name |
| **`DELIVERY_CALLBACK_SECRET`** | HMAC for `POST /callbacks/delivery` | `local-fake-callback-secret` |
| **`SENDGRID_API_KEY`** / **`MAIL_FROM`** | Real mail transport / sender | unset = dev outbox. `MAIL_FROM` defaults to `noreply@scoutbox.app`. Note: capabilities reports `email_transport` from `SCOUTBOX_SMTP_URL` / `SMTP_URL`, which nothing else reads |
| **`EXPO_ACCESS_TOKEN`** | Real push via Expo | unset = dev push log |
| **`ONFIDO_API_TOKEN`** | IDV provider switch | unset = dev attestation. Note: capabilities reports `authoritative_identity_provider` from `SCOUTBOX_IDV_PROVIDER` |
| **`STRIPE_SECRET_KEY`** | Billing provider switch | unset = dev ledger |
| **`S3_BUCKET`** | Object storage switch | unset = local disk. Note: capabilities reports `object_storage` from `SCOUTBOX_STORAGE_BUCKET` |
| **`TS_REVIEWER_BOOTSTRAP_ID`** / `_SECRET` / `_NAME` | Creates a Trust & Safety reviewer at boot | unset = none |
| **`BOX_CAM_TEST_PROVIDER`** | `1` enables the simulated Box Cam observer | off. Fatal in production |
| **`AGENT_VERIFICATION_TEST_PROVIDER`** | `1` enables the synthetic licence register (`TEST-VERIFIED-*` references verify) | off. Fatal in production |
| **`TEST_LICENCE_REGISTRY`** | `1` = local licence-register fixture, `down` = simulate its outage | off |
| **`TEST_IDP_SECRET`** | Signing secret for the local test SSO provider | random per boot. Setting it in production is fatal |
| **`SCOUTBOX_FAULTS`** | Dev fault injection, e.g. `delay:/org/players/*/trust:1500;unavailable:/org/rooms/*` (also `POST /__faults`) | off. Ignored and fatal in production |
| **`SCOUTBOX_TEST_CLOCK`** | `1` enables test-clock routes (m23 / m28) | off |
| **`ALLOW_LOCAL_WEBHOOKS`** | `1` permits loopback webhook targets (tests) | off (SSRF guard) |
| **`M13_FAST_RETRY`** | `1` compresses retry ladders and sweep intervals (tests) | off |
| **`M13_QUIET_LOGS`** | `1` silences boot and per-request logs | off |

A trust-weights total other than 100 is also fatal (`TRUST_WEIGHTS_INVALID`).

## Data layer contract

`DATA_DIR/scoutbox.db` holds two kinds of data:

1. **Tables** owned by repositories in `repositories/`. Players, guardians, orgs, staff,
   sessions, recruitment, messaging, notifications, audit and the other migrated domains
   live here. Each change is written as rows inside a transaction.
2. **Blobs.** Every collection that has not moved yet is stored as one JSON row in the
   `collections` table. The whole snapshot is saved on a 2-second debounce
   (`persist()`), or immediately with `persistNow()`.

`GET /capabilities` → `dataLayer` lists the tables, the applied migrations and each
domain's counts.

**Boot order** (`server.mjs`): `buildSeed` → `loadSnapshot` → snapshot migrations
(`m182/migrations.mjs`) → `attachDataLayer` (table migrations, then repositories) →
module registration → integrity report → listen.

### Rules when writing server code

- **Write through the repository, never the view.** After attach, `db.<collection>` for
  a migrated domain is a read-only view (`repositories/readonly.mjs`). Reads work as
  before (find, filter, spread, stringify). A direct push, splice or assignment throws and
  tells you which repository to use. Add records with the repository's `add*` / `insert`
  methods and change rows with `update` / `setItems` / `patchItem` etc. The S8a–S8c
  recruitment domains still expose arrays of plain mutable records that routes edit in place
  (those edits land in the next save's flush). That model is being replaced by explicit
  writes; don't copy it. New domains follow S8d (`repositories/signingsFollowUps.mjs`).
- **Units of work.** If one operation touches more than one table, or a table plus a
  blob, wrap it in `unit(() => { ... })` (`store.unitOfWork`). Inside the unit:
  - The callback must be **synchronous**. An `async` function is refused before it runs.
    A returned promise is not cancelled and counts as a stray. Prepare async work before
    the unit and publish it after.
  - Everything commits or rolls back together, including memory. On failure, in-memory
    records are restored in place and the error is rethrown with
    `err.unitOfWork = 'rolled_back'`. Nothing is left pending for a later save.
  - A nested unit joins the outer one. An inner failure fails the whole unit even if the
    caller catches it. Repository refusals do the same (participant failure).
  - Retry is explicit: rerun the whole operation.
  - Staff (`org_users`) writes are refused inside a unit. Do them outside.
  - Expected negative results (no live code, nothing to delete) are return values and do
    not poison the unit.
- **`store.afterCommit(fn)`** is the mechanism for side effects: broadcasts, pushes, SSE
  events and mail sent after a write. The function runs only after `COMMIT`. A throw or a
  rejected promise inside it is counted and logged, and it never undoes the data. Outside
  a unit it runs immediately. A notification's push and `notify` event run through
  `notifications.afterDurable`, only after the save that carried the row commits.
- **Ordinary saves.** If a debounced save fails, memory stays the intended state and the
  next save writes it. The log line `snapshot save failed:` means a retry is pending, not
  that data was lost. Every save and unit begins with `BEGIN IMMEDIATE`, and every
  connection sets `busy_timeout = 5000`.
- **Responses use allowlists.** Player and guardian responses are built in
  `views/playerViews.mjs`. Add a field to an allowlist on purpose. Never serialise a raw
  record.
- **Typed columns, valid input only** (from S8d on). Each field is a typed column. Routes
  reject junk input; there are no `absent_keys_json` / `offtype_json` / `extra_json` side
  columns on new tables. The S6b–S8c tables still carry them from the old lossless rule.
  List order is kept with `seq` / `position`.
- **Refusals name ids, not content.** Validation errors from repositories and migrations
  carry codes, ids and reasons. They never include a name, e-mail, message body, token or
  code.

### Migrations

There are two registries:

- **Snapshot migrations** (`m182/migrations.mjs`) shape the in-memory blob collections.
  They are idempotent, versioned in `db.schema` and exposed as `X-ScoutBox-Schema`. A
  failing step aborts the boot before anything is saved.
- **Table migrations** (`repositories/migrations/NNNN_name.mjs`, registered in
  `repositories/index.mjs`) export `{ id, note, up(sqlite) }`. They run once, in id order,
  each inside a transaction. Each is recorded in **`data_migrations`** (`id`,
  `applied_at`), and cutover counts go in `meta`. A step that rebuilds a referenced table
  sets `foreignKeysOff` and must leave `PRAGMA foreign_key_check` empty before it
  commits. A failure rolls the step back and aborts the boot with the file unchanged.

When you move a blob domain to tables:

- Import the blob rows into typed columns. Normalise or drop what doesn't fit and report it
  with ids. Refuse the step (`*_IMPORT_BLOCKED`) only when the data is actually unusable. All
  data is seed or test data.
- Retire the blob row in the same transaction.
- Whether a domain reads from its table or its blob depends on its `data_migrations`
  record, never on whether the table exists or has rows.
- After attach, an in-memory array (seed, `??= []` default, stale copy) is never imported
  into a live table.

The latest table migration is `0018_signings_follow_ups`.

**Snapshot mode.** `openStore(dir)` without options is for tools and fixtures. It reads
and writes the whole database in the shape the server sees, tables included. A snapshot
write is strict: a malformed collection or any invalid row rejects the whole save. An
omitted collection leaves its table alone. An explicit `[]` empties it. Snapshot mode has
no units of work.

## Backups and restore

These routes exist (`m13/enterprise.mjs`). Admin routes need the `x-admin-key` header.

- `POST /admin/backup` writes `DATA_DIR/backups/<timestamp>/`, which contains:
  - `db.json`: the full snapshot in legacy collection shape, with sessions as token
    hashes and one-time codes as hashes;
  - `media/`: media files, except files queued for removal;
  - `manifest.json`: checksums and counts, written last.

  A failure removes the partial directory and returns `500 BACKUP_FAILED`. A media-queue
  ownership conflict returns `409 MEDIA_QUEUE_OWNERSHIP_CONFLICT`.
- `POST /admin/backup/verify {dir}` re-checksums a backup. `GET /admin/backups` lists
  backups.
- **Restore:** copy the backup into a new, empty directory and boot with `DATA_DIR`
  pointing at it. The first boot imports `db.json` and runs every table migration over
  it. Never restore over a live directory.
- Backups contain personal (seed) data. The manifest says they contain no server secrets.
  However, the auto-generated media signing key lives in the snapshot (`db.secrets`), so
  that claim depends on whether the export strips it.

## External adapters (`adapters.mjs`, `m13/delivery.mjs`)

Every external service has a dev transport that fully works, and tests use it. Setting
the named variable switches the adapter.

| Adapter | Switch | Dev behaviour | Live behaviour today |
|---|---|---|---|
| Mail | `SENDGRID_API_KEY` | Records go to the `outbox` table, visible at `GET /admin/outbox`. Codes are withheld from the persisted text. The full text of the last 500 mails is kept in process memory only, so after a restart request a fresh code. | Real SendGrid `fetch` |
| Push | `EXPO_ACCESS_TOKEN` | Records go to `push_log` (`GET /admin/push-log`) | Real Expo `fetch` |
| IDV | `ONFIDO_API_TOKEN` | Instant approval with an audit reference (`dev-attestation`) | **Stub:** labelled `onfido` but still auto-approves |
| Billing | `STRIPE_SECRET_KEY` | Success-fee invoices in `db.invoices` (`dev-ledger`) | **Stub:** labelled `stripe`, no API call |
| Storage | `S3_BUCKET` | Files under `DATA_DIR/media/` | **Stub:** labelled `s3`, still writes local disk |
| Delivery centre | n/a | In-process `local-fake` provider. `POST /admin/delivery/inject-failure` simulates failures and `POST /admin/delivery/sweep` forces a pass | No real provider |
| Box Cam CV | `BOX_CAM_TEST_PROVIDER=1` | Labelled simulated observer, never production evidence | No production CV provider |
| Staff SSO | `TEST_IDP_SECRET` | Local test IdP, dev only | None |

## Operational endpoints and behaviour

- `GET /healthz` returns liveness and schema. `GET /readyz` checks that the store is
  writable and data is loaded.
- `GET /capabilities` (unauthenticated) reports capability states and `dataLayer`. It
  never includes keys, hostnames or connection strings.
- `GET /admin/metrics` reports per-process counters and backlogs since boot.
  `GET /admin/data-layer` gives data-layer detail.
- **Logs.** Each request writes one JSON line `{t,id,m,p,s,ms}`. The correlation id comes
  from an inbound `X-Request-Id` or is generated, and is echoed back. Tokens, auth
  headers, bodies and e-mail addresses are never logged.
- **Integrity report at boot.** Violations are logged as `INTEGRITY <code> key=… ids=…`
  and counted on `/capabilities`. They are never repaired.
- **Background jobs.** Webhook deliveries, delivery dispatches, follow-ups, transition
  expiry, review reminders and the media-removal sweep are stored as persisted state.
  Interval timers (about 60 s, faster with `M13_FAST_RETRY`) sweep them with bounded
  retries. Media files queued for removal are removed after commit, again at boot, and
  every minute until the removal is confirmed.
- **Rate limits** are per process (`m181/rateLimit.mjs`, `RATE_LIMIT_POLICY` is the
  single table). Behind a proxy, set `SCOUTBOX_TRUST_PROXY`. Otherwise every client
  shares one address and the `/auth` limit becomes global.
- **Shutdown.** `SIGINT` / `SIGTERM` flush the pending debounced save (`persistNow()`).
