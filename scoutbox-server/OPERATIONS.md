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
- **First boot.** When the directory has never been saved to, `seed.mjs` (`buildSeed()`)
  initialises it. In development that is the demo world (people, clubs, track records);
  in production it is empty: no people, clubs or track records (the plans and archetypes
  are constants in `catalogue.mjs`, not data). `SCOUTBOX_SEED_DEMO=1` or `=0` overrides either way (`demoSeedEnabled` in
  `domains/platform/capabilities.mjs`). On later boots the saved database is authoritative, even when a
  table is empty, and the seed is never imported over it. `NODE_ENV=production` also:
  - passwordless seeded demo logins are refused (`DEV_LOGIN_DISABLED`);
  - the fault-injection layer and the test identity provider are disabled;
  - the unsafe-configuration checks below become fatal at boot.
- **There is no `db.json` import.** A file of that name in `DATA_DIR` is ignored. A backup
  is restored by copying its `scoutbox.db` (see Backups).

### Tests and scripts (`package.json`)

| Command | What it does |
|---|---|
| `npm test` | Runtime contract, data-layer, repository, migration and per-domain batteries, plus their real-server variants (`scripts/runTests.mjs`, the list is `SUITES`). Each suite runs on its own temporary directories and free ports, up to 4 at a time (`TEST_JOBS`); a failing suite prints its whole log (`TEST_VERBOSE=1` prints every log). Each suite's temporary files live in a folder of its own (its `TMPDIR`), deleted when it exits; `TEST_KEEP_TMP=1` keeps a failing suite's folder and prints its path. `npm test -- testOrgs testSessions` runs only those. |
| `npm run e2e` | Every end-to-end battery in `e2e/<domain>/` (`scripts/runE2E.mjs`, the list is `BATTERIES`; it refuses to run while a battery is unlisted). Up to 4 at a time like `npm test`, with the same `TEST_JOBS`, `TEST_VERBOSE`, `TEST_KEEP_TMP` and temporary-folder clean-up. `npm run e2e -- recruitment` runs one domain, `npm run e2e -- platform/api` one battery. A check that fails for a reason in `docs/known-issues.md` uses `e2e/support/knownFailure.mjs` and fails the battery once it passes. |
| `node e2e/platform/api.mjs` | The API battery. Starts its own freshly seeded server on a free port and a temporary `DATA_DIR`, and removes both. To test a server you started yourself, pass both `API_URL` and that server's `DATA_DIR`; `API_URL` alone is refused, because the persistence checks read the data directory. |
| `npm run perf:recruitment -- [players] [clones] [busy]` | Recruitment at scale through the real server: synthetic players and cloned recruitment graphs, hot-route timings, one write's log volume, the sweep queries (migration.md §4.3 step 4). |
| `node scripts/tools/boxCamCvEvaluation.mjs` | Re-measures the Box Cam engine against its golden fixtures and rewrites `domains/development/boxcam/cv/evaluation.json`, which the Combine production gate reads. Run it when the engine changes and commit the result. `scripts/tools/boxCamCvHoldout.mjs` is the matching holdout run (`domains/development/boxcam/cv/holdout.json`). |
| `node e2e/operations/clubOperations.mjs` | Delivery, webhook, backup and restore end to end (sets `M13_FAST_RETRY`, `ALLOW_LOCAL_WEBHOOKS`). |

Test-only knobs: `TEST_ONLY=<name>` filters cases inside some batteries (for example,
`testUnitOfWork`, `testRecruitmentServer`). `SCOUTBOX_TEST_NODE_BINS=/a/node:/b/node`
makes the runtime test also probe real Node binaries.

## Environment variables

`domains/platform/capabilities.mjs` is the registry. `GET /capabilities` reports what is configured
without revealing any values. `productionConfigProblems()` refuses to boot in production
on the fatal cases listed below. Names in **bold** are the ones the code reads; the others
are refused in production.

| Variable | Purpose | Default / required |
|---|---|---|
| **`PORT`** | HTTP port | `4000` |
| **`DATA_DIR`** | Database, media and backups directory | `scoutbox-server/data` |
| **`NODE_ENV`** | `production` switches off dev shortcuts and makes config checks fatal | development |
| **`SCOUTBOX_SEED_DEMO`** | `1` loads the demo world on a first boot, `0` starts empty. Ignored once the database has been saved | unset = demo in development, empty in production. Any other value is fatal in production (`SEED_DEMO_INVALID`) |
| `ALLOW_DEV_LOGINS` | Not read. Passwordless demo logins exist in development only | Setting it in production is fatal (`DEV_LOGIN_IN_PRODUCTION`) |
| **`ADMIN_KEY`** | Shared key for `/admin` (header `x-admin-key`) | `scoutbox-admin`. Production: required, 16+ chars, not the default (`ADMIN_KEY_UNSAFE`) |
| **`SESSION_TTL_DAYS`** | Session lifetime, judged against the current value (a change applies to existing sessions) | `30` |
| **`SCOUTBOX_ALLOWED_ORIGINS`** | Comma-separated CORS allowlist | unset = permissive in dev |
| **`SCOUTBOX_TRUST_PROXY`** | Proxy hops or subnets to trust for client IP (`0`, `1`, `true`, `loopback, 10.0.0.0/8`) | unset = trust none. Invalid value is fatal in production (`TRUST_PROXY_INVALID`) |
| **`SCOUTBOX_RATE_LIMIT_PROVIDER`** | Rate-limit backend | `memory`. Any other value refuses to start: no shared backend exists |
| **`MEDIA_SECRET`** | HMAC key for signed media URLs | unset = a random key per process, never stored (links stop verifying after a restart; clients re-mint them). Production: required, 32+ chars (`MEDIA_SECRET_MISSING`) |
| **`DELIVERY_CALLBACK_SECRET`** | HMAC for `POST /callbacks/delivery` | `local-fake-callback-secret` |
| **`SENDGRID_API_KEY`** / **`MAIL_FROM`** | Real mail transport / sender | unset = dev outbox. `MAIL_FROM` defaults to `noreply@scoutbox.app`. |
| **`EXPO_ACCESS_TOKEN`** | Real push via Expo | unset = dev push log |
| `ONFIDO_API_TOKEN`, `STRIPE_SECRET_KEY`, `S3_BUCKET` | Not read: no real IDV, billing or storage provider exists | Setting one in production is fatal (`PROVIDER_NOT_IMPLEMENTED`) |
| **`TS_REVIEWER_BOOTSTRAP_ID`** / `_SECRET` / `_NAME` | Creates a Trust & Safety reviewer at boot | unset = none |
| **`BOX_CAM_TEST_PROVIDER`** | `1` enables the simulated Box Cam observer | off. Fatal in production |
| **`AGENT_VERIFICATION_TEST_PROVIDER`** | `1` enables the synthetic licence register (`TEST-VERIFIED-*` references verify) | off. Fatal in production |
| **`TEST_LICENCE_REGISTRY`** | `1` = local licence-register fixture, `down` = simulate its outage | off |
| **`TEST_IDP_SECRET`** | Signing secret for the local test SSO provider | random per boot. Setting it in production is fatal |
| **`SCOUTBOX_FAULTS`** | Dev fault injection, e.g. `delay:/org/players/*/trust:1500;unavailable:/org/rooms/*` (also `POST /__faults`) | off. Ignored and fatal in production |
| **`SCOUTBOX_TEST_CLOCK`** | `1` enables test-clock routes (m23 / m28) | off |
| **`ALLOW_LOCAL_WEBHOOKS`** | `1` permits loopback webhook targets (tests) | off (SSRF guard) |
| **`M13_FAST_RETRY`** | `1` compresses retry ladders and sweep intervals (tests) | off |
| **`SCOUTBOX_SAVE_DEBOUNCE_MS`** | Shortens the 2-second debounced save (10–2000 ms) so test suites need not wait for it | 2000. Never honoured in production, and fatal there (`SAVE_DEBOUNCE_IN_PRODUCTION`). Any other value is the normal delay (`SAVE_DEBOUNCE_INVALID`) |
| **`M13_QUIET_LOGS`** | `1` silences boot and per-request logs | off |

A trust-weights total other than 100 is also fatal (`TRUST_WEIGHTS_INVALID`).

## Data layer contract

`DATA_DIR/scoutbox.db` holds tables only, each owned by one repository in `repositories/`. There is no blob store
(S14a dropped the `collections` table). Besides the domain tables: `data_migrations` (the schema history), `meta`
(the first installation's initialisation states, the session lifetime) and `counters` (the id counter, written at
every mint).

Most repositories write their rows at once. The staged ones (organisations' facets, players and guardians,
notifications) keep a mirror in memory and
write what changed at the next save: a 2-second debounce (`persist()`), immediately with `persistNow()`, or in the
commit of the unit of work they joined.

`GET /capabilities` → `dataLayer` lists the tables, the applied migrations and each
domain's counts.

**Boot order** (`server.mjs`): open the store → `attachDataLayer` (table migrations, then repositories; a first
installation imports `buildSeed()`'s organisations, players and guardians once) → integrity report → module
registration → listen.

### Rules when writing server code

- **Write through the repository, never the view.** After attach, `db.<collection>` for
  a migrated domain is a read-only view (`repositories/readonly.mjs`). Reads work as
  before (find, filter, spread, stringify). A direct push, splice or assignment throws and
  tells you which repository to use. Add records with the repository's `add*` / `insert`
  methods and change rows with `update` / `setItems` / `patchItem` etc. New domains follow
  S8b (`repositories/recruitmentCases.mjs`, cases and rooms), S8a
  (`repositories/recruitment.mjs`, requests and trials), S8c
  (`repositories/recruitmentContactsOffers.mjs`) or S8d (`repositories/signingsFollowUps.mjs`):
  `create(record)` and `update(id, (draft) => …)`, which types the whole record and writes it
  at once. A route that edits a record and then reads it must use the record `update`
  returns; the one it held before is the old version. Don't call `update` for a record from
  inside its own `update` (it is refused): make the second change after the first returns.
- **Look records up by id through the index.** Every module context carries `byId`
  (`domains/platform/lookups.mjs`): `byId.player(id)`, `byId.guardian(id)`, `byId.user(id)`,
  `byId.org(id)` and `byId.mediaOwner(clipId)`, each answering the record view or null, with an
  optional further condition (`byId.user(id, (u) => u.orgId === org.id && !u.removedAt)`). Never
  `db.players.find((p) => p.id === id)`: that scans the whole collection on every call. Players
  and guardians are read-only views; every change is a repository operation, written at once
  (S4a-E), so a save has nothing of theirs to find.
- **Read SQL where the domain has no view.** Since §4.3 step 2 a domain whose reads moved
  to SQL has no `db.<collection>` at all (reading or assigning it throws and names the
  repository). The whole recruitment domain (cases and Room records, requests, trials,
  contacts, offers, signing packages, signings, follow-ups, outcome reports) has moved, and so
  have the scouting evidence passport, coach affiliations and squad invitations (S9a) the assessment templates, assessments, video segments and playlists (S9b), and a club's tactical setup, squad, shadow list, looking-for, federation request and vacancies (S9c, which also retired the organisation facets `tactical`, `squad`, `lookingFor` and `federationCheck`: reading one on an organisation throws), the opportunity board, applications, assessment campaigns and players' private suitability preferences (S9d), and the verification claims, their evidence vault, tokens, administrators, root applications, disputes, references, squad invitations by code, conflicts, domain requests and verified domains (S10a, which also retired the organisation facet `verification`: its revocation is the organisation field `verificationRevokedAt`), the Passport's preferences, career entries, achievements, share links and correction requests (S10b), and transition cases and coach references (S10c; a reference's one-time code is stored only as its hash): ask the repository (`recruitmentContactsOffers.contacts.forCase`,
  `signingsFollowUps.signings.forOrgPlayer`, `scoutingEvidence.evidence.currentForPlayer`, …, or the read-only `recruitmentReads`
  `scoutingReads` and `verificationReads` every module context carries). A list that grows without limit pages by cursor through
  `domains/platform/paging.mjs` (`readPage` at the route, a `pageFor…` query in the
  repository that asks for one row more than the page). Each record is a fresh,
  deep-frozen decode; a query inside a unit of work sees the unit's own writes. Pure
  projectors take the queries as an argument (`reads`) rather than reading `db`.
- **Units of work.** If one operation touches more than one table, wrap it in `unit(() => { ... })` (`store.unitOfWork`). Inside the unit:
  - The callback must be **synchronous**. An `async` function is refused before it runs.
    A returned promise is not cancelled and counts as a stray. Prepare async work before
    the unit and publish it after.
  - Everything commits or rolls back together, including the staged repositories' mirrors.
    On failure, they restore their in-memory records and the error is rethrown with
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
  next save writes it. The log line `save failed:` means a retry is pending, not
  that data was lost. Every save and unit begins with `BEGIN IMMEDIATE`, and every
  connection sets `busy_timeout = 5000`.
- **Responses use allowlists.** Player and guardian responses are built in
  `views/playerViews.mjs`. Add a field to an allowlist on purpose. Never serialise a raw
  record.
- **Typed columns, valid input only**. Each field is a typed column. Routes
  reject junk input; there are no `absent_keys_json` / `offtype_json` / `extra_json` side
  columns. List order is kept with `seq` / `position`.
- **Refusals name ids, not content.** Validation errors from repositories and migrations
  carry codes, ids and reasons. They never include a name, e-mail, message body, token or
  code.

### Migrations

**Table migrations** (`repositories/migrations/NNNN_name.mjs`, registered in
  `repositories/index.mjs`) are the one registry. They export `{ id, note, up(sqlite) }`. They run once, in id order,
  each inside a transaction. Each is recorded in **`data_migrations`** (`id`,
  `applied_at`). A step that rebuilds a referenced table
  sets `foreignKeysOff` and must leave `PRAGMA foreign_key_check` empty before it
  commits. A failure rolls the step back and aborts the boot with the file unchanged.
  The schema version is the number of the latest one (`0039_retire_blob` → 39), reported on
  `/healthz`, in `/capabilities` → `schema` and on every response as `X-ScoutBox-Schema`.

A migration's `up()` is its DDL (plus any table rebuild the step needs). It does not carry
data over: there is no production data, and rollback means re-seed.

The latest table migration is `0039_retire_blob`.

**Snapshot mode.** `openStore(dir)` without options is for tools and fixtures. It runs the
table migrations when it opens the file, then reads and writes the whole database in the
shape the server sees. A saved snapshot is never a first installation. A snapshot
write is strict: a malformed collection, a collection with no table (`SNAPSHOT_COLLECTION_UNKNOWN`) or any invalid
row rejects the whole save. An
omitted collection leaves its table alone. An explicit `[]` empties it. Snapshot mode has
no units of work.

## Backups and restore

These routes exist (`domains/enterprise/enterprise.mjs`). Admin routes need the `x-admin-key` header.

- `POST /admin/backup` writes `DATA_DIR/backups/<timestamp>/`, which contains:
  - `scoutbox.db`: a consistent copy of the database (`VACUUM INTO`, `store.copyTo`),
    taken after a flush: every table and every remaining blob, with sessions and
    one-time codes as hashes, as they are stored;
  - `media/`: media files, except files queued for removal (their queue entries are in
    the copy, and the restored server finishes the removal at boot);
  - `manifest.json`: contract `backup.2026-11.v2`, checksums and counts, written last.

  A failure removes the partial directory and returns `500 BACKUP_FAILED`. A media-queue
  ownership conflict returns `409 MEDIA_QUEUE_OWNERSHIP_CONFLICT`.
- `POST /admin/backup/verify {dir}` re-checksums a backup. `GET /admin/backups` lists
  backups.
- **Restore:** copy the backup into a new, empty directory and boot with `DATA_DIR`
  pointing at it. The boot opens the copied `scoutbox.db` as it is. A corrupt file stops
  the boot, and so does an empty (0-byte) one (`DATABASE_EMPTY`): it is never taken for a
  new installation. Never restore over a live directory.
- Backups contain personal (seed) data but no server secrets: `ADMIN_KEY` and
  `MEDIA_SECRET` live only in the environment.

## External adapters (`adapters.mjs`, `m13/delivery.mjs`)

Every external service has a dev transport that fully works, and tests use it. Setting
the named variable switches the adapter. `ONFIDO_API_TOKEN`, `STRIPE_SECRET_KEY` and `S3_BUCKET`
used to relabel stubs as live providers; production now refuses them (`PROVIDER_NOT_IMPLEMENTED`).

| Adapter | Switch | Dev behaviour | Live behaviour today |
|---|---|---|---|
| Mail | `SENDGRID_API_KEY` | Records go to the `outbox` table, visible at `GET /admin/outbox`. Codes are withheld from the persisted text. The full text of the last 500 mails is kept in process memory only, so after a restart request a fresh code. | Real SendGrid `fetch` |
| Push | `EXPO_ACCESS_TOKEN` | Records go to `push_log` (`GET /admin/push-log`). Devices register with `POST /push/register` (players and guardians only); one row per device token, so a token another account registers moves to it | Real Expo `fetch`, one call per registered token |
| IDV | none | Instant approval with an audit reference (`dev-attestation`), in every mode | Not built |
| Billing | none | Success-fee invoices in the `invoices` table, in minor units (`dev-ledger`) | Not built |
| Storage | none | Files under `DATA_DIR/media/` | Not built |
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
- **Rate limits** are per process (`domains/platform/rateLimit.mjs`, `RATE_LIMIT_POLICY` is the
  single table). Behind a proxy, set `SCOUTBOX_TRUST_PROXY`. Otherwise every client
  shares one address and the `/auth` limit becomes global.
- **Shutdown.** `SIGINT` / `SIGTERM` flush the pending debounced save (`persistNow()`).
