# ScoutBox migration plan: from the JSON snapshot to relational SQLite

Companion to [`sqlite-schema.md`](./sqlite-schema.md) (the target schema) and the DDL in
`docs/architecture/sql/`. Written 10 October 2026 on branch `feat/sqlite-schema`.

Status of the steps: **S0 done** (commit `0f01df7`), **S1 done** (this branch, §S1 records
the commands and results), S2–S14 planned. The step after this commit is **S2**.

Sections: A principles that hold for every step · B the steps (S0–S14) · C cross-cutting
work (repository pattern, source of truth and dual writes, backups and dry runs, legacy
snapshots, determinism and reconciliation, crash recovery, production init vs demo,
performance, existing tests, what this plan is not).

---

## A. Principles that hold for every step

1. **One domain per step, blob source of truth until that domain's cutover.** A domain is
   first mirrored (a *shadow*: the blob is still written and read, the tables are rewritten
   from it inside the same save transaction and compared), then cut over (the repository
   owns the tables, the blob for that domain is deleted from `collections`, and
   `db.<collection>` becomes a read-only view that throws on direct writes). There is never
   a period where both the blob and the table accept writes for the same domain from
   different code paths.
2. **Additive first.** Every step adds tables through a numbered migration in
   `scoutbox-server/repositories/migrations/`; nothing drops a blob until the step that owns
   it has passed its acceptance criteria; the blob store itself is retired only at S14.
3. **The end-to-end suites are the specification.** A domain is migrated when its suites in
   `scoutbox-server/scripts/*E2E.mjs` and `e2e/` pass unchanged, except assertions that exist
   only to describe the old storage (those are rewritten to describe the new storage, never
   deleted). `npm test` (unit level) grows with every step.
4. **Ids and tokens are preserved exactly.** No client ever has to re-login or re-fetch an id
   because of a migration step. Hashing a token server-side keeps the client's copy valid.
5. **Temporary databases only.** Every test and every dry run uses `os.tmpdir()` or a copy of
   a snapshot in a disposable directory. No step modifies, reseeds, deletes or migrates the
   running data directory; the server migrates its own file only at boot, in a transaction,
   after a backup exists (C.3).
6. **Every step has a rollback** that is either "restore the pre-step backup and run the
   previous commit" or "the step is additive and can simply not be read". Where a rollback
   loses data written after the step, the step says so.
7. **One commit per step** (or per clearly named sub-step), containing the migration, the
   repository, the tests, and the documentation changes together, so the commit is
   independently reviewable and revertable.

### Step template (every step below is written to it)

- **Objective**, **Depends on**, **Files / modules / tables**, **Code changes and data
  transformations**, **API compatibility**, **Tests and acceptance criteria**, **Rollback /
  recovery**, **Commit boundary**.

---

## B. The steps

### S0 — Data-layer foundation and the first live table (`org_users`) — DONE (`0f01df7`)

- **Objective.** Put the machinery in place: a table-migration registry recorded in the
  database (`data_migrations`), a transaction helper, the repository pattern with a read-only
  view, snapshot-mode tooling for scripts that read the whole file, and one real domain to
  prove it: staff accounts.
- **Depends on.** `3fe242b` (login no longer creates or re-roles staff from the request).
- **Files / tables.** `repositories/database.mjs`, `repositories/migrations/0001_org_users.mjs`,
  `repositories/users.mjs`, `repositories/readonly.mjs`, `repositories/index.mjs`,
  `store.mjs` (server mode skips table-backed blobs; snapshot mode merges tables on load and
  writes them on save), `server.mjs` (wiring, `ctx.users`, `/capabilities.dataLayer`);
  table `org_users`.
- **Data transformation.** On first boot after the migration, `db.users` from the blob is
  imported row by row into `org_users`; the `users` blob is deleted from `collections` on
  the next save.
- **API compatibility.** None changed; readers of `db.users` keep working through the view.
- **Tests.** `scripts/testDataLayer.mjs`; the full server battery.
- **Rollback.** Restore the pre-step backup and run the previous commit (the blob still has
  `users` until the first save after the migration).
- **Known debt.** `org_users` was created before the STRICT convention and without the FK to
  `orgs` (no `orgs` table yet). S3 rebuilds it.

### S1 — Core identity schema as a verified shadow — DONE (this branch)

- **Objective.** Create the five core identity tables (`orgs`, `guardians`, `players`,
  `guardian_children`, `sessions`) with their final constraints, and keep them continuously
  populated from the blob on every save, so the target constraints are exercised against
  real data before any cutover and the reconciliation report names every row the target
  schema would refuse. Store session tokens only as hashes from the start. No cutover: the
  blob stays the source of truth and nothing reads the tables yet.
- **Depends on.** S0.
- **Files / tables.**
  `repositories/migrations/0002_core_identity_shadow.mjs` (DDL identical to the identity
  section of `docs/architecture/sql/01_identity.sql`; asserted by test),
  `repositories/shadow.mjs` (`createCoreIdentityShadow`: `project(db)`, `report(db)`),
  `repositories/index.mjs` (registers the projection with the store; `report().shadow`),
  `store.mjs` (`setProjection`, `projectionState`; the projection runs in a `SAVEPOINT`
  inside the save transaction, a failure rolls back only the savepoint and is counted),
  `server.mjs` (passes the session TTL to the data layer; `/capabilities →
  dataLayer.shadow`), `scripts/testCoreSchema.mjs`, `scripts/testSchemaDdl.mjs`,
  `scripts/dataLayerPerf.mjs`, `package.json` (`npm test` chain, `perf:data-layer`).
- **Code changes and data transformations.** On every save: `DELETE` the five tables
  children-first, then insert `orgs` → `guardians` → `players` → `guardian_children` →
  `sessions` from the in-memory collections with the mapping of `01_identity.sql`. A row
  the schema refuses (CHECK, FK, UNIQUE, STRICT type) is skipped and recorded with its
  reason; a row adjusted to fit (a dangling `guardianId` or `coGuardianOf` written as NULL)
  is recorded as a finding. Session rows carry `token_hash = sha256(token)` and
  `expires_at = created_at + TTL`; a session without a token, or an org session whose
  `userId` is not in `org_users`, is skipped and reported. `deleted_at` is written NULL.
- **API compatibility.** No route changes. `/capabilities.dataLayer` gains `shadow` with
  per-table `snapshotRows`, `tableRows`, `skipped`, `findings`, `reconciled`, up to 20
  details per table, timings and the store's failure count. No token or password appears in
  the report (asserted).
- **Tests and acceptance criteria (all met).**
  - `node scripts/testCoreSchema.mjs` → **15 checks passed**: migration creates the five
    STRICT tables, records itself once, is idempotent; a failing migration (pre-existing
    `sessions` table) rolls back atomically and leaves no record; CHECK constraints refuse
    bad org level/type/plan, a lat without lng, foot `both`, a malformed date, a bad
    availability, a wrong session kind and an org session without `org_user_id`; STRICT
    refuses a TEXT in an INTEGER column; guardian e-mail is unique case-insensitively; FK
    enforcement and cascades (guardian delete → children rows gone, `players.guardian_id`
    NULL; staff delete → sessions gone); transaction rollback leaves no partial rows;
    projection counts `{orgs 4→3 (1 refused), guardians 4→3, players 4→3, guardian_children
    3→2, sessions 8→5 (3 skipped)}` with the expected reasons and findings and exact value
    preservation; `guardian_children.role` primary/co; tokens absent from the file (no
    `token` column; lookup by hash works; `expires_at = created_at + TTL`; the plain token
    string is not found anywhere in the database dump); re-projection is deterministic;
    report content excludes secrets; the server-mode store runs the projection inside
    `save()`, the rows survive a close/reopen (restart persistence), the blob is untouched,
    and the report lists the six tables; a projection failure never blocks the blob save
    (savepoint rolled back, `failures = 1`, blob saved); snapshot-mode tools do not see
    shadow tables as collections.
  - `node scripts/testSchemaDdl.mjs` → **13 checks passed** (8 files, 320 tables): every
    DDL file executes in order with foreign keys on; all tables STRICT (except `org_users`,
    documented); every FK target exists; every table has a primary key; every index
    references an existing table; migrations 0001/0002 equal the documented DDL in columns
    and indexes.
  - `npm test` (full chain) → green: 23 trust/safeguarding, 20 identity, 16 data-layer,
    15 core-schema, 13 schema-DDL checks (87 in all). Two assertions in
    `testDataLayer.mjs` that described the old table list (`['org_users']`, one migration)
    were rewritten to describe the current one; no assertion was removed.
  - Full server battery (48 suites under `scoutbox-server/scripts/*E2E.mjs` run by the
    session's `battery.sh` against a temporary `DATA_DIR`) → **47 green; `m182E2E` has 2
    failing checks that are pre-existing** (Grassroots `desk.*` key and `orgPanels.tsx`
    client-source checks, identical on untouched `main`; they do not touch the server).
  - Smoke boot with a fresh temporary `DATA_DIR`: `/capabilities.dataLayer` reports tables
    `[guardian_children, guardians, org_users, orgs, players, sessions]`, `migrationsApplied:
    2`, shadow projection 2 ms, rows `orgs 5/5, guardians 2/2, players 14/14,
    guardian_children 3/3, sessions 1/1`, all reconciled, no failures.
  - Performance (`npm run perf:data-layer`, synthetic data, throwaway database):

    | Synthetic size | JSON | blob save alone | blob save + shadow | projection | session scan | session by hash | file |
    |---|---|---|---|---|---|---|---|
    | 1k players, 2k sessions, 50 orgs | 1.4 MB | 8.9 ms | 112.9 ms | 99 ms | 25.0 µs | 3.5 µs | 2.5 MB |
    | 10k players, 20k sessions, 500 orgs | 14.5 MB | 101.9 ms | 1171.3 ms | 1120 ms | 115.2 µs | 3.4 µs | 23.5 MB |

    Reading: the full re-projection costs about ten times the blob save at 10k players,
    because it rewrites every row on every save. That is acceptable for a shadow at demo and
    beta-test scale (the 2 s debounce absorbs it; the projection never blocks the blob
    save) and is the reason S2 onwards write **per row** from the repositories, never by
    re-projection. The shadow is removed at S4 when the last of the five tables is live.
    The point lookup by hash is 7–34× faster than the array scan and does not grow with the
    session count.
- **Rollback / recovery.** Additive: the tables are rebuilt from the blob on every save, so
  dropping them (or reverting the commit and restoring the pre-step file) loses nothing.
  `data_migrations` would still list `0002`; a revert must also delete that row or the
  previous commit boots without the migration module present and ignores the record
  (unknown ids are ignored by `runDataMigrations`), which is safe.
- **Runtime persistence changed?** No. The blob is still the source of truth and every
  reader still reads the collections; the only runtime effect is the extra work inside each
  save and the five populated tables in the file.
- **Commit boundary.** One commit: docs (`sqlite-schema.md`, `sqlite-migration-plan.md`,
  `sql/*.sql`), migration 0002, `shadow.mjs`, store/index/server wiring, the three scripts,
  `package.json`.

### S2 — Sessions cut over (hashed tokens, indexed lookup, expiry, busy timeout)

- **Objective.** Make `sessions` live: `createSession`, `sessionFor`, logout, revoke-all,
  prune and the media-URL `sid` lookup go through a sessions repository; the `sessions` blob
  is deleted. Plain tokens leave the database.
- **Depends on.** S1 (table exists, shadow report shows 0 skipped sessions on the target
  snapshot).
- **Files / tables.** `repositories/sessions.mjs` (new), `repositories/index.mjs`
  (`TABLE_BACKED += sessions`; shadow no longer projects `sessions`), `server.mjs` (lines
  639–669: `createSession`, `sessionFor`, prune; logout 669; `revokeOrgUserAccess` 4294;
  player deletion 3983; `m13` own-sid revoke 208; `m25` reviewer 150; media sid 356/4276),
  `store.mjs` (`PRAGMA busy_timeout = 5000` on open; snapshot mode reads/writes `sessions`
  through the repository's import/export like `org_users`).
- **Code changes and data transformations.** Migration `0003_sessions_live` (no DDL change;
  marks the step). First boot: the `sessions` blob is imported through the same mapping as
  the shadow (skipped rows are logged and dropped: a session without a token is unusable
  anyway; an org session without a staff row cannot authenticate after `3fe242b`), then the
  blob is deleted on the first save. `sessionFor(token)` becomes `SELECT ... WHERE token_hash
  = ?` plus the expiry comparison; the in-memory `db.sessions` view is read-only and backed
  by a cached query for the few readers that iterate (the capabilities count).
- **API compatibility.** None changed. Existing bearer tokens in clients remain valid
  (looked up by hash). `expires_at` is materialised, so expiry semantics are unchanged
  (`createdAt + TTL`).
- **Tests and acceptance.** `testSessions.mjs` (unit, temp DB): create/lookup/expire/revoke;
  no plain token in the file; restart persistence; concurrent second connection waits (busy
  timeout) instead of failing. Battery: `apiE2E`, `connectedE2E`, `m13*`, `m25*`,
  `m23*Persistence` suites unchanged. Acceptance: `/capabilities.dataLayer.domains.sessions
  .mode = 'live'`, no `sessions` row in `collections`, shadow report no longer lists
  `sessions`.
- **Rollback.** Restore the pre-S2 backup and run the S1 commit: clients' tokens still match
  the restored blob. Sessions created after S2 are lost (users log in again); nothing else
  is affected.
- **Commit boundary.** One commit.

### S3 — Organisations cut over (+ `org_users` rebuild with FK, org tombstone)

- **Objective.** `orgs` live through `repositories/orgs.mjs`; `org_users` rebuilt STRICT
  with `org_id REFERENCES orgs(id)` and `json_valid` CHECKs; sessions FK chain complete.
  Nested org facets stay in the blob record's view until their own steps (S9 tactical/squad,
  S10 verification domains, S11 agency settings) — the repository exposes the scalar
  columns and merges the still-blob facets so readers see the same shape.
- **Depends on.** S2.
- **Files / tables.** `repositories/orgs.mjs`, migration `0004_orgs_live` (import + the
  `org_users` table rebuild: create new, copy, drop, rename, inside the migration
  transaction), `server.mjs` org routes (registration 1734, settings, admin 4052, directory
  1683), `m14/review.mjs:382` (org creation), `seed.mjs` (writes through the repository on a
  production-empty boot: C.6).
- **Data transformation.** Import `orgs` scalars; refuse (abort boot with the list) any org
  the CHECKs reject — on the demo snapshot the shadow report shows zero, which is the gate.
- **API compatibility.** None changed; `playerViewForOrg` and org views keep their shapes.
- **Tests and acceptance.** `testOrgs.mjs` (unit); FK from `org_users` and `sessions`
  enforced; battery unchanged. Acceptance: `orgs` and `org_users` live, `org_users` STRICT,
  shadow projects only `guardians`, `players`, `guardian_children`.
- **Rollback.** Pre-S3 backup + S2 commit. Orgs created after S3 are lost on rollback.
- **Commit boundary.** One commit (the rebuild and the cutover belong together because the
  FK needs the parent table live).

### S4 — Guardians and players (scalars) cut over; deletion becomes a tombstone; allowlisted views

- **Objective.** `guardians`, `players` (scalar columns) and `guardian_children` live. The
  player and guardian repositories expose typed reads: by id, by guardian, the paginated
  org directory query (`country, position, availability, created_at` indexes) and the
  org-facing view **built from an allowlist of columns** (closes the blocklist weakness).
  `deletePlayerData` becomes `players.erase(id)`: tombstone (`deleted_at`, personal columns
  nulled, name replaced) plus cascade of owned rows and explicit erasure of name snapshots on
  retained audit rows, in one transaction. Guardian deletion route added (only with no live
  child). The S1 shadow is removed (every core table is live).
- **Depends on.** S3. The decision in `sqlite-schema.md` O1 (what the tombstone keeps).
- **Files / tables.** `repositories/players.mjs`, `repositories/guardians.mjs`, migration
  `0005_core_identity_live`, `server.mjs` (signup 1179/1249, guardian children 1419,
  co-guardian 1576–1590 — now refused by the unique index, aging-up 3132–3146, admin
  guardians 4219 — now a view without hashes, deletion 3978–4023, `/org/players` 1890 with
  `limit/offset` and `total` — the clients already handle `{items,total,limit,offset}`
  envelopes elsewhere, so the bare-array shape is kept for one release with a `?page=`
  opt-in; see API compatibility), `seed.mjs`.
- **Data transformation.** Import with the shadow's mapping; **zero skipped rows is the
  precondition** (the report on the target snapshot must be clean; duplicates of guardian
  e-mail are resolved by the Founder before the boot, never silently). `guardian_children`
  reconciles `childIds[]` with `players.guardianId`: `role='primary'` where they agree, `co`
  otherwise, and a finding for every disagreement.
- **API compatibility.** Shapes unchanged; `/org/players` keeps returning the array by
  default and adds pagination parameters; the org view no longer carries attendance GPS,
  notification preferences, other orgs' trial-report notes or `createdAt` — the e2e suites
  that assert their absence already exist (`PRIVACY_HARDENING`), suites that relied on the
  leak are defects to fix, not to preserve.
- **Tests and acceptance.** `testPlayers.mjs`, `testGuardians.mjs` (unit): guardian/minor
  boundaries (a minor cannot exist without a `guardian_children` row; an agency org-view of a
  minor returns nothing; a co-guardian cannot be created with a duplicate e-mail), tenant
  boundaries (an org view never joins another org's notes or assessments), erasure
  (tombstone row remains, every retained audit row still references it, every name snapshot
  is replaced, every owned row is gone, every table's `lifecycle` header statement is
  enumerated in a table-driven test that fails when a new table lacks one). Battery:
  `apiE2E`, `connectedE2E`, `m12*`, `m13*`, `m15*`, `m18*`, `m21*`, `m23*`, `m29*`.
- **Rollback.** Pre-S4 backup + S3 commit. Loses players/guardians created after S4.
- **Commit boundary.** Two commits allowed: (a) cutover + allowlist views, (b) deletion
  rewrite + guardian deletion route.

### S5 — Player sub-records

- **Objective.** The twelve `player_*` tables live (season history, badges, drills,
  attendance, timeline, media and tags, medical records, drill results, activity log,
  external ids, programme completions); `players[].trialReports` is dropped as a copy and
  served from `trial_reports` (S8) — until S8 it is served from the `trials` blob.
- **Depends on.** S4.
- **Files / tables.** `repositories/players.mjs` (sub-record methods), migration
  `0006_player_subrecords`, `server.mjs` 3347–3589 (profile sub-routes), `m12/operations.mjs`
  (media), `m16/sessions.mjs` (Box Cam clips), `m13/shared.mjs`/`imports.mjs` (external ids).
- **Data transformation.** Import each array with minted ids where the source has none
  (`player_activity_log`, `player_badges`, `player_timeline`); `media[].tags{}` to rows.
  Media files stay on disk; only metadata moves.
- **API compatibility.** Player profile shape unchanged (the repository assembles it);
  medical records join only when `medical_shared` or the viewer is the player/guardian.
- **Tests and acceptance.** Unit: medical privacy (org view with `medical_shared = 0` has no
  join; `=1` has it), cascade on erase, idempotent re-import. Battery: `m12*`, `m16*`,
  `m22*`, `preM24SweepE2E`.
- **Rollback.** Pre-S5 backup + S4 commit.
- **Commit boundary.** One commit.

### S6 — Safeguarding and audit (`blocks`, `reports`, `moderation_log`, `org_notes`, `ledger`, `ops_events`, `source_changes`, `idv_queue`, `email_challenges`, `pairing_codes`)

- **Objective.** Append-only audit tables live with `RESTRICT` references; one-time codes
  hashed with attempt limits; the ledger gets a reversal row instead of truncation on signing
  rollback (`m29/index.mjs:618`); the IDV admin toggle updates by id.
- **Depends on.** S4 (tombstone, so `RESTRICT` references can hold).
- **Files / tables.** `repositories/safety.mjs`, `repositories/audit.mjs`, migration
  `0007_safety_audit`; `server.mjs` `ledgerAppend` 595, `handleReport` 1647, blocks 1633/3751,
  notes 1982, moderation 1028, email verification 3024, pairing 3766, IDV 1332/4226;
  `m181/sourceChanges.mjs`; `m29/index.mjs:618`.
- **Data transformation.** `ledger.userId/scoutName` → `(actor_kind, actor_id,
  actor_name)` per the header rules; `type` kept open; codes hashed (upper-cased before
  hashing, as the confirm path compares).
- **API compatibility.** None changed (ledger views, reports queue, admin lift).
- **Tests and acceptance.** Unit: append-only (no `UPDATE`/`DELETE` statements exist in the
  audit repository: asserted by reading the prepared SQL), `RESTRICT` holds against a live
  player, code attempt limit, hash lookup. Battery: `apiE2E` safeguarding section, `m181*`,
  `m182E2E` server checks, `m29*`.
- **Rollback.** Pre-S6 backup + S5 commit (audit rows written after S6 lost on rollback —
  say so in the release note; this is the one step where rollback loses audit history, so it
  is cut over right after a backup and verified within the same hour).
- **Commit boundary.** One commit.

### S7 — Messaging, notifications, delivery and push

- **Objective.** `channels`, `messages`, `message_attachments`, `notifications`,
  `notification_prefs(+categories)`, `dispatches(+attempts)`, `outbox`, `push_log`,
  `push_tokens` live; `postMessage` no longer triggers a whole-database write (the
  measurable goal of this step); push tokens registered by `(audience_kind, audience_id)`
  so staff pushes work (defect 10 in the schema document).
- **Depends on.** S4.
- **Files / tables.** `repositories/messaging.mjs`, `repositories/notifications.mjs`,
  migration `0008_messaging`; `server.mjs` 809–915 (notify, openChannel, postMessage,
  broadcast 521), 3787 (push register); `adapters.mjs` (senders); `m13/delivery.mjs`;
  `m182/notificationPrefs.mjs`.
- **Data transformation.** Messages out of the channel record with a unique client key;
  coalescing keeps its 6 h window via `(audience, group_key, read, occurred_at)`.
- **API compatibility.** Channel and notification payloads unchanged; messages stay
  oldest-first (the Player app relies on `last = latest`).
- **Tests and acceptance.** Unit: idempotent send by client key, read receipts, coalescing,
  prefs mandatory categories; perf harness extended with "send 1k messages" showing no blob
  write in the path. Battery: `apiE2E` messaging, `m13Delivery*`, `m182*`, `m24F3` inbox
  live suites.
- **Rollback.** Pre-S7 backup + S6 commit (messages after S7 lost).
- **Commit boundary.** Two commits allowed: (a) channels/messages/notifications,
  (b) delivery/push/prefs.

### S8 — Recruitment core (file 02: 55 tables)

- **Objective.** Requests, trials, cases and rooms, decisions and snapshots, contacts,
  offers, signing packages, signings, follow-ups and outcome reports live; the shared
  `idempotency_keys` table replaces every `keys{}` structure; `RESTRICT` player references
  added (schema O9); `players[].trialReports` retired (served from `trial_reports`).
- **Depends on.** S5, S6 (ledger rows for signings), S7 (contacts' outbox copies).
- **Files / tables.** `repositories/recruitment/*.mjs` (one module per aggregate), migration
  `0009_recruitment`; `server.mjs` requests/trials routes (2068–2371, 2612), `m12/scouting.mjs`
  cases, `m17/rooms.mjs`, `m23/*` (contacts, trials P4B, decisions, journey), `m27`–`m29`
  (handoffs, offers, packages, signings). Largest step; sub-steps S8a requests+trials, S8b
  cases+rooms+decisions, S8c contacts+offers, S8d packages+signings+follow-ups.
- **Data transformation.** Natural keys validated before cutover (the partial unique indexes
  listed in file 02); conflicts (e.g. the open-day path creating a second pending request)
  are listed by the dry run and resolved by data fix with a written record, never by the
  migration guessing. History arrays to `*_history` with minted ids; `keys` to
  `idempotency_keys` (null keys not stored, as they are not replayable today).
- **API compatibility.** Route payloads unchanged; `rev/revAt/revBy` semantics preserved
  (a missing rev reads as 1); `409 ROOM_EXISTS` behaviour preserved (clients use it as a
  routing answer).
- **Tests and acceptance.** Unit per aggregate: uniqueness rules, idempotency replay/conflict,
  optimistic concurrency, lifecycle transitions through `applyLifecycleTransition` only,
  tombstone references. Battery: all `m12*`, `m17*`, `m23*` (E2E, Persistence, Hardening),
  `m27*`–`m29*`, `apiE2E`, `connectedE2E`.
- **Rollback.** Per sub-step backup + previous commit.
- **Commit boundary.** Four commits (S8a–S8d).

### S9 — Scouting and assessment (file 04: 33 tables)

- **Objective.** Evidence, coach affiliations (keyed by user id, not display name), squad
  invites, org tactical setups / squad / looking-for / federation checks (moved out of the
  org record), assessment templates `(id, version)` and assessments, video segments and
  playlists, vacancies, opportunities, applications, campaigns and submissions, player
  preferences (lazy insert moved into the repository read).
- **Depends on.** S5, S8 (assessments reference trials/cases by id).
- **Files / tables.** `repositories/scouting/*.mjs`, migration `0010_scouting`; `m12/passport.mjs`,
  `m12/scouting.mjs`, `m12/journeys.mjs`, `m13/suitability.mjs`, `server.mjs` 2705/2797/2913.
- **Data transformation.** Template id reuse across versions becomes the composite key;
  tactical re-save diffs roles by id (so vacancies keep `role_id`); cross-org role id
  collisions re-minted with a finding.
- **Tests and acceptance.** Unit: assessment ratings PK, template version immutability,
  squad four-shape union, `player_prefs` upsert on read. Battery: `m12*`, `m13Suitability*`,
  `m15*`, `m18*`.
- **Rollback.** Backup + S8 commit.
- **Commit boundary.** Two commits (evidence/affiliations/org facets; assessments/opportunities/campaigns/prefs).

### S10 — Verification and passport (file 05: 31 tables)

- **Objective.** Claims, events, evidence, tokens, admins, root requests, disputes,
  references, invites, conflicts, domains; passport prefs/career/achievements/shares/
  corrections; transition cases; legacy representations; vouches (hashed code). The
  `orgs.verified` boolean becomes derived from claims.
- **Depends on.** S4, S9 (passport reads evidence/assessments).
- **Files / tables.** `repositories/verification/*.mjs`, `repositories/passport.mjs`,
  migration `0011_verification_passport`; `m14/*`, `m15/*`, `m13/transitions.mjs`,
  `server.mjs` vouches 3689/4073.
- **Data transformation.** `verMigrated` object → `ver_migrations` rows; claim `metadata`
  promoted keys to columns; raw passport dates kept raw.
- **Tests and acceptance.** Unit: one PERSON_IDENTITY per user, one current affiliation
  pair, self-verification refused, token hash lookup and single use, share expiry. Battery:
  `m14*`, `m15*`, `m13Transition*`, `m162*`.
- **Rollback.** Backup + S9 commit.
- **Commit boundary.** Two commits (verification; passport/transition/vouches).

### S11 — Agent, compliance and transactions (file 06: 61 tables)

- **Objective.** Agent profiles and facets, affiliations, representation agreements and
  shares, reviewers (hashed secret), jurisdiction policies, regulatory reviews and consents,
  compliance contexts and evaluations, agent transactions, representations, documents;
  `orgs.agencySettings` → `org_agency_settings`; the `req.org.settings.jurisdictions` defect
  fixed in the same step.
- **Depends on.** S8 (handoffs, offers), S10 (verification evidence refs).
- **Files / tables.** `repositories/agent/*.mjs`, migration `0012_agent_compliance`;
  `m24/*`–`m26/*`, `m27/*`.
- **Tests and acceptance.** Unit: effective-status uniqueness in code with the partial
  indexes where stored; dual-control publication; consent revocation 1:1; minors refused on
  agreements. Battery: `m23Agent*`, `m24*`–`m27*`.
- **Rollback.** Backup + S10 commit.
- **Commit boundary.** Three commits (profiles/affiliations/agreements; policies/reviews/consents/contexts; transactions/representations/documents).

### S12 — Development, Box Cam, Combine and discovery (file 07: 57 tables)

- **Objective.** Development objectives and plans, drill guidance, Box Cam prefs/challenges/
  entries/assignments/sessions/disputes/integrity events, Combine requests/attempts, CV
  results, briefs, Nobody Missed, Second Look (engine key enforced; integrity check
  updated), watchlists and membership events, exposure, review-later, suggestions,
  calibration, fixtures, coverage. Reads that write (Second Look and watchlist reconcile,
  evidence suggestions) become explicit repository upserts.
- **Depends on.** S5, S8, S9.
- **Files / tables.** `repositories/development/*.mjs`, `repositories/boxcam/*.mjs`,
  `repositories/discovery/*.mjs`, migration `0013_development_discovery`; `m12/journeys.mjs`,
  `m13/insight.mjs`, `m13/planning.mjs`, `m16/*`, `m18/*`, `m19/*`, `m21/*`, `m22/*`.
- **Data transformation.** `box_sessions.obs_json` retained (normalisation deferred to a
  later, separate step once the observation stream's reader is a repository); `nonce` hashed;
  `coverage_assignments.fixture_id` prefix split into `(fixture_kind, fixture_id)`.
- **Tests and acceptance.** Unit: consent gate (`box_cam_prefs.share_development_activity`),
  one entry per challenge/player, watchlist fingerprint uniqueness, Second Look key. Battery:
  `m16*`, `m18*`, `m19*`, `m21*`, `m22*`, `m13Insight*`, `m13Planning*`.
- **Rollback.** Backup + S11 commit.
- **Commit boundary.** Three commits (development; Box Cam/Combine/CV; discovery/planning).

### S13 — Operations and integrations (file 08: 44 tables); secrets to env; backups; production init

- **Objective.** API keys, webhooks, invites (hashed), SSO configs/states (hashed), support,
  imports/prospects/identity reviews, groups and grants, upload sessions, saved searches,
  open trials, matchdays, friendlies, invoices (minor units), plan/archetype catalogues,
  reputation seed (demo only), callback ids, `ops_settings`. `secrets.mediaSign` leaves the
  database (`MEDIA_SECRET` required in production, registered in `m181/capabilities.mjs`).
  Admin backup becomes `VACUUM INTO` of the file plus media; restore stays "new empty
  DATA_DIR". Production boot with an empty file creates **no demo rows** (C.6).
- **Depends on.** S3 (orgs), S8 (invoices reference signings).
- **Files / tables.** `repositories/operations/*.mjs`, migration `0014_operations`;
  `m13/imports.mjs`, `m13/enterprise.mjs` (backup 428–484), `m13/groups.mjs`,
  `m12/operations.mjs`, `adapters.mjs` (billing), `seed.mjs`, `catalogue.mjs`,
  `m181/capabilities.mjs`, `OPERATIONS.md`.
- **Tests and acceptance.** Unit: hashed invite/state lookups, API key scope check,
  `amount_minor` conversion exactness, backup/restore round trip on a temp directory with
  row counts equal per table, production-empty boot creates only catalogue rows. Battery:
  `m13Imports*`, `m13Enterprise*`, `m13Groups*`, `apiE2E` grassroots sections,
  `m23BootContract*`.
- **Rollback.** Backup + S12 commit.
- **Commit boundary.** Three commits (integrations; ops/support/imports/groups; catalogues/backups/production init).

### S14 — Retire the blob store

- **Objective.** `collections` holds nothing; `meta.idCounter` moves to a `counters` table;
  `db.schema` is replaced by `data_migrations`; `store.mjs` snapshot mode becomes the
  backup/restore tool over tables; `m182/migrations.mjs` steps become no-ops guarded by a
  version floor (a snapshot older than S0 is migrated by booting the last pre-S14 release
  first, documented in `OPERATIONS.md`); `mediaBlobs`, `boxSessionEvents` and the
  `NOT_A_STORE` names are removed from `storeContract.mjs`; the `db.x ??= []` normalisation
  block and every `migrateMxx` collection line are deleted; `CLAUDE.md`'s "migrated so far"
  list says "all".
- **Depends on.** S2–S13.
- **Tests and acceptance.** `storeContract` test asserts zero blob collections; the full
  battery; the persistence suites read tables through the repositories' export.
- **Rollback.** Backup + S13 commit.
- **Commit boundary.** One commit.

---

## C. Cross-cutting work

### C.1 Repository and data-access layer

- One module per aggregate under `scoutbox-server/repositories/<domain>/`, exporting
  `create<Name>Repository({ sqlite, nextId, log })` with: prepared statements built once;
  typed reads that take the caller's scope (`orgId`, `playerId`, viewer kind) as parameters;
  writes that run inside `transaction(sqlite, fn)` and return the row as the API shape;
  `importLegacy(rows)` (idempotent: `INSERT OR IGNORE` by id, with a findings list) and
  `exportRows()` for tools; a `view` (`repositories/readonly.mjs`) for the transition period.
- Routes keep their signatures; the service function the route calls moves from mutating
  `db.<collection>` to calling the repository. `m12`–`m29` code moves to
  `domains/<domain>/` as each domain is migrated (CLAUDE.md rule), not before.
- Row-to-API mapping is an explicit allowlist in the repository (never a spread of the row).

### C.2 Source of truth during migration, dual read/write, failure and reconciliation

- Per domain, exactly one of three states, recorded in `/capabilities.dataLayer.domains`:
  `blob` (untouched), `shadow` (blob authoritative; tables rewritten in the save transaction;
  report compares), `live` (tables authoritative; blob deleted; view read-only).
- There is **no dual write by application code**: in `shadow` the projection is derived
  from the blob inside the same transaction, so the two cannot diverge on commit; in `live`
  the blob no longer exists. A projection failure is counted and rolled back in its savepoint
  and the blob save still commits (S1 test "projection failure never blocks the blob save").
- Reconciliation is the shadow report (`snapshotRows` vs `tableRows`, `skipped` with
  reasons, `findings`, `reconciled` boolean per table) and, at cutover, the import's findings
  list, which the boot prints and stores in `ops_events` (`kind: 'data_import'`).

### C.3 Backups and dry runs on disposable copies

- Before every cutover boot: `POST /admin/backup` (today's copy of the file and media;
  from S13 `VACUUM INTO`). The operator then runs the dry run:
  `node scripts/dataLayerDryRun.mjs <backup-dir>` (added at S2; it copies the backup to a
  temporary directory, boots the data layer in import mode without the HTTP server, and
  prints per-table row counts, skipped rows with reasons, findings and timings, then deletes
  the copy). A cutover is attempted only when the dry run on the latest backup reports zero
  skipped rows for the domain.
- Never restore over a live directory; the restore procedure stays "new empty `DATA_DIR`"
  (`m13/enterprise.mjs:455`).

### C.4 Legacy snapshots and JSON imports

- `store.mjs` snapshot mode continues to read `data/db.json` (legacy JSON) and the
  `collections` table, merging table-backed collections (`readTableBacked`), so a legacy
  snapshot can be booted at any step: the snapshot migrations shape it, then the table
  migrations import what is now live. Each step's `importLegacy` is idempotent, so booting a
  snapshot that already contains the live tables does not duplicate rows.
- Backups from before a step are restorable by the release of that step or any later one
  (forward-only); the plan has no backward conversion.

### C.5 Determinism, ids, duplicates, orphans, field-level reconciliation, row counts

- Imports are deterministic: rows are read in array order, ids are preserved, and minted ids
  for id-less rows are taken from the global counter in a fixed order, so two dry runs of
  the same snapshot produce identical tables (asserted at S1 for the shadow; each step's
  test repeats it).
- Duplicates (same id twice in a blob, the same guardian e-mail with different case, a
  second pending request) are **refused and listed**, never merged by the migration; the
  operator fixes data with a recorded admin action and re-runs the dry run.
- Orphans (a `guardianId` with no guardian, a `caseId` with no case) are handled as each
  header says: `SET NULL` with a finding where the code tolerates it, skipped with a reason
  where the row is meaningless without its parent, kept as a tombstone id where the table is
  an audit record.
- Field-level reconciliation: the shadow and every import compare the stored row with the
  source object field by field for the first N rows (N = 20 in the report) and count
  mismatches; the S1 test asserts exact preservation of every scalar on a sample.
- Row-count checks: `snapshotRows == tableRows + skipped` per table, asserted in tests and
  shown in the report.

### C.6 Crash recovery, restart persistence, rollback; production init vs demo seeding

- Every migration runs in one transaction; a crash mid-migration leaves the file at the
  previous version (SQLite atomic commit; WAL). The boot refuses to continue on a failed
  migration and prints the reason. Restart persistence is asserted by closing and reopening
  the file in tests (S1 does this for the shadow).
- Rollback = restore the pre-step backup and run the previous commit; what is lost is stated
  per step above. Rollback after a step that hashed secrets cannot un-hash them: clients are
  unaffected because they hold the plain token, and restored blobs still hold the old plain
  values.
- Production init (S13): with `NODE_ENV=production` and an empty file, the boot creates the
  catalogue rows (`plans`, `archetypes`, `drill_guidance`, the two ScoutBox Box Cam
  challenges) and nothing else; demo organisations, players, guardians, staff, sessions and
  the reputation seed are created only by `seed.mjs` when `SCOUTBOX_SEED_DEMO=1` (dev and
  test default), registered as a capability and refused in production. Until S13 the
  current behaviour (seed on fresh boot) stands and is documented as such.

### C.7 Performance measurement with synthetic data

- `scripts/dataLayerPerf.mjs` builds synthetic snapshots in the server's own shapes (no
  real data) and reports, per size: blob save, save with projection, projection alone, and
  point lookups by scan vs index. Each step adds its domain's hot path to the harness (S2
  session lookup under load; S4 the paginated directory query at 10k/100k players; S7
  message send without a blob write; S8 room list with filters) and records the numbers in
  this document's step section. Targets: no request path writes the whole database after
  its domain is live; p50 of the hot query at 100k players under 5 ms on the CI machine.

### C.8 Existing tests that exercise persistence, restart and rollback (reused as the specification)

`scripts/m23*Persistence.mjs` (offer, trial, signing, journey persistence across restarts),
`m23RecruitmentJourneyHardeningE2E.mjs` (restart mid-mutation, corrupt pointers, rollback
audit), `m23BootContract*` (store contract, boot order), `m182E2E.mjs` (integrity report),
`connectedE2E.mjs` (fresh boot, login, crash survivor), `apiE2E.mjs` (130 checks across
every domain), and the unit chain in `npm test`. They are run unchanged at every step; an
assertion that only describes the old storage (e.g. "the `users` blob contains…") is
rewritten to describe the table and the rewrite is called out in the step's commit message.

### C.9 What this plan is not

It is not a rewrite of the five apps, the move to TypeScript, the shared types package, or
the merge of Club and Grassroots. Those depend on this plan (the server's row-to-API
allowlists are the natural source for shared types) and are sequenced after S14 in
`CLAUDE.md`'s architecture rules. The milestone directories are moved to domain directories
only as each domain migrates (C.1), so no step requires a big-bang reorganisation.
