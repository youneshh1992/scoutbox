# ScoutBox migration plan: from the JSON snapshot to relational SQLite

Companion to [`sqlite-schema.md`](./sqlite-schema.md) (the target schema) and the DDL in
`docs/architecture/sql/`. Written 10 October 2026 on branch `feat/sqlite-schema`.

Status of the steps (corrected 12 October 2026): **S0 done** (commit `0f01df7`), **S1 done**
(`ef71f28` + corrections `d0d96e6`, `22ce9ad`, `abc0f6a`; §S1 records the commands and results),
**S2 done** (`6dca457` + corrections `8baafde`, `5a9e75d`; §S2 records the commands and
results), **S3 done** (§S3 records the field ownership, the commands and the results), **S4a
implemented and review-accepted at `480afdb`** (the player/guardian storage cutover with today's
deletion behaviour unchanged, its reviewed corrections and safeguards; §S4 records the six
bounded parts; the acceptance is a bounded code-review conclusion, not production readiness),
**S4b not implemented** (the deletion rewrite; O1 is **partially resolved** on 12 October 2026 —
the Founder chose the full birth date for the retained record, and kept the country-code and
child-status-stamp questions open: [`s4-deletion-decision.md`](./s4-deletion-decision.md) §10;
nothing of S4b is built and today's hard delete is unchanged), **S5 implemented and
review-accepted at `2178c5b`** (the twelve `player_*` tables and `0007_player_subrecords`, one
correction round; its evidence-based note is
[`s5-player-subrecords.md`](./s5-player-subrecords.md) and its status block is in §S5; the
acceptance is a bounded code-review conclusion, not a production-deployment authorization),
**S6a implemented and independently accepted at `2d7ddeb` within the reviewed backend development
scope** (the one-time-code tables `email_challenges` and `pairing_codes`, migration
`0008_one_time_codes`, its copy-only rollback, after three review rounds; the acceptance is a
bounded code-review conclusion on the packaged server source — not production or deployment
approval, and the Player app was not part of it;
[`s6-readiness-review.md`](./s6-readiness-review.md) §10 records what was built, verified and
accepted), **the rest of S6 not started** (the eight audit tables; they wait for S4b, review §4.1),
**S7a independently accepted at `0641b2c600cd1f082436b4b24dbb052b98ee00d7`** (15 October 2026; a
bounded code-review conclusion on the packaged source — both reviewer scripts, the backend and
Player gates and the pre-S7a rollback boot verified by the reviewer on real Node v24.19.0 — not
production or deployment approval; the notification tables, migration `0009_notifications`, its
copy-only rollback; [`s7-readiness-review.md`](./s7-readiness-review.md) §8.3 records what was
built, §8.4–§8.5 the two correction rounds as dated history, §8.6 the acceptance and its limits:
no exactly-once external delivery, the explicit raw-transaction `reload()`, hook registration as the
caller's responsibility; the Player app was not touched), **S7b implemented, pending independent
acceptance — not accepted** (15 October 2026, on top of `dc4b559`: `dispatches` and `dispatch_attempts`
as tables, migration **`0010_dispatches`**, its copy-only rollback; review §9 as corrected by the
independent review of `dc4b559` and §9.7 the implementation record; no deployment authorised),
**S7c–S7d not started** (their blockers are stated in the review and in §S7)
— S8–S14 planned. The evidence-based plan of S4 is
[`s4-readiness-review.md`](./s4-readiness-review.md).
Migration numbering: `0006` is `0006_media_deletions` (S4a); S5 took **`0007_player_subrecords`**;
S6a took the next unused identifier, **`0008_one_time_codes`** (the plan's placeholder
`0008_safety_audit` is withdrawn); S7a took **`0009_notifications`**; S7b took **`0010_dispatches`**
(the plan's `0010_recruitment` placeholder for S8a moves to the next free number when S8a is
approved). The later steps' identifiers
in §B are placeholders, assigned from the actual order in which steps are approved and built.
Existing migration ids never change.

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

### S1 — Core identity schema as a verified shadow — DONE (`ef71f28`, corrected by the S1 acceptance follow-up commit)

- **Objective.** Create the five core identity tables (`orgs`, `guardians`, `players`,
  `guardian_children`, `sessions`) with their final constraints, plus a *projection* that
  fills them from the blob so the target constraints can be exercised against real data
  before any cutover, with a reconciliation report that names every row the target schema
  would refuse. Store session tokens only as hashes from the start. No cutover: the blob
  stays the source of truth and nothing reads the tables.
- **Depends on.** S0.
- **Files / tables.**
  `repositories/migrations/0002_core_identity_shadow.mjs` (DDL identical to the identity
  section of `docs/architecture/sql/01_identity.sql`; asserted by test),
  `repositories/shadow.mjs` (`createCoreIdentityShadow`: `project(db, { savedAt })`,
  `report(db, { enabled, details })`, `SHADOW_STATUS`),
  `repositories/index.mjs` (`attachDataLayer({ shadowValidation })`; registers the
  projection with the store only when asked; `report({ details })`),
  `store.mjs` (`setProjection`, `projectionState`; a registered projection runs in a
  `SAVEPOINT` inside the save transaction, a failure rolls back only the savepoint and is
  counted; with none registered the save is the S0 path),
  `server.mjs` (`SCOUTBOX_SHADOW_VALIDATION=1` → `shadowValidation`; public
  `/capabilities → dataLayer.shadow` with counts and statuses; `GET /admin/data-layer`
  with row-level detail behind the admin key), `m181/capabilities.mjs`
  (`shadow_validation` state), `scripts/validateShadow.mjs` (isolated validation on a
  copy), `scripts/testCoreSchema.mjs`, `scripts/testSchemaDdl.mjs`,
  `scripts/dataLayerPerf.mjs`, `package.json` (`npm test` chain, `perf:data-layer`,
  `validate:shadow`), `OPERATIONS.md`.
- **What the acceptance review found and corrected.** As committed in `ef71f28` the
  projection was registered unconditionally, so *every* save (including the `persistNow()`
  after each chat message and the debounced save after every other write) rewrote the five
  tables: a storage-layer cost of about ten times the blob save at 10k players, on by
  default, with no way to turn it off. The public `/capabilities` report also carried the
  ids of refused rows, the refusal reasons and the last error text to unauthenticated
  callers, and reported `reconciled: true` per table whenever the counts matched, without
  saying whether the rows were current. The follow-up commit makes the projection opt-in
  (off by default), persists the freshness of the last projection in the file, reports
  `never / stale / failed / partial / complete` with `reconciled` true only for `complete`,
  limits the public report to counts and statuses, moves ids, reasons and error text to
  the admin route, and adds the isolated validation command. The statement "runtime
  persistence unchanged" in the first report was wrong for `ef71f28` and is true only after
  the correction: the blob was always the source of truth, but the save path did more work.
- **Code changes and data transformations.** When validation is on, each save: `DELETE`
  the five tables children-first, then insert `orgs` → `guardians` → `players` →
  `guardian_children` → `sessions` from the in-memory collections with the mapping of
  `01_identity.sql`, then record `shadowProjectedAt = savedAt` and a counts-only summary in
  `meta` (same savepoint, so a rolled-back projection leaves the previous summary). A row
  the schema refuses (CHECK, FK, UNIQUE, STRICT type) is skipped and recorded with its
  reason; a row adjusted to fit (a dangling `guardianId` or `coGuardianOf` written as NULL)
  is recorded as a finding. Session rows carry `token_hash = sha256(token)` and
  `expires_at = created_at + TTL`; a session without a token, or an org session whose
  `userId` is not in `org_users`, is skipped and reported. `deleted_at` is written NULL.
  Row ids and reasons live in memory only (admin report, validation command); the file
  holds counts.
- **Normal runtime behaviour (default, validation off).** A save is exactly the S0 save:
  blob upserts, meta, commit; no savepoint, no shadow statement (asserted by a test that
  records every SQL statement the store executes). The five tables keep whatever the last
  projection wrote, if any, and the report labels those rows `never` or `stale`, never
  reconciled. `org_users` (S0, live) is unaffected either way.
- **Second correction (handoff review of `d0d96e6`).** Three gaps were reproduced by an
  independent review and fixed in the follow-up commit, each with a regression test
  written to fail first: (1) a player whose `guardianId` named no guardian was written with
  `guardian_id = NULL` and a finding, but with no refused row the report still said
  `complete` / `reconciled: true`; findings now keep the result `partial`, the report
  carries `skipped` and `findings` totals, and the "clean" fixture was corrected (it had two
  dangling relationships). (2) Guardians were inserted in array order with their
  `co_guardian_of` link, so a co-guardian listed before their primary was refused by the
  foreign key; guardians are now inserted in two passes (rows without links, then links
  once both ends exist), valid links are kept in any order, a target missing from the
  snapshot or itself refused is an explicit finding, foreign keys stay on. (3) Freshness was
  keyed on the `savedAt` timestamp, so a later save with the same `savedAt` (which the
  persistence suites do) left stale shadow rows reported as `complete`; the store now
  advances a persisted save revision `meta.saveSeq` on every save in every mode, the
  projection records the revision it ran in, and `current` means equal revisions. Restart,
  failed projection (summary and revision not written, so stale) and saves while the
  projection is off are all covered by tests.
- **How to validate.** Either boot with `SCOUTBOX_SHADOW_VALIDATION=1` for a controlled
  run (the switch is reported under `capabilities.shadow_validation`), or run
  `node scripts/validateShadow.mjs <data-dir>` against a backup or a copy: it opens the
  source read-only, copies it with `VACUUM INTO`, projects on the copy, prints every
  refused row and adjusted relationship, and deletes the copy. The source file is
  byte-identical afterwards (asserted by test). Without flags the command is
  informational (exit 0 for `complete` or `partial`, 2 if the projection threw); with
  `--strict` it is the readiness gate: exit 3 unless `complete`. Every cutover step's
  "Depends on" uses the strict form.
- **API compatibility.** No route changes to the product API. `/capabilities.dataLayer`
  gains `shadow` (`enabled`, `status`, `reconciled`, timestamps, per-table `snapshotRows`,
  `tableRows`, `projectedRows`, `skipped`, `findings`, `accountedFor`) and the store's
  `enabled / failures / lastErrorAt`; `capabilities.shadow_validation` names the switch.
  `GET /admin/data-layer` (admin key) adds `details` per table and `lastError`. No token,
  password hash or one-time code appears in either (asserted).
- **Tests and acceptance criteria (all met after the correction).**
  - `node scripts/testCoreSchema.mjs` → **21 checks passed** (18 from the first correction
    plus the three regression tests of the second: findings never complete; guardian order
    independence with valid links kept and missing or refused targets as findings; revision
    freshness with same-`savedAt` save, restart and failed projection): migration creates the five
    STRICT tables, records itself once, is idempotent; a failing migration rolls back
    atomically and leaves no record; CHECK constraints refuse bad org level/type/plan, a
    lat without lng, foot `both`, a malformed date, a bad availability, a wrong session kind
    and an org session without `org_user_id`; STRICT refuses a TEXT in an INTEGER column;
    guardian e-mail is unique case-insensitively; FK enforcement and cascades; transaction
    rollback leaves no partial rows; projection counts `{orgs 4→3 (1 refused), guardians
    4→3, players 4→3, guardian_children 3→2, sessions 8→5 (3 skipped)}` with the expected
    reasons and findings and exact value preservation; `guardian_children.role`
    primary/co; tokens absent from the file and from every report; re-projection is
    deterministic (no duplicates, removed rows gone, changed fields current); the report
    distinguishes `partial` (refused rows, `accountedFor` true per table) from `complete`
    (a clean snapshot), `stale` (a save after the projection) and `failed` (a thrown
    projection, with the error text only in the detailed report); **default
    `attachDataLayer` registers no projection, three saves execute no `SAVEPOINT` and leave
    all five tables empty, the blob is saved as before, the report says `never`**; with
    `shadowValidation: true` the tables are rewritten in every save, survive a restart with
    the status read from the file, and go `stale` after a save with validation off; a
    projection failure never blocks the blob save and records no summary; snapshot-mode
    tools do not see shadow tables; `validateShadow.mjs` reports every refused row and
    leaves the source database byte-identical with no shadow rows in it.
  - `node scripts/testSchemaDdl.mjs` → **13 checks passed** (8 files, 320 tables).
  - `npm test` (full chain) → green: 23 trust/safeguarding, 20 identity, 16 data-layer,
    21 core-schema, 13 schema-DDL checks (93 in all). The two `testDataLayer.mjs`
    assertions rewritten in `ef71f28` still pin exact values: the schema report must equal
    the exact table list and the migration count must equal the registry length, and the
    attached layer's report must list exactly those tables and show the shadow `enabled:
    false`, `status: 'never'`; a missing or extra table fails them.
  - Full server battery (48 suites, `battery.sh`, temporary `DATA_DIR`): see the
    acceptance follow-up commit message for the run after the correction. The 2 failing
    checks in `m182E2E` are pre-existing: `✗ [neg] scoutbox-grassroots: no screen asks for
    a key that does not exist: desk.all, …` and `✗ orgPanels.tsx is byte-identical in club
    and grassroots`; the same suite run on a detached worktree of `66c095c` (the review's
    baseline, before S0 and S1) fails exactly those two with 418 passed and exit 1.
  - Smoke boot on a temporary `DATA_DIR`, default: `capabilities.shadow_validation:
    disabled`, `shadow.enabled: false`, `status: never`, `reconciled: false`, tables empty,
    no `details` and no error text in the public body; `GET /admin/data-layer` without the
    key → `ADMIN_KEY_REQUIRED`. With `SCOUTBOX_SHADOW_VALIDATION=1` and one write:
    `enabled: true`, `status: complete`, `reconciled: true`, `snapshotSavedAt ==
    lastProjectionSavedAt`, projection 2 ms, `orgs 5/5, guardians 2/2, players 14/14,
    guardian_children 3/3, sessions 1/1`.
  - Performance (`npm run perf:data-layer`, synthetic data in the server's shapes,
    throwaway database, medians of 5 saves; storage-layer timings only, not request
    latency):

    | Synthetic size | JSON | normal save (validation off, default) | save with validation on | projection alone (validation command) | session scan | session by hash | file |
    |---|---|---|---|---|---|---|---|
    | 1k players, 2k sessions, 50 orgs | 1.4 MB | 8.8 ms | 112.3 ms | 101 ms | 25.0 µs | 3.3 µs | 2.5 MB |
    | 10k players, 20k sessions, 500 orgs | 14.5 MB | 112.2 ms | 1225.7 ms | 969 ms | 261.8 µs | 3.4 µs | 23.5 MB |

    The "normal save" column is the same code path as S0 (and as `ef71f28` with the
    projection removed), so it is also the "existing save" baseline. Limitations: one
    machine, synthetic rows of uniform shape, no concurrent requests, no media; the numbers
    bound the storage cost of the switch and nothing else.
- **Rollback / recovery.** Additive: the tables are rebuilt from the blob whenever the
  projection runs, so dropping them (or reverting the commits and restoring the pre-step
  file) loses nothing. `data_migrations` would still list `0002`; the previous commit boots
  without the migration module present and ignores the record (unknown ids are ignored by
  `runDataMigrations`), which is safe.
- **Runtime persistence changed?** After the correction: no by default. The blob is the
  source of truth, every reader reads the collections, and a default save executes the same
  statements as S0. With `SCOUTBOX_SHADOW_VALIDATION=1` each save additionally rewrites the
  five tables inside its own savepoint. In `ef71f28` alone the answer was "yes, every save
  did the extra work"; that commit must not be deployed without the follow-up.
- **Commit boundary.** `ef71f28` (docs, DDL, migration 0002, shadow, wiring, tests, perf
  harness) plus one focused follow-up commit (opt-in switch, persisted freshness, report
  statuses and exposure, admin route, validation command, tests, documentation).

### S2 — Sessions cut over (hashed tokens, indexed lookup, expiry, busy timeout) — DONE

- **Objective (met).** `sessions` is live: `createSession`, `sessionFor`, logout, the
  event-stream ticket, signed media links, staff revocation, player deletion, own-session
  listing and revocation (`m13`) and the reviewer lane (`m25`) go through
  `repositories/sessions.mjs`; the `sessions` blob is validated, imported with hashed
  tokens and retired in the one transaction that records the cutover. No readable bearer
  token exists in any active table, blob, view, log, report or export afterwards.
- **Depends on.** S1 as corrected (`abc0f6a`). The S1 strict validation
  (`validateShadow.mjs --strict`) no longer covers `sessions` (the shadow projects the four
  identity tables only; live sessions are never written or deleted by any shadow path, even
  with `SCOUTBOX_SHADOW_VALIDATION=1`, asserted by test). **Readiness gate for S2 itself:**
  the cutover migration *is* the validation. Run it on a copy first: copy the data directory,
  point the S2 build at the copy (`DATA_DIR=<copy> node server.mjs`) and read the boot log.
  It either cuts the copy over (ready) or refuses with `SESSIONS_CUTOVER_BLOCKED` and the
  list of `sid`s and reasons (not ready). The real directory is not touched by that run.
- **Files / tables.** `repositories/sessions.mjs` (new: row validation, repository, the
  `db.sessions` read-only view backed by the table, `SESSIONS_TABLE` import/export for
  snapshot tools), `repositories/migrations/0003_sessions_live.mjs` (new: the cutover),
  `repositories/sessionsRollback.mjs` + `scripts/sessionsRollback.mjs` (new: rollback on a
  copy), `repositories/index.mjs` (`TABLES += SESSIONS_TABLE`, migrations `0001–0003`, the
  repository attached at boot, `domains.sessions` in the report), `repositories/shadow.mjs`
  (`sessions` removed from `CORE_SHADOW_TABLES`, its inserts, delete order and projection),
  `repositories/users.mjs` (`USERS_TABLE.replace` upserts and deletes only ids absent from the
  snapshot, so a backup/restore of the `users` collection cannot cascade-delete valid
  sessions; `attach` tells a superseded blob from a stale one), `repositories/database.mjs`
  (migration context, `meta` owned by the runner, `migrations` ids in the report),
  `store.mjs` (`PRAGMA busy_timeout = 5000`), `server.mjs` (session block, `/events`,
  `/auth/logout`, `deletePlayerData`, admin overview count, media `sid` lookup,
  `revokeOrgUserAccess`, module wiring), `m13/enterprise.mjs` (`/org/sessions`,
  `/org/sessions/revoke`), `m25/index.mjs` (reviewer logout and revocation),
  `scripts/testSessions.mjs` (new), `scripts/testCoreSchema.mjs`, `scripts/testDataLayer.mjs`,
  `scripts/testSchemaDdl.mjs`, `scripts/dataLayerPerf.mjs`, `scripts/preM24SweepE2E.mjs`
  (planted sessions found by hash), `package.json` (test chain), `OPERATIONS.md`,
  `CLAUDE.md`, `sqlite-schema.md` §5.0.
- **Validation and abort behaviour for unsupported records (as built).** A legacy row is
  *supported* when it has exactly the known fields, a non-empty string `token`, a `kind` in
  `player | guardian | org | ts_reviewer`, a non-empty string `refId`, a positive integer
  `createdAt`, `via` absent or `sso`, `sid` absent or a string (absent → derived from the
  hash, counted in `meta.sessionsCutover.sidsDerived`), and for `kind = 'org'` a `userId`
  naming a row of `org_users`; a non-org row must not carry `userId`. Nothing is coerced.
  Duplicate tokens and duplicate `sid`s are unsupported too. The migration re-validates every
  row inside its transaction and, if any is unsupported, **aborts**: the transaction rolls
  back, the boot refuses with `SESSIONS_CUTOVER_BLOCKED: N unsupported session(s) … — sid X:
  reason; …` (never a token), the file is byte-identical, the blob stays the source of truth
  and the next boot aborts the same way. There is no flag that drops rows and no automated
  repair or revocation of real sessions. The earlier plan's `POST
  /admin/sessions/revoke-unsupported` was **not** built: an unsupported row cannot
  authenticate (no token, or an org session without a staff row), so removing it changes
  nothing a user can observe, and the decision to remove it belongs to the operator. The
  procedure is in `OPERATIONS.md` ("S2 cutover"): dry-run on a copy, resolve each listed `sid`
  on the pre-S2 build with the server stopped, re-run the dry run, then boot.
- **Legacy upgrade.** A pre-S0 file (staff still in the `users` blob, `org_users` empty) cuts
  over in one boot: the migration imports the `users` blob into `org_users` first (same row
  rule as S0's import), retires that blob, then validates and imports sessions, all in the
  one transaction. A session naming a staff id found in neither place still aborts.
- **Atomic cutover and completion record (as built).** `0003_sessions_live.up(sqlite, {
  sessionTtlMs, now })`, inside the one transaction `runDataMigrations` opens: read the
  `sessions` blob straight from `collections` (JSON and array checks); import the `users`
  blob if `org_users` is empty; validate every row (abort as above); `DELETE FROM sessions`
  (the S1 shadow's derived rows, if any); insert one row per session with `token_hash =
  sha256(token)` and `expires_at = created_at + TTL`; write `meta.sessionsCutover` (`at`,
  `imported`, `sidsDerived`, `blobPresent`) and `meta.sessionTtlMs`; `DELETE FROM collections
  WHERE name = 'sessions'`. The runner then inserts the `data_migrations` row
  `0003_sessions_live` and commits. Completion is decided **only** by that row: the
  repository's `attach()` throws without it, whatever the table holds. An empty blob, a
  missing blob (first installation) and a stale populated shadow all cut over to a complete,
  correct table; row counts are reported, never used to infer state. A failure injected after
  the import but before the commit leaves no trace and the next boot cuts over cleanly
  (tested). No proposed table is referenced: the migration touches `sessions`, `org_users`,
  `collections`, `meta` and `data_migrations`, all of which exist.
- **Expiry and lifetime.** A session is live while `now - created_at < TTL` with the TTL
  configured now (`SESSION_TTL_DAYS`, default 30), exactly the pre-S2 rule, tested at the
  boundary (`TTL - 1 ms` live, `TTL` dead) and with a non-default lifetime. `expires_at` is
  materialised for the index and recomputed for every stored row at boot when the configured
  lifetime differs from `meta.sessionTtlMs` (logged). So **changing `SESSION_TTL_DAYS` applies
  to existing sessions immediately**, shortening or extending them, as it always did; it is
  not a per-session property. `prune` deletes by the same rule.
- **Snapshot import/export.** Tools that open the file as one snapshot (`openStore(dir)`
  without options: backups, restores, fixtures) see `db.sessions` as rows carrying `tokenHash`
  and never `token`; `save` writes them back by hash. A fixture row that carries a plain
  `token` and no hash is hashed on write (so tests can plant sessions); a row the table
  cannot represent is skipped and counted in the warning, never silently dropped. Writing the
  `users` collection back upserts staff rows and deletes only ids absent from the snapshot,
  so the `sessions.org_user_id` cascade cannot destroy valid sessions on a restore; a staff
  member genuinely gone from the snapshot still takes their sessions with them (tested).
- **Concurrency.** `PRAGMA busy_timeout = 5000` on every connection the store opens. Tested
  with a second *process* holding a write transaction: the save waits and succeeds; the same
  situation without the pragma fails at once with `SQLITE_BUSY`.
- **Code changes.** `sessionFor` → `sessions.byToken` (`WHERE token_hash = ?` plus the
  liveness rule); `createSession` → `sessions.create` (token returned once, never stored);
  logout → `revokeSid`; event-stream tickets carry the `sid` and `/events` resolves it with
  `bySid`; signed media links resolve `v=<sid>` with `bySid`; `deletePlayerData` →
  `revokeFor('player', id)`; `revokeOrgUserAccess` → `revokeOrgUser`; `m13` `/org/sessions`
  → `listOrgUser` with `isCurrent` (neither token nor hash in the response) and
  `/org/sessions/revoke` → `revokeOwn(userId, sid)` (another user's or a player's `sid` →
  `revoked: 0`); `m25` → `revokeSid` / `revokeFor('ts_reviewer', id)`. `db.sessions` is a
  read-only view over the table for the remaining iterating readers (count); a direct write
  throws and names the repository.
- **API compatibility.** No route, payload or behaviour change. Existing bearer tokens and
  `sid`s remain valid through the cutover and restarts (looked up by hash). Reviewer and
  staff `sid`s in media links and listings are unchanged.
- **Tests and acceptance (all met).**
  - `node scripts/testSessions.mjs` → **16 sessions checks passed**: validation refuses
    every unsupported shape with a reason and coerces nothing; a valid blob is imported
    hashed, retired and recorded in one transaction; empty blob / missing blob / stale
    populated shadow all cut over complete; one unsupported row aborts with the file
    byte-identical, the blob authoritative and the same abort on restart; the pre-S0
    legacy upgrade (staff imported first, both blobs retired; unknown staff id still
    aborts); failure injection after the import leaves no trace and the next boot cuts over;
    `create` returns the token once and the table and view hold only hash-free rows;
    expiry at the exact boundary; non-default lifetime honoured and a changed lifetime
    recomputes every stored expiry; every revocation path removes exactly its own sessions
    with users and organisations isolated; the shadow, even enabled, never writes or
    deletes live sessions; snapshot mode exposes hashed rows, hashes planted plain tokens
    and counts unrepresentable rows; `users` replacement does not cascade-delete valid
    sessions; the busy timeout waits for a concurrent writer in another process; the
    rollback tool produces the copy, refuses a later schema (exit 4) and **leaves no output
    on refusal**; through the real server: legacy player and staff tokens work after the
    cutover and a restart, the blob is gone, no plain token in the table, own-session
    listing without token or hash, cross-user revoke returns 0, event-stream ticket and
    `/events` follow the session, checkpoint + VACUUM leaves no plain token in the file,
    logout → 401 for the token, its media link and a new ticket, fresh login mints a 48-hex
    token that appears nowhere in `/capabilities`, `domains.sessions.mode = 'live'`.
  - `node scripts/testCoreSchema.mjs` → **22 checks passed** (S2 adaptations: the shadow
    projects four tables, `sessions` is never written or deleted by it, the legacy-backup
    strict validation regression from `abc0f6a`).
  - `node scripts/testDataLayer.mjs` → **16 checks passed** (the schema report pins the
    three migration ids; `attach` distinguishes a superseded blob from a stale one and
    never imports a stale row over the table; the pre-S0 fixture is imported by the
    cutover migration before the repository attaches).
  - `node scripts/testSchemaDdl.mjs` → **13 checks passed** (migrations `0001–0003` applied
    by the real runner match `01_identity.sql` column for column and index for index).
  - `npm test` (full chain) → green: 23 trust/safeguarding, 20 identity, 16 data-layer,
    22 core-schema, 16 sessions, 13 schema-DDL checks (110 in all).
  - Full server battery (48 suites, `battery.sh`, temporary `DATA_DIR`): 46 green on the
    first run; `m23BootContract` failed 8 checks because its store scanner read the
    SQLite handle named `db` in `repositories/sessionsRollback.mjs` as three store names
    (`db.exec`, `db.prepare`, `db.close`); the handle was renamed `sqlite` like every other
    repository and the suite passes (57 checks). The 2 failing checks in `m182E2E` are the
    pre-existing client-source failures recorded under S1 (identical on the `66c095c`
    baseline). `preM24SweepE2E` (36 checks, planted sessions found by hash) green.
  - Rollback verification against the **pre-S2 build** (detached worktree at `abc0f6a`,
    scratch script, synthetic data only, 10 steps): the S2 build cuts a legacy fixture
    over and mints a fresh token; `sessionsRollback.mjs` writes the copy with the source
    digest unchanged; the copy has no cutover record, an empty table, an empty `sessions`
    blob, the staff row and no plain token anywhere in the file; the pre-S2 build boots
    the copy, answers 401 to every earlier token (legacy and S2-minted), accepts a fresh
    sign-in and serves player and directory data; its new session is persisted as a blob;
    the S2 build then re-upgrades the copy keeping that session and keeping the revoked
    tokens dead; a copy carrying `0004_future_step` is refused with exit 4 and no output.
  - Performance (`npm run perf:data-layer`, synthetic, throwaway database, medians of 5;
    the lookup columns now compare the legacy `Array.find` against the repository's
    `byToken`, which hashes the token and applies the liveness rule, so they are not the
    raw indexed `SELECT` of the S1 table):

    | Synthetic size | JSON | normal save | save with validation on | projection alone | legacy array scan | `sessions.byToken` | file |
    |---|---|---|---|---|---|---|---|
    | 1k players, 2k sessions, 50 orgs | 1.4 MB | 13.2 ms | 61.3 ms | 49 ms | 49.5 µs | 14.6 µs | 2.5 MB |
    | 10k players, 20k sessions, 500 orgs | 14.5 MB | 93.7 ms | 747.8 ms | 594 ms | 236.7 µs | 8.9 µs | 23.5 MB |

- **Rollback (as built and verified).** Restoring the pre-S2 backup is **not** the rollback:
  the backup holds plain tokens of every session that existed at backup time, so restoring it
  would revive sessions revoked afterwards and discard every later write to every other
  collection. The rollback is `node scripts/sessionsRollback.mjs <data-dir> <out-dir>` on a
  copy: it opens the source read-only, copies it (`VACUUM INTO`), refuses (exit 4, no output
  file) if `data_migrations` holds any id later than `0003_sessions_live`, deletes that row,
  empties `sessions`, writes an **empty** `sessions` blob, removes `meta.sessionsCutover` and
  `meta.sessionTtlMs`, advances `meta.saveSeq`, VACUUMs the copy and prints the counts. The
  source is never modified and no backup is deleted. The pre-S2 build on `<out-dir>` keeps
  every other collection and invalidates every session, so every user signs in again and no
  revoked session can become usable; hashes cannot be turned back into tokens, which is why
  "everyone signs in again" is the only honest rollback.
- **Removing readable tokens versus removing historical tokens.** *Logical* removal is
  complete at the commit of the cutover: no active table, blob, view, log, report or export
  carries a token. *Physical* remnants of the plain tokens the blob once held survive in free
  pages of `scoutbox.db` until `VACUUM` and in `scoutbox.db-wal` until `PRAGMA
  wal_checkpoint(TRUNCATE)` (the server test asserts both steps leave no fixture token in the
  file), and in every pre-S2 backup, which remains a live credential store until the TTL has
  passed since it was taken or it is rotated. The checklist is in `OPERATIONS.md`; no tool
  deletes a backup.
- **Runtime persistence changed?** Yes, for sessions only: one row written per login, one
  deleted per logout/revocation, no debounce; the `sessions` blob is gone. Every other
  collection saves as before.
- **Commit boundary.** `abc0f6a` (S1 compatibility correction: strict validation of
  pre-revision backups) then one commit for S2 (migration, repository, call sites, rollback
  tool, tests, perf harness, documentation), then one correction commit after the
  independent review of `6dca457` (below).
- **Review corrections after `6dca457`** (each reproduced by the reviewer, each with a
  regression test that failed on `6dca457` first; `scripts/testSessions.mjs` now has 22
  checks):
  1. *Snapshot tools promoted the S1 shadow table.* `SESSIONS_TABLE.read/replace` checked
     only that the `sessions` table existed, which it has since migration `0002`; on an S1
     file a snapshot tool read the empty shadow instead of the blob and its save deleted the
     blob with no cutover record. Now `repositories/database.mjs` `migrationApplied()` is the
     one authority: `read` returns null and `replace` returns false until
     `0003_sessions_live` is recorded (`USERS_TABLE` keys on `0001_org_users` the same way),
     so before the cutover the blob is read and written and the table is left alone whatever
     it holds, and the rollback copy (record removed, empty blob) reads and writes the blob
     until the S2 build re-upgrades it. Tested for an empty shadow, a stale populated shadow,
     a valid blob, the cutover, and rollback output before and after re-upgrade.
  2. *Legacy `db.json` import lost sessions.* In server mode `store.load()` imported
     `db.json` through the server-mode save, which skips table-backed collections, so the
     sessions (and staff) never reached the file that migration `0003` reads; the migration
     recorded an empty cutover and the valid token stopped resolving while `db.json` had been
     renamed. Now the import writes every collection with snapshot semantics (a blob for a
     domain not yet cut over, its table otherwise) and commits before the rename, so the
     cutover's authoritative input holds everything the JSON held; a failed import throws
     `LEGACY_IMPORT_FAILED`, leaves `db.json` in place and is fatal in `server.mjs` (never
     "run from seed"). Tested from a real `db.json` at the store + data-layer level (player
     and org sessions, staff import, unsupported row → abort with every row preserved in the
     file and in `db.json.migrated`, identical abort on retry, success once resolved) and
     through the spawned server.
  3. *Snapshot saves silently dropped invalid sessions.* `replace` deleted the rows, skipped
     validation failures and swallowed insert errors; the count it returned was discarded.
     Now every row is validated first (shape, duplicate sid, duplicate token) and the first
     problem throws, naming the sid and reason and never a token; a foreign-key failure at
     insert throws too; the store's transaction rolls back, so the stored sessions and every
     unrelated change in the same save are untouched. The former "junk is skipped" test was
     replaced; new tests cover malformed rows, duplicate ids and hashes, a staff relationship
     the snapshot itself breaks, and a valid hashed round trip. Removal is explicit only.
  4. *The SQLite-unavailable path was broken.* `createSessionsRepository({ sqlite: null })`
     attached as `memory` and crashed on `create`; the store's JSON fallback would have kept
     plain tokens. Decision: node:sqlite is **required**. `openStore` throws
     `SQLITE_REQUIRED` before touching the data directory (the process stops at startup),
     the repositories and `attachDataLayer` refuse a missing connection, `package.json`
     declares `engines.node >= 22.5.0`, and `OPERATIONS.md` says so. Tested by starting the
     store and the server with `--no-experimental-sqlite`. (Raised to `>= 22.16.0` by the S3
     compatibility correction, §S3 "Runtime contract": the S3 guards need
     `DatabaseSync.isTransaction`, which arrived in 22.16.0 / 24.0.0.)
  Two consequences the strict saves surfaced in the battery, fixed in the same commit:
  `POST /admin/backup` exported the hash-free `db.sessions` view, so restoring a backup into an
  empty directory now aborted the cutover ("no token" on every row) where it used to lose the
  sessions silently; the backup now writes `sessions.exportRows()` (hashes, never tokens) and a
  restore keeps every session (tested through the real server: backup → copy → boot → both
  tokens 200). `preM24SweepE2E` planted sessions with a missing or malformed creation time
  through a snapshot save and relied on the skip; its S4/S7 checks now assert that such a save is
  refused whole, names the sid and never the token, leaves the stored sessions intact and
  honoured, and that the never-stored token answers 401 (40 checks, up from 36).
  Verification fixes in the same commit: the busy-timeout test runs under the asynchronous
  harness (its check counts only after the assertions pass); the server test carries a
  deterministic media fixture and requires the signed link, a 200 with the fixture bytes, a
  401 for a re-pointed sid and a 401 after logout.
- **Review corrections after `8baafde`** (two further defects the reviewer reproduced; each
  has a regression that failed first; `testSessions.mjs` now has 25 checks):
  5. *Non-array collections bypassed the strict validation.* `writeTableBacked` skipped any
     table-backed collection that was not an array, so a snapshot whose `sessions` was an
     object (carrying a plaintext token) was never validated: the save wrote the object into
     `collections.sessions` as a new legacy blob, plaintext token included, next to the live
     table, and committed the unrelated change. Now `checkTableBackedShapes()` runs before
     anything is dispatched: an absent (or `undefined`) collection is a partial snapshot that
     leaves its table alone; a present non-array (object, null, string, number) throws, the
     transaction rolls back, nothing is written to any table or blob, and after a cutover no
     legacy blob can be recreated whatever the input shape. The same check protects `users`.
     Tests: Codex's object-with-token case, null, string, number, for both collections;
     unchanged sessions, users and unrelated records; no plaintext token in the file after a
     checkpoint; no blob row; an omitted collection commits; the pre-cutover (S1) file refuses
     the same shapes without touching its blob.
  6. *Invalid legacy files fell back to seed data.* `store.load()` turned a read or parse
     error, or an envelope without `db`, into `null`, which `server.mjs` treats as "no
     snapshot" and runs from seed, persisting demo data next to the untouched invalid file.
     Now only a genuinely absent `db.json` (ENOENT) returns null. An existing file that cannot
     be read, is not valid JSON, is not a JSON object, has no `db` object, has no `players`
     array, or carries a table-backed collection that is not an array throws
     `LEGACY_IMPORT_FAILED` before a byte is written or renamed; the import failure path from
     correction 2 is unchanged. Other blob collections may hold any JSON value (modules keep
     scalars such as `deliveryCentreSince`, which the backup of a running server exports).
     Tests at the store level: truncated JSON, empty file, `{"savedAt":1}`, `db` as an array
     or a string, a top-level array, a non-array `sessions`, a non-array or missing `players`,
     an unreadable path (a directory named `db.json`): each fatal, source byte-identical,
     nothing renamed, nothing written, same result on retry; genuine absence → null;
     failure then a repaired file → import and cutover succeed. Through the spawned server:
     truncated JSON, `{"savedAt":1}` and an object `sessions` each end the process with a
     non-zero code and `LEGACY_IMPORT_FAILED` before `listening on`, with `db.json`
     preserved, nothing renamed and zero rows in `collections` (no seed save).

### S3 — Organisations cut over (+ `org_users` rebuild with FK) — DONE

- **Objective (met).** `orgs` is live through `repositories/orgs.mjs`; `org_users` is
  rebuilt STRICT with `org_id REFERENCES orgs(id)` and `json_valid` CHECKs, so the foreign
  key chain `sessions → org_users → orgs` is complete and enforced; the `orgs` blob is
  validated, imported and retired in the one transaction that records the cutover. The
  nested facets stay in a transitional column of the same row until their own steps (S9
  tactical/squad/lookingFor/federationCheck, S10 verification domains, S11 agency settings);
  readers see exactly the record shape they saw before. **Not in scope, by decision:** no
  org deletion route, no tombstone column and no hard delete (O2 is unresolved: the policy
  for an organisation with open recruitment cases is a product decision; `suspended` stays
  the only lifecycle flag and the repository exposes no delete). The earlier title's "org
  tombstone" is therefore not built here; S4 introduces tombstones for players and guardians,
  and the org policy follows O2.
- **Depends on.** S2 as corrected (`5a9e75d`). Readiness gate for S3 itself: the cutover
  migration is the validation — dry-run on a copy (`DATA_DIR=<copy> node server.mjs`); it
  cuts the copy over or refuses with `ORGS_CUTOVER_BLOCKED` and the list of ids and
  reasons; the real directory is not touched.
- **Field ownership (one authoritative location per field).** Established by searching the
  whole repository for every read, write and nested mutation of organisation records
  (`db.orgs`, `org.<field> =`, `?.squad`, `verification.` and the `m13`/`m14` modules):

  | Field(s) | Location after S3 | Written by |
  |---|---|---|
  | `id, name, type, level, plan, country, trustedPartner, verified, verifiedDomain, safeguardingContractSigned, suspended, emailDomain, emailDomainVerified, mfaRequiredForLeads, createdAt` | columns (`level` nullable: the T&S creation path writes `null`) | `orgs.insert` (registration, T&S creation), `orgs.update` (admin verification toggles, credentials, suspension, e-mail domain, `m13` security, password upgrade on login) |
  | `password` | column `password_hash` (same scrypt string as before) | `orgs.insert` / `orgs.update` |
  | `location {city, lat, lng}` | columns `city, lat, lng`; presence and sub-key order kept in `facets_json.__meta` | `orgs.insert` |
  | `federationRef {federation, registrationId}` | columns `federation, federation_registration_id`; presence kept as above | `orgs.insert` |
  | `tactical, squad, lookingFor, federationCheck, agencySettings`, the whole `verification` object, every unknown field | **transitional** `facets_json` on the same row, authoritative for these fields until S9–S11; mutated in place on the record the view serves (`org.squad.push`, `org.lookingFor = …`, `org.verification.revokedAt = …`) and persisted by `orgs.flush()` inside every snapshot save | the existing in-place writers, unchanged |
  | `verification.revokedAt`, `verification.orgType` | derived mirror columns `verification_revoked_at`, `verification_org_type`, rewritten at every flush; **read by nothing** until S10 makes them authoritative | `orgs.flush()` |
  | key order, explicit `null`s, absent-vs-present composites, unknown composite sub-keys | `facets_json.__meta` / `__rest` (never exported: snapshot tools and backups see the plain record) | the repository mapping (`toRow` / `fromRow`) |

  No field has two writable homes: assigning a column-backed field on the record `db.orgs`
  serves throws and names `orgs.update`; the facet keys remain plain mutable properties;
  the array view throws on `push` / index assignment. The S1 shadow no longer projects
  `orgs` (`CORE_SHADOW_TABLES = guardians, players, guardian_children`), so nothing
  competes for the migrated fields. API shapes are unchanged: a record round-trips
  byte-for-byte through the mapping (tested for every shape the application writes,
  including `level: null`, `location: null`, absent composites, unknown fields and explicit
  nulls), and `__meta` never appears in `/admin/clubs`, `/orgs/directory`, a snapshot export
  or an admin backup.
- **Files / tables.** `repositories/orgs.mjs` (new: validation without coercion, the
  row mapping, `ORGS_TABLE` for snapshot tools, the repository with `view`, `byId`,
  `insert`, `update`, `flush`, `attach`), `repositories/migrations/0004_orgs_live.mjs` (new:
  the cutover and the `org_users` rebuild, `foreignKeysOff = true`), `repositories/database.mjs`
  (runner support for a step that must run with `PRAGMA foreign_keys = OFF`: the pragma is
  set before `BEGIN`, `PRAGMA foreign_key_check` must be empty before `COMMIT`, and the
  pragma is restored in `finally`), `repositories/index.mjs` (`TABLES = orgs, users,
  sessions`; `writeTableBacked` replaces then prunes in reverse order so a restore deletes
  children before parents; the repository attached before `users`; `domains.orgs` in the
  report; the store flush hook), `repositories/shadow.mjs` (`orgs` removed from the shadow),
  `repositories/orgsRollback.mjs` + `scripts/orgsRollback.mjs` (new), `store.mjs`
  (`setSaveHook`: the repository save hook runs inside the server-mode save transaction and learns its outcome), `server.mjs`
  (registration, password upgrade, e-mail domain, suspension, credentials and verification
  toggles through the repository; `orgs` passed to `m13`/`m14`; the boot integrity report
  moved after `attachDataLayer`), `m13/enterprise.mjs` (`/org/security`), `m14/review.mjs`
  (T&S org creation, verify, revoke), `scripts/testOrgs.mjs` (new), `scripts/testSessions.mjs`,
  `scripts/testDataLayer.mjs`, `scripts/testCoreSchema.mjs`, `scripts/testSchemaDdl.mjs`
  (fixtures now create the organisations their staff rows reference, as the foreign key
  requires), `package.json` (test chain), `docs/architecture/sql/01_identity.sql`,
  `sqlite-schema.md`, `OPERATIONS.md`, `CLAUDE.md`.
- **Validation and abort behaviour for unsupported records (as built).** A legacy record is
  *supported* when it is a plain object with a non-empty string `id` and `name`, `type` in
  `club | agency`, `level` absent, `null` or in `pro | academy | agency | grassroots`, `plan`
  in `Pro | Academy | Agency | Grassroots`, every flag absent or boolean, every text field
  absent, `null` or a string, `createdAt` absent, `null` or a non-negative integer, `location` absent,
  `null` or an object whose `lat`/`lng` are both numbers or both absent/null, `federationRef`
  absent, `null` or an object of strings, `verification` absent, `null` or an object, and no
  reserved `__meta` / `__rest` key. Nothing is coerced. Duplicate ids and a staff row whose
  `org_id` names no organisation in the blob are unsupported too. The migration validates
  everything inside its transaction and, if anything is unsupported, **aborts**: rollback,
  `ORGS_CUTOVER_BLOCKED: N unsupported record(s); repair them on the current build first — id
  X: reason; staff usr-Y: names organisation Z, which the orgs blob does not hold`, file
  byte-identical, blob still authoritative, same abort on the next boot. No flag drops rows,
  no automated repair, and an invalid database is never treated as a new installation or
  filled from demo data (`loadSnapshot` only seeds when there is genuinely no snapshot).
- **Atomic cutover and completion record (as built).** `0004_orgs_live.up(sqlite)` inside
  the runner's transaction, with foreign keys off for the rebuild: read the `orgs` blob
  straight from `collections` (JSON and array checks; a missing blob is a first installation
  and imports nothing); validate every record and every staff reference (abort as above);
  `DROP TABLE IF EXISTS orgs` (the S1 shadow, never read by anything) and create the live
  table; insert one row per record; `CREATE TABLE org_users_s3` (STRICT, FK, CHECKs), copy
  every staff row, `DROP TABLE org_users`, `ALTER TABLE org_users_s3 RENAME TO org_users`,
  recreate the four indexes — in that order because SQLite ≥ 3.26 rewrites `REFERENCES` in
  other tables on `RENAME`, so renaming the old table first would have pointed
  `sessions.org_user_id` at the temporary name; the migration then asserts that `sessions`
  still references `org_users` and that the copied count equals the staff count; write
  `meta.orgsCutover` (`at`, `imported`, `staffRebuilt`, `blobPresent`) and the initialisation
  state `meta.orgsInit` (`done` when a blob was imported, even an empty one, or the file
  already held any saved collection; `pending` only when nothing was ever saved to the
  database — a first installation); `DELETE FROM collections WHERE name = 'orgs'`. The runner
  checks `PRAGMA foreign_key_check`, inserts the `data_migrations` row `0004_orgs_live` and
  commits. Completion is decided **only** by that row: `attach()` throws without it whatever
  the table holds; the in-memory array is never imported by `attach()` (an organisation it
  names that the table does not hold is warned about and ignored); a first installation is
  initialised by `initialize()` once, while the recorded state is `pending`, inside one
  transaction with the change to `done`. Sessions are **not** touched: no row
  deleted, no cascade (the rebuild drops the parent table only while foreign keys are off and
  the new parent holds every id), tested by hash and by count. A failure injected after the
  import but before the commit leaves no trace and the next boot cuts over cleanly.
- **Startup and storage paths (all preserved, all tested).** S2 database (cuts over on first
  boot); pre-S2 and pre-S0 files (`0003` imports the `users` blob first, then `0004` imports
  the organisations, same boot); legacy `db.json` (imported by the store, then both
  migrations); first installation with no snapshot (seed written through the repository on
  the first save: 5 organisations live); restart (columns and facets come back together);
  failure then retry; snapshot export/import and admin backup/restore (`db.orgs` is the
  table's rows merged with their facets, written back as rows; a restore with an unsupported
  record, a duplicate id or a staff row naming a missing organisation is rejected as a
  whole; a partial snapshot without `orgs` leaves the table alone); shadow validation, even
  enabled, never writes or deletes live organisations or sessions.
- **Transitional transaction limits (documented, not hidden).** Column changes persist at
  once in their own transaction (`insert`/`update` refuse to run inside an open transaction:
  their bookkeeping could not follow a rollback they do not own). Facet changes persist with
  the next debounced snapshot save (2 s), as every unmigrated collection does, through the
  repository's save hook inside that save's transaction — so a crash inside the debounce
  window can lose a facet change made in the same request whose column change already
  landed. The two live in one file and one backup; the window closes as each facet moves to
  its own table (S9–S11). There is no cross-domain transaction yet (C.2). Change tracking
  reflects **committed** state only (correction 1 below): a facet change flushed into a save
  that then fails is flushed again by the next save.
- **Code changes.** Grassroots registration (`/auth/org/register-grassroots`) and T&S club
  creation (`m14`) → `orgs.insert`; password upgrade on login, admin credentials rotation →
  `orgs.update(id, { password })`; e-mail domain verification → `orgs.update(id, {
  emailDomain, emailDomainVerified })`; `suspend_org` → `orgs.update(id, { suspended })`;
  admin verification toggles → one `orgs.update` with only the supplied fields; `m13`
  `/org/security` → `orgs.update(id, { mfaRequiredForLeads })`; `m14` verify / revoke →
  `orgs.update(id, { verified })` plus the in-place `verification.revokedAt` facet write. Every
  other reader keeps `db.orgs.find(...)` over the view.
- **API compatibility.** No route, payload or behaviour change. Org ids, staff ids, roles,
  MFA state, delivery preferences, unknown fields, session hashes and `sid`s are preserved
  through the cutover and restarts (tested field by field and by hash).
- **Tests and acceptance (all met, final code).**
  - `node scripts/testOrgs.mjs` → **11 organisation checks passed**: mapping round trip for
    every shape the application writes; validation refuses every unsupported shape with a
    reason and coerces nothing; the cutover imports every field, rebuilds `org_users` STRICT
    with the FK, keeps every staff row and session, recreates the indexes, passes
    `foreign_key_check`, retires the blob, and afterwards the FK and CHECKs are enforced and
    an organisation with staff cannot be deleted; an unsupported record, a duplicate id, a bad
    plan and a staff row naming a missing organisation each abort with the file byte-identical
    and the same abort on restart, and the repaired file cuts over; empty blob, missing blob
    and a stale populated shadow all cut over complete, and an injected failure leaves no
    trace; `insert`/`update` write at once, a migrated field on the view throws, facets are
    mutable and flushed atomically with a save, everything survives a restart; authority is
    the cutover record and a stale array never overwrites the table; snapshot mode before and
    after the record with shape, row and FK rejections, a valid write and a partial snapshot;
    the shadow never touches live organisations or sessions; the rollback tool produces a
    pre-S3 copy, refuses a later schema (exit 4) and a never-cut-over file (exit 5) leaving
    no output; and through the real server on an S2 fixture: legacy staff session valid after
    the rebuild, four migrations reported, `domains.orgs.mode = 'live'`, the boot integrity
    report clean with a Room owned by a live organisation (before and after a restart),
    directory and admin views hash-free, grassroots registration is a table row at once with
    the blob gone, login checks the stored hash, looking-for (facet) and security (column)
    settings, admin verification writes the columns, credentials rotation kills the old
    password, suspension → 403 with another organisation unaffected, restart brings columns
    and facets back together with the earlier session still valid, `POST /admin/backup`
    exports six organisations without `__meta`, and the restored directory boots with every
    organisation, facet and session and a clean `foreign_key_check`.
  - `node scripts/testSessions.mjs` → **25 sessions checks passed** (S3 adaptations: fixtures
    create the organisations their staff reference; `.ran` lists include `0004_orgs_live`;
    the S2 rollback test now chains `orgsRollback` → `sessionsRollback` and asserts the S2
    tool refuses an S3 file).
  - `node scripts/testCoreSchema.mjs` → **22 checks passed** (shadow projects three tables;
    org-shadow expectations moved to guardians/players).
  - `node scripts/testDataLayer.mjs` → **16 checks passed** (four migration ids pinned;
    pre-boot blob list `orgs, players, users`).
  - `node scripts/testSchemaDdl.mjs` → **13 checks passed** (migrations `0001–0004` applied
    by the real runner match `01_identity.sql` column for column and index for index;
    `org_users` is STRICT, so the pre-STRICT exemption is gone).
  - `npm test` (full chain) → green: 23 trust/safeguarding, 20 identity, 16 data-layer,
    22 core-schema, 25 sessions, 11 organisation, 13 schema-DDL checks (**130 in all**).
  - Full server battery (48 suites, `battery.sh`, temporary `DATA_DIR`): 47 green;
    `m182E2E` showed **4** failures on the first run — the 2 pre-existing client-source
    failures recorded under S1 (identical on the `66c095c` baseline) plus **2 caused by
    S3**: `integrityReport(db)` ran before `attachDataLayer()`, and after the cutover
    `db.orgs` is a table-backed view the data layer defines, so every boot after the cutover
    reported every Room as `ROOM_ORPHAN_ORG`. Fixed by taking the report after the data
    layer attaches (same report, same never-repair policy); a regression check in
    `testOrgs.mjs` fails with exactly `{"ROOM_ORPHAN_ORG":1}` on the old ordering (verified
    by restoring it temporarily) and passes on the fix; `m182E2E` re-run → only the 2
    baseline failures; `m23BootContract` re-run → green; `npm test` re-run → 130.
  - Rollback verification against the **pre-S3 build** (detached worktree at `5a9e75d`,
    scratch script, synthetic data only, 8 steps, log in the handoff): the S3 build cuts an
    S2 fixture over (legacy staff session works, four migrations recorded); on the S3 build a
    new organisation is registered, one is suspended, a facet (squad) is changed and a fresh
    staff session is minted; `orgsRollback.mjs` writes the copy with the source digest
    unchanged (6 organisations, 2 staff, 4 sessions accounted for); the copy has no cutover
    record, an `orgs` blob holding every organisation **including the post-S3 changes**, an
    empty S1 `orgs` table, the S0 `org_users` definition with every staff row, all 4 sessions
    and a clean `foreign_key_check`; the pre-S3 build boots the copy, serves every
    organisation with the post-S3 changes, accepts both sessions and a new registration, and
    persists its own organisation as a blob; the S3 build re-upgrades the copy keeping that
    organisation and every session; a copy carrying `0005_core_identity_live` is refused with
    exit 4 and a never-cut-over S2 file with exit 5, no output either time.
  - Performance (`node scripts/dataLayerPerf.mjs 1000 2000`, synthetic, throwaway database,
    medians of 5): 50 orgs / 150 staff / 1,000 players / 2,000 sessions, 1.4 MB of JSON —
    normal save 10.8 ms, save with shadow validation on 62.5 ms, projection alone 86 ms,
    session lookup 30.9 µs (array) vs 10.3 µs (`byToken`), file 2.4 MB. The orgs flush is
    inside the normal save and shows no measurable change against the S2 figure (13.2 ms).
- **Rollback (as built and verified).** Restoring the pre-S3 backup is **not** the rollback:
  it would discard every write made since (organisations registered, verifications, every
  other collection). The rollback is `node scripts/orgsRollback.mjs <data-dir> <out-dir>` on
  a copy (server stopped): opens the source read-only, copies it (`VACUUM INTO`), refuses
  (exit 4, no output) if `data_migrations` holds any id later than `0004_orgs_live` and
  (exit 5, no output) if that record is absent, then with foreign keys off: rebuilds the
  `orgs` blob from the table in the previous representation (columns and facets merged,
  `__meta` applied, mirrors dropped — every organisation created or changed after S3
  included), recreates the S1 `orgs` shadow (empty) and the S0 `org_users` definition with
  every staff row, leaves `sessions` untouched (nobody signs in again; no revoked session can
  come back because no session row is written), deletes the `0004_orgs_live` row and
  `meta.orgsCutover`, advances `meta.saveSeq`, checks `foreign_key_check`, VACUUMs and prints
  the counts. The source is never modified; the tool is never run on the runtime directory.
  To reach S1 run `sessionsRollback.mjs` on the result: each tool undoes exactly one step and
  refuses a file that is not at its step.
- **Runtime persistence changed?** Yes, for organisation columns only: one row written per
  registration or settings change, no debounce; the `orgs` blob is gone; facets persist with
  the snapshot save as before. Every other collection saves as before.
- **Known limitations.** Facet persistence keeps the debounce window (above); the derived
  mirror columns are write-only until S10; `orgs.update` accepts only migrated keys (facet
  writers stay in place by design until their steps); the seed organisation set is imported
  by the explicit first-installation initialisation of a fresh database, which is the pre-S3
  behaviour for a demo boot and unchanged (production init vs demo seeding stays C.6); the
  `users` repository (S0) still decides its one-time blob import from "table empty and rows
  given" — its blob is retired by the S2 migration on every upgrade path, so the window is a
  fresh installation only, and it is out of S3's scope.
- **Commit boundary.** One commit for S3 (migration, repository, call sites, rollback tool,
  tests, documentation, the integrity-report ordering fix), then one correction commit after
  the independent review of `0851d38` (below).
- **Review corrections after `0851d38`** (each reproduced by the reviewer, each with a
  regression test in `scripts/testOrgs.mjs` that failed on the `0851d38` code first; the
  suite has 14 checks):
  1. *Failed saves marked facet changes as persisted.* `flush()` advanced its change-tracking
     map inside the save transaction, before COMMIT; a save that failed afterwards (a
     collection that cannot be serialised, a disk-full COMMIT) rolled the row back while the
     map still said "written", so the next save skipped the change and the table kept the old
     facets. **Fix:** the repository keeps `committedFacets` and `pendingFacets`; `flush()`
     writes and records pending; the store's save path now registers a hook
     `{ flush, commit, rollback }` (`store.setSaveHook`) and reports the outcome after the
     transaction ends — `commit` once COMMIT returned (pending promoted), `rollback` once
     ROLLBACK ran (pending discarded) — so a change flushed into a failed save is flushed
     again by the next one; a failure inside the flush itself, in a later write or in COMMIT
     all take the rollback path; `update()` records its own committed row; `insert`/`update`
     refuse to run inside an open transaction. **Test:** three organisations; a squad and a
     looking-for change; failure in a later write (a BigInt in an unrelated collection), at
     COMMIT (injected), and inside the flush after the first organisation's row was written;
     after each failure the table is unchanged and the retry persists every pending change;
     a restart reads them.
  2. *Nested migrated fields bypassed write protection.* The record view refused `location =`
     and `federationRef =` but handed out the mutable nested objects, so `location.lat = 9`
     or `federationRef.registrationId = 'NEW'` changed the view while the table kept the old
     columns (`flush` writes facets and mirrors only). **Fix:** composites are served through a
     guard that refuses assignment, deletion, property definition and prototype changes at any
     depth, with a stable identity per object; reads, spreads and JSON are unchanged; column
     changes go through `orgs.update(id, { location: {...} })`. The survey of the repository
     found no writer that mutates an organisation's `location` or `federationRef` in place
     (only reads, e.g. `haversineKm(org.location, …)`), so nothing needed converting. **Test:**
     every forbidden mutation throws, the table equals the view after a save, a repository
     update built from the guarded view persists immediately and survives a restart with the
     sub-key order kept.
  3. *An empty migrated table could re-import stale organisations.* `attach()` imported the
     supplied array whenever the table was empty, even with `0004_orgs_live` recorded, so a
     stale array or a blob written back into `collections` repopulated an intentionally empty
     authoritative table. **Fix:** initialisation is explicit state, never a row count:
     `meta.orgsInit` (above) is written by the migration; `attach()` never imports; the data
     layer calls `initialize(records)` only while the state is `pending`, which inserts the
     records and sets `done` in one transaction (an interruption leaves it `pending` and the
     next boot retries; a refused batch imports nothing; initialising a table that already
     holds rows is refused; initialising with no records is allowed and records the decision);
     a file cut over before the state existed reads as `done`; `orgsRollback` removes the
     key. **Test:** cut-over file emptied → a stale array and a stale blob are ignored, the
     blob is deleted by the next save, the table stays empty; genuine first installation →
     initialised once, a restart with the seed again imports nothing; interrupted
     initialisation (COMMIT fails) → nothing inserted, still `pending`, the retry succeeds,
     a second initialisation is refused; intentionally empty → `initialize([])` records
     `done` and a later seed array is ignored.
- **Runtime contract (correction after the `c542473` review).** The corrections above rely on
  `DatabaseSync.isTransaction` (node:sqlite), which exists from Node.js 22.16.0 and 24.0.0,
  while `package.json`, `OPERATIONS.md`, `CLAUDE.md` and the store still advertised 22.5+. On
  an older runtime the store opened the database, the first save failed with "orgs.flush runs
  inside a save transaction", the error handler skipped ROLLBACK (the guard read `undefined`)
  and the next save failed with "cannot start a transaction within a transaction" — reproduced
  on the real 22.15.1 binary and on the current runtime with the property masked. **Fix:**
  `scoutbox-server/runtime.mjs` is the one definition of the contract (`MIN_NODE` = 22.16.0 on
  the 22 line, 24.0.0 onwards; feature detection on an in-memory connection decides for any
  other line); `openStore` calls `requireRuntime()` before the data directory is created or the
  file opened, refusing with `NODE_UNSUPPORTED` and nothing touched; `createOrgsRepository`
  checks the connection it is handed the same way; `engines.node` is `>=22.16.0` and the lock
  file mirrors it. **Tests** (`scripts/testRuntime.mjs`, first in `npm test`): the support
  check and the advertised range agree; on the current runtime a save, a failed-save rollback
  and the retry work (real); with `scripts/runtime/maskIsTransaction.cjs` preloaded (a
  declared simulation of the older API shape) the store and the server refuse before touching
  the directory — an absent directory stays absent, an existing one is byte-identical; with
  `SCOUTBOX_TEST_NODE_BINS` naming real binaries, the same probe runs on each (verified with the
  real 22.15.1, refused with nothing written, and the real 22.16.0, on which the full `npm
  test` also passes). The battery (`m23BootContract` included) is unchanged.
  **Remaining metadata inconsistency (recorded, not fixed):** `engines.node >=22.16.0` admits
  every Node 23.x release, while the documented supported lines are 22.16+ and 24.0+ and
  `runtime.mjs` accepts a 23.x only on feature detection (`DatabaseSync.isTransaction`
  present). The metadata therefore does **not** exclude Node 23; the runtime check prevents the
  original failure on any 23.x that lacks the property, so this is not a data-integrity
  blocker. Exact alignment needed, when the Founder wants it: `engines.node` becomes
  `">=22.16.0 <23 || >=24.0.0"` (npm semver range syntax), the lock file's root entry mirrors
  it, `runtime.mjs` refuses major 23 by version (today it defers to feature detection), and
  `OPERATIONS.md` / `CLAUDE.md` state "22.16+ or 24+" — one commit, one regression in
  `scripts/testRuntime.mjs` asserting the range string and that a 23.x version string is
  refused. Until then the documents describe the supported lines and the metadata describes a
  superset.

### S4 — Guardians and players (scalars) cut over; deletion becomes a tombstone; allowlisted views

> **Prepared, not started** (11 October 2026). The evidence-based implementation plan —
> every player and guardian field with its readers, writers and storage; what moves and what
> stays nested; the relationship, minor, duplicate and inconsistency findings; the per-audience
> allowlists reconciled field by field against today's responses; migration, restart,
> authority, session and failed-save behaviour; the transaction boundaries of the operations
> that span several collections (a unit of work on the save transaction, staged repository
> bookkeeping, a media-deletion queue); the rollback design with its stated losses; the bounded
> sequence (**S4a** cutover with today's deletion behaviour unchanged, **S4b** deletion after
> O1) and acceptance tests — is [`s4-readiness-review.md`](./s4-readiness-review.md), corrected
> after an independent review (the guardian e-mail code is **not** hashed in S4a so the rollback
> stays lossless; the hashing moves to S6 with expiry, attempt limits and a resend route). The
> unresolved deletion decision O1 is put to the Founder in
> [`s4-deletion-decision.md`](./s4-deletion-decision.md), which separates demonstrated code
> dependencies (none for a deleted account) from review purposes and distinguishes status at an
> incident, at a report and at a moderation decision. **Dependency:** S4a does not depend on
> O1; S4b does. Two acceptance statements of the text below are superseded by the review:
> "a minor cannot exist without a `guardian_children` row" is a rule for new writes, and legacy
> minors without a link are a presented discrepancy (readiness review §5.5) awaiting the
> Founder's choice; the org view keeps `createdAt` unless the Founder decides otherwise. Where
> the two documents differ from the text below, the readiness review is the current evidence.
> Review-only reproduction: `scoutbox-server/scripts/review/reproShortlistAfterDeletion.mjs`
> (verified: `GET /org/shortlist` answers 500 after a shortlisted player deletes their
> account; fixed in S4a).
>
> **Transaction foundation — DONE (this commit, before the cutover).** The unit of work the
> readiness review §7.4 specifies is implemented: `store.unitOfWork(work)` commits repository
> rows, facet flushes and the blob write in one transaction, restores the in-memory graph in
> place when anything fails (held references keep their identity; no fragment is left for a
> later ordinary save; retry is an explicit rerun), refuses an `async function` before it is
> invoked (an unexpected thenable is rolled back and observed, but its continuation is not
> cancelled — documented, counted), refuses a start inside a foreign transaction, absorbs
> nested saves, fails the whole unit when a joined nested unit failed even if its caller caught
> the error, survives a failed BEGIN or a failing cleanup step without leaving a unit open, and
> defers broadcasts and pushes to `store.afterCommit` (returned promises observed; failures
> counted, never a rollback). Organisations participate fully (a facet changed inside a unit
> and changed back before COMMIT overwrites the intermediate row), sessions may be written
> inside a unit (stateless), `org_users` refuses writes inside a unit. The five defects an
> independent review reproduced on the first commit are regressions in the suite. Tests:
> `scoutbox-server/scripts/testUnitOfWork.mjs`; contract: `scoutbox-server/OPERATIONS.md`,
> "Units of work". **S4a (player/guardian cutover) and S4b (deletion rewrite) are NOT
> implemented**; the media-deletion queue is not built; the legacy-minor guardian-link
> import rule (readiness review §5.5, import-and-list vs refuse) is still the Founder's open
> decision and nothing in this step chooses it.
>
> **S4a, first bounded part — mapping and read-only preflight: DONE (this commit). Live
> cutover: NOT STARTED.** The readiness review's single S4a commit is deliberately split into
> reviewable pieces. This piece implements `repositories/identityMapping.mjs` (player and
> guardian record ⇄ row mapping with `__meta` shape preservation and per-record validation
> without coercion; today's signup, child-creation, co-guardian and seed shapes are the
> compatibility contract; `emailCode` stays plain in the facets, `email_code_hash` NULL;
> `childIds` → `guardian_children` rows with the primary/co rule), `repositories/identityPreflight.mjs`
> (collection and relationship validation — duplicate ids, duplicate e-mails under
> `lower(email)`, dangling references, primary-link disagreements, duplicate links, invalid
> dates — a migration candidate only when nothing is refused and no decision is pending, the
> intended live DDL for temporary test databases, `writeCandidate`), and
> `scripts/preflightCoreIdentity.mjs` (read-only: copies the file, runs no migration, boots no
> server; exit 0 complete / 2 invalid / 3 blocked on the §5.5 decision; never an approval).
> Corrected after an independent review of that commit (regressions in the suite): an empty
> relationship id is refused as a present invalid reference (never trimmed or nulled; the
> candidate writer refuses a malformed row before writing); INTEGER-mapped fields must be safe
> integers so a complete report really loads and round-trips through the intended schema (no
> clamping, no business limits); own JSON keys named like `Object.prototype` members survive the
> mapping as data at every level without touching prototypes.
> **Founder decision recorded and implemented:** a legacy minor with no guardian link at all
> REFUSES the cutover until resolved by hand (readiness review §5.5): the preflight reports it
> as `invalid` by id with no candidate (exit 2) and `identity.initialize()` writes nothing; the
> earlier "count and import" proposal is withdrawn. Adults still linked and minors with co links
> only stay counted findings; O1 stays open.
>
> **S4a, second bounded part — the repository layer: DONE (this commit). Live cutover: still
> NOT STARTED.** `repositories/identity.mjs` holds the players and guardians repositories with
> their coordinated link operations (`insert`/`update`/`restore`, `link`/`unlink`/`ageUp`/
> `remove`, lookups), explicit authority (the `0005_core_identity_live` record and
> `meta.coreIdentityInit`; the S1 shadow tables are refused), atomic and retryable
> initialisation through the preflight, guarded views (column-backed fields, nested composite
> fields, `childIds`; `medical.records`/`programme.completed`/`emailCode` stay mutable facets),
> relationship invariants (`guardian_id` = the primary row; second primary, dangling and
> duplicate links, duplicate e-mails refused; a new minor needs its link in the same
> transaction), and full unit-of-work participation (flush/commit/rollback,
> snapshotState/restoreState). Tested against the intended schema on temporary databases and
> the real store unit of work (`scripts/testIdentityRepositories.mjs`; the schema is prepared by
> the test-only `scripts/identityLiveTestSchema.mjs`). **Not attached in production:**
> `repositories/index.mjs`, `TABLE_BACKED`, server boot, routes, responses, sessions and media
> are unchanged; migration 0005 is not registered and the blob stays authoritative.
> Tests: `scripts/testCoreIdentityMapping.mjs`. **Corrected after an independent review of the
> repository commit (three reproduced defects):** every write operation now runs through one
> boundary in two halves — statements first, memory bookkeeping only once they committed —
> so a standalone operation whose COMMIT fails leaves memory as well as SQL untouched (held
> references, link arrays, indexes, facet tracking); inside a unit the operation joins through
> the store's explicit participant API `store.unit.join`, so a failure after the first
> statement poisons the unit even when the caller catches it (nothing commits, nothing is
> published) while a validation refusal thrown before the boundary does not; and
> `initialize()` validates the snapshot as given through the preflight's shape contract (an
> absent or malformed collection is refused and the state stays `pending`; an explicitly
> empty array is valid). Covered by `review 1–3` in `scripts/testIdentityRepositories.mjs`
> and `store.unit.join` in `scripts/testUnitOfWork.mjs`.
>
> **S4a, third bounded part — the migration module and the rollback tool: IMPLEMENTED AND
> TESTED, NOT REGISTERED (this commit). Live cutover: still NOT STARTED.**
> `repositories/migrations/0005_core_identity_live.mjs` is the real migration (§7.1 of the
> readiness review): inside the runner's one transaction with foreign keys off it decides the
> kind of database from explicit state only (a genuinely new database — no collection row, no
> save revision, no `savedAt` — cuts over empty with `coreIdentityInit = pending`; a saved
> snapshot must carry both blobs as arrays, an absent, unparsable or non-array collection is a
> refusal and never an empty import, and an explicitly empty saved snapshot is `done` and
> stays empty), validates the blobs with the reviewed preflight (every record and link, the
> Founder's legacy-minor rule, age at the run's injectable `now`), aborts with
> `CORE_IDENTITY_CUTOVER_BLOCKED` listing ids and reasons (file byte-identical, same abort on
> the next boot), replaces the three shadow definitions (their rows discarded unread, counted
> in the record) with `CANDIDATE_DDL`, imports through `writeCandidate`, records
> `meta.coreIdentityCutover` and `meta.coreIdentityInit`, retires the two blobs and leaves
> sessions, staff, organisations and every other blob untouched; the runner's
> `foreign_key_check` and `data_migrations` row close it. It refuses to run over an
> initialised live domain. **It is not in `DATA_MIGRATIONS`**: `repositories/index.mjs`,
> `TABLE_BACKED` and server boot are unchanged and `scripts/testCoreIdentityMigration.mjs`
> proves it (production guard), while invoking the real module through the real runner on
> temporary S3-shaped databases: every record shape, the three database kinds, seven
> malformed-snapshot refusals, duplicate ids and e-mails, missing references, the two sides of
> a link disagreeing, an invalid record, the legacy-minor refusal, age re-evaluated at the
> migration instant, repair-and-retry, stale populated shadow rows discarded, a stale blob
> ignored afterwards, four injected failures (after the destructive DDL, mid-insert, before
> the final metadata, at COMMIT — each proven to have fired, each leaving the file in the
> pre-migration state, each followed by a clean retry) and a child process killed at COMMIT.
> `repositories/coreIdentityRollback.mjs` + `scripts/coreIdentityRollback.mjs` are the §8
> tool: on a copy (`VACUUM INTO` from a read-only open, so an active WAL is carried; a fresh
> empty output directory is required) the two blobs are rebuilt from the live rows through the
> one mapping (post-S4 inserts, updates, link changes and removals included — a removed
> player is not resurrected; the outstanding `emailCode` plain), the S1 shadow definitions
> are restored empty (asserted equal to migration 0002's), the 0005 record and the two meta
> keys removed, `saveSeq` advanced, foreign keys checked, the copy VACUUMed and revalidated;
> refusals (later schema → exit 4, never cut over → exit 5, non-empty output → exit 1, a
> recorded 0005 over shadow tables, an unfinished first installation whose `coreIdentityInit`
> is still `pending` → exit 6 — independently reproduced on `64ef3aa`: the empty tables would
> otherwise have come back as an initialised-empty domain — and a malformed marker → exit 7)
> and an injected failure leave no output and the source
> untouched — measured as: main-file bytes and logical content identical, the read-only open's
> empty `-wal`/`-shm` housekeeping files removed by the next ordinary open-and-close
> (`scripts/testCoreIdentityRollback.mjs`, round trip included). Verified against the **real
> pre-S4 build** (detached worktree at `cb1d22b`, scratch script, synthetic data, log in the
> handoff): it boots an S3 file; the current build cuts it over and uses the repositories; the
> CLI writes the copy; the pre-S4 build boots the copy, serves the post-S4 state, accepts the
> pre- and post-cutover sessions, verifies both outstanding e-mail codes and persists a new
> signup; the real migration re-upgrades the copy to the identical live state (apart from the
> pre-S4 build's own `externalIds` backfill on the two players created after its first run,
> and the verifications made on it). Also in this commit: `orgs.initialize()` refuses a
> collection that is not an array (independently reproduced on `cb1d22b`; failing-first
> regression in `scripts/testOrgs.mjs`). **Not done, acceptance unchanged:** registering
> migration `0005_core_identity_live` and attaching the repositories at boot, the boot
> snapshot-presence signal (§7.2), the conversion of today's writers to the repositories,
> per-route atomicity inside units of work (§7.4 per operation), the audience allowlists (§6)
> and the admin guardians view, `facets_json` in `01_identity.sql` (added with the
> registration so the DDL test keeps matching the registered migrations; until then the test
> compares 0005 against the file plus exactly that column), production backup/restore
> integration (the snapshot dispatcher does not know the two tables), and the media-deletion
> handling; O1 remains the Founder's decision; S4b and S5 are not started.
>
> **S4a, fourth part — the live cutover integrated: implemented (`9656a4b`); review
> acceptance of S4a is pending the reviewer's re-check of the three corrections of the fifth
> part below — it is not claimed here.**
> Migration `0005_core_identity_live` is **registered** (`DATA_MIGRATIONS` is 0001–0006;
> `0006_media_deletions` creates the media-removal queue) and `TABLE_BACKED` is `orgs`,
> `players`, `guardians`, `users`, `sessions` (and, since the fifth part, `mediaDeletions`,
> the queue in snapshots). `attachDataLayer` attaches the identity
> repositories between the organisations and the staff (initialises from the seed once while
> `meta.coreIdentityInit` is `pending`, attaches and never imports otherwise), defines the
> read-only views and registers the save-hook participant; the S1 shadow projection, its
> store savepoint, `scripts/validateShadow.mjs`, `SCOUTBOX_SHADOW_VALIDATION` and the
> `shadow` report are removed. The store's snapshot-presence signal is explicit
> (`meta.savedAt` / `saveSeq`, never a `players` blob), `loadSnapshot` refuses a `players`
> collection that is not an array (`SNAPSHOT_INVALID`) and never seeds over a saved file. The
> snapshot dispatcher reads and writes the identity pair as ONE coupled operation
> (`IDENTITY_SNAPSHOT`: both collections or neither; a malformed collection, an invalid record,
> a dangling relationship or a legacy minor without a link rejects the whole save; explicit
> empty arrays are intentional; players are pruned before guardians). Every writer of §2.3 of
> the readiness review goes through `players.update` / `guardians.update` (server routes, m12's
> football category, m13's level review, m29's level / contract status / availability) and the
> multi-collection operations run in `store.unitOfWork` (sign-up with the session, child
> creation with its link, e-mail verification, the co-guardian invitation, aging-up, the admin
> ID review, the level review with its ledger row, the signing completion — the hand-written
> snapshot/restore replaced by the unit, a `SigningAbort` refusal rolls back and the success-fee
> invoice is issued after COMMIT — and deletion: row, links, every session, the media-removal
> entries and the blob tombstones). `views/playerViews.mjs` holds the §6 allowlists (clubs,
> grassroots, guardians, players, Trust & Safety; attendance GPS, other clubs' reports, prefs
> and import claims never reach a club; the admin guardian response carries no hash and no
> code; the shortlist reader skips a deleted player). The crash-safe media-deletion queue
> (`repositories/mediaDeletions.mjs`) is written inside the deletion's transaction, processed
> after COMMIT, at boot and once a minute, cleared only once the file is gone or absent, and
> `/media/:id` answers 404 for a queued id; the rollback tool knows migration 0006, refuses a
> non-empty queue (exit 8) and drops the table on an empty one. `01_identity.sql` carries
> `facets_json`; `08_operations_integrations.sql` carries `media_deletions`; `testSchemaDdl.mjs`
> compares every registered migration with the documents. Verified on the real server
> (`scripts/testCoreIdentityServer.mjs`: a new installation, a previously saved file, an
> intentionally empty domain, an interrupted first installation, a migrated file without blobs,
> stale blobs, malformed input and the legacy-minor refusal — each restarted; the writers through
> their routes and after a restart; the allowlists on actual responses; deletion with a stuck
> file, 404 while queued, the rollback refusal, the boot retry; `POST /admin/backup` restored
> into a fresh directory with every link, code and session hash), against the real previous
> build (detached worktree at `c1d868e`: rollback copy booted there, sessions and the
> outstanding code valid, a write made there re-upgraded by this build; log in the handoff), by
> the five independent review scripts unchanged (all pass), by `npm test` on Node 22.22.2 and on
> the real 22.16.0 binary, and by the 48-suite battery (43 green as run; five suites adapted to
> the activation — the three `under_contract` drift guards now recognise the repository form, a
> hardening fixture that planted an unreadable date of birth through the snapshot asserts the
> refusal instead, a temporal probe sends `foot: 'right'` because a sign-up with a value the
> column refuses is now `400 PLAYER_INVALID` — all green on re-run; `m182E2E` keeps its two
> baseline client-source failures). **Not part of S4a and still open:** O1 (`s4-deletion-decision.md`),
> S4b, the hashing of the e-mail code (S6), S5. No real data was touched; registration in source
> is development work, not authorization for a real-data cutover (operator procedure:
> `scoutbox-server/OPERATIONS.md`, "Players and guardians").

> **S4a, fifth part — the three review findings of `9656a4b`, corrected (failing-first).**
> (1) *Route transactions finished.* A request that changed a column and something else in the
> same operation — `POST /player/medical/records` (the condition column, then the record as a
> facet), guardian ID verification (the column, then the audit-queue entry), programme selection
> (the track columns, then the reset of the completed sessions), Academy+ (the column, then the
> badge), stats (the columns, then the activity log), squad release (the organisation's squad
> facet, the player's columns, the reference, the ledger row, the notifications) — committed the
> column at once and left the rest to the delayed save, so a crash right after the response
> kept half of it. Each is now ONE `unit()`; the provider call of the ID verification stays
> outside the transaction and the unit is entered once it answered; a failed unit answers 500,
> never success. `scripts/testWriterAtomicity.mjs` proves every one through the real server: a
> second connection right after the response sees the whole change, a SIGKILL right after it
> loses nothing, a named seam after the first row write (`internal:<route>.after_row`) and a
> failure of the REAL SQLite COMMIT (`internal:unit.sqlite_commit` → the store's
> `failCommitOfOpenTransaction`: a deferred foreign-key violation the engine refuses at the
> COMMIT statement, not a throw placed before it) each leave nothing in the database or in
> memory, and the retry lands everything. The server suite's claim that "every writer" was
> covered is corrected to the writers it names. A composite's remainder (`medical.records`,
> `programme.completed`, an unknown `stats` sub-key) is now stored under the composite's own key
> in `facets_json` — `facets_json.medical.records`, as the documents describe — instead of the
> reserved `__rest`; rows written in the old layout still read back identically. (2) *Pending
> media removal through backup/restore.* `POST /admin/backup` exports the `media_deletions`
> rows as the `mediaDeletions` collection and leaves every queued file out of `media/` (the
> manifest's `media.queuedForRemoval`); `TABLE_BACKED` lists `mediaDeletions`; the snapshot
> dispatcher reads the queue from the table and writes it back through it, validated whole
> (`MEDIA_DELETIONS_TABLE`); migration `0006` imports and retires a restored `db.json`'s
> `mediaDeletions` blob (a tampered entry aborts the migration whole and the next boot refuses
> the same way; nothing is ever removed on the strength of a file); a stale in-memory array at
> boot is reported and dropped; the boot sweep clears an imported entry once the file is absent
> and removes a file copied back by hand; an older backup without the queue restores as before;
> a backup that fails midway answers `500 BACKUP_FAILED` and leaves no partial directory. The
> rollback tool's refusal of a non-empty queue is unchanged. (3) *Order-independent snapshot
> replacement.* `IDENTITY_SNAPSHOT.replace` rewrites the three tables from the validated
> candidate (links, players, guardians deleted; guardians in two passes, players, links
> inserted in snapshot order) instead of upserting over obsolete rows, so a replacement
> guardian may reuse a removed guardian's e-mail, two retained guardians may swap e-mails, a
> co-guardian may be listed before its primary, and reversed input orders give the same tables;
> real duplicates, missing references and the legacy-minor rule stay refused; a failure
> mid-rewrite and a failure of the real COMMIT leave every row, link, facet and other collection
> intact and a correct retry succeeds. The reviewer's `review-9656a4b-reproductions.mjs` reports
> 0 of 3 on this tree; the five earlier scripts still pass. **Review acceptance of S4a is the
> reviewer's to give; O1, S4b, S6 and S5 stay open.**

> **S4a, sixth part — the ownership guard of the media-removal queue (review of `4ef9345`,
> one finding, corrected failing-first).** The three corrections of the fifth part are
> accepted. Reproduced: a restored `db.json` whose `mediaDeletions` carried a structurally
> valid entry naming a LIVE player's clip (attributed to an unrelated removed player) was
> imported by migration 0006 and the boot sweep deleted the clip while the player and its
> reference stayed. *The invariant:* a file referenced by any live player is never deleted by
> the removed-owner cleanup queue; an entry's own `player_id` is metadata, the authority is the
> identity records' `media[].id` read through the mapping (`liveMediaReferences`: the players
> table once 0005 is recorded, the `players` blob before it, plus the records the server holds
> in memory). *Checked wherever queue rows become authoritative and at the execution boundary:*
> migration 0006 asserts it after importing a restored blob (`MEDIA_QUEUE_OWNERSHIP_CONFLICT`,
> the migration rolls back whole, the blob stays, no file is touched, the next boot refuses
> again — the store had already imported the file and renamed it `db.json.migrated`, the
> established order); `MEDIA_DELETIONS_TABLE.replace` and `writeTableBacked` assert it on the
> FINAL combined state of a snapshot (the queue written against the retained players, the
> players written against the retained queue, or both), so a conflicting save rolls back whole,
> unrelated changes included, while a consistent replacement that removes the owner and queues
> the clip is accepted; the sweep (`process`) retains a conflicting entry with the diagnostic in
> `last_error` (the attempt count untouched), never asks storage to remove it, completes the
> legitimate entries of the same sweep, and reports `conflicts` — an entry becomes a legitimate
> removal only once no live player references it; `/capabilities` → `dataLayer.mediaDeletions.conflicts`;
> `/media/:id` keeps answering 404 for a disputed id (quarantine, never deletion);
> `POST /admin/backup` answers `409 MEDIA_QUEUE_OWNERSHIP_CONFLICT` instead of leaving a
> live-owned clip out as if it had been backed up (no directory created; an `ops` event). No
> shape/path check, uniqueness rule, source immutability or rollback refusal was weakened; no
> new migration; the exported backup format, the schema and the rollback contract are unchanged.
> Proven in `scripts/testMediaDeletions.mjs` (the sweep with an unrelated, absent or owner
> `player_id` and with a record held only in memory; queue-only, identity-only and whole-snapshot
> writes; the real COMMIT failing with the check in the transaction; the migration import) and
> `scripts/testCoreIdentityServer.mjs` (the real server: the refused restore with the backup it
> came from unchanged and the next boot refusing again; a stored conflicting entry surviving boot,
> sweep, restart and the backup refusal; the resolution by hand; a legitimate removal still
> completing). The reviewer's `review-4ef9345-media-conflict.mjs` reports 0 findings with its
> control passing; the six earlier scripts still pass. **Final review acceptance of S4a remains
> the reviewer's to give; O1, S4b, S6 and S5 stay open.**

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

> **Status: see the status block at the end of this section.** The evidence-based implementation
> note is [`s5-player-subrecords.md`](./s5-player-subrecords.md): every field with its writers,
> readers, table, key, ordering and shape rules, the reconciliation of `trialReports`, the
> snapshot-replacement strategy under the child foreign keys, the writer conversions, the tests
> and the rollback. Where the text below differs from the note, the note is current. Two of the
> bullets below are superseded by the note's decisions: no identifier is minted (rows without a
> client-visible id are keyed by `(player_id, position)`), and the migration is
> `0007_player_subrecords` (`0006` is the media-removal queue of S4a).

- **Objective.** The twelve `player_*` tables live (season history, badges, drills,
  attendance, timeline, media and tags, medical records, drill results, activity log,
  external ids, programme completions); `players[].trialReports` is dropped as a stored copy and
  served as a derived value from the `trials` collection until S8 moves the reports into
  `trial_reports`.
- **Depends on.** S4a (`480afdb`): the `players` rows and `facets_json`, the one mapping, the
  unit of work and the media-removal queue. Not on S4b or O1: today's hard delete is preserved
  (the child rows cascade with the player row).
- **Files / tables.** `repositories/playerSubrecords.mjs` (specs, validation, row mapping, the
  derived `trialReports`), `repositories/identity.mjs` (`players.addItem` / `setItems` /
  `patchItem`, child rows in `insert` / `restore` / `IDENTITY_SNAPSHOT`), migration
  `0007_player_subrecords`, `repositories/mediaDeletions.mjs` (ownership through `player_media`),
  `repositories/playerSubrecordsRollback.mjs` + `scripts/playerSubrecordsRollback.mjs`,
  `server.mjs` (boot defaults, media views and tags, attendance, timeline, badges, Academy+,
  stats and season history, drills, programme, medical records, aging-up, match day, trial report),
  `m12/operations.mjs` (chunked upload, captions), `m12/journeys.mjs` (trial check-in),
  `m12/shared.mjs` and `m13/shared.mjs` (boot defaults), `m13/imports.mjs` (external ids),
  `m16/sessions.mjs` (Box Cam clip), `m29/index.mjs` (signing timeline).
- **Data transformation.** Migration 0007 decodes every `players` row through the established
  decoder (current and legacy facets layouts), validates every item, reconciles every
  `trialReports` copy with `trials[].report`, writes the child rows, verifies the re-read record
  against the decoded one byte for byte, then retires the arrays from `facets_json` — all in one
  transaction; any refusal blocks the whole step with ids, fields, indexes and reasons. Media
  files stay on disk; only metadata moves.
- **API compatibility.** Player profile shape unchanged (the record keeps its arrays, served
  read-only); `trialReports` is served from the trials; the audience allowlists are unchanged.
- **Tests and acceptance.** `scripts/testPlayerSubrecords.mjs` (unit), extensions of
  `testCoreIdentityServer.mjs`, `testWriterAtomicity.mjs`, `testMediaDeletions.mjs`,
  `testCoreIdentityRollback.mjs`, `testSchemaDdl.mjs`; battery: `m12*`, `m16*`, `m22*`,
  `preM24SweepE2E` and the suites of every converted writer.
- **Rollback.** Copy-only: `node scripts/playerSubrecordsRollback.mjs <data-dir> <out-dir>`
  rebuilds the `480afdb` representation (arrays and the derived `trialReports` back in
  `facets_json`, the twelve tables dropped, the `0007` record removed) and keeps post-S5 writes;
  the S4a→S3 tool refuses a database carrying 0007 (`LATER_SCHEMA`).
- **Commit boundary.** One commit.

> **Status (S5): implemented, pending review** — one local commit on `feat/sqlite-schema` on top of
> `480afdb` (hash and tree status in the handoff README); nothing pushed, merged, deployed or run on
> real data. Delivered as described in the note (`s5-player-subrecords.md`, whose §6 is the detailed
> status): the twelve tables and `0007_player_subrecords` with its blocking refusal
> (`PLAYER_SUBRECORDS_CUTOVER_BLOCKED`) and its re-read verification before retiring the facets; the
> repository writers and the derived `trialReports`; every writer converted inside units of work;
> media ownership from `player_media`; snapshot replacement under the child foreign keys; the
> copy-only rollback to the `480afdb` build (proved by booting that real build on a rollback copy
> of synthetic data, then re-upgrading it) and the S4a tool's refusal of an S5 file. One behaviour
> change beyond storage: `GET /player/drills` no longer answers 500 for a player without a
> completed drill (an unguarded read, present on `480afdb` too). Verified by `npm test` (17 suites)
> on Node 22.22.2 and the real 22.16.0, the five review scripts that still apply verbatim, the two
> stale ones through behaviour-level equivalents (explained in the note), and the battery once
> after the last production change (46 of 48 green as run: `m182E2E` keeps its two client-side
> baseline failures; `m23TrialPersistence` planted a trial report the player's copy never had and
> met the 0007 reconciliation refusal — fixture made consistent, 36/36; classification in the
> handoff). **Correction round (review of `132eda2`):** three reproduced findings corrected
> failing-first — a snapshot save no longer discards an unreconciled `trialReports` copy (every
> copy written with a record is a claim judged against the final trials at snapshot replacement,
> initialize, insert and restore; absent or null is no claim), the derived `trialReports` follows
> the trials live for absent and null legacy shapes too (shape preserved), and a whole-null
> `medical` / `programme` update is refused while child rows exist, with boot, backup and rollback
> refusing an already inconsistent file (`INCONSISTENT_ROWS`); the reviewer's reproduction reports
> 0 of 3 on the corrected tree (note §6). S4a stays review-accepted at
> `480afdb`; S4b is not implemented; S6 is not started (S6a has since been implemented and independently accepted; §S6).
>
> **Status (S5): review-accepted at `2178c5b`** (12 October 2026). The independent reviewer
> verified the handoff archive's SHA-256, re-ran the original `review-132eda2-reproductions.mjs`
> unchanged (0 of 3), ran the full `npm test` on a real Node v24.19.0 (17 suites, 244 checks,
> exit 0), the five historical review scripts (pass) and the two S5-adapted scripts (pass). The
> battery, the Node 22 runs, the browser suites and the old-build proof were **not** independently
> repeated by the reviewer; they stand as this work's own evidence in the handoff. The reviewer's
> statement is recorded as given: this acceptance is not a production-deployment authorization.

### S6 — Safeguarding and audit (`blocks`, `reports`, `moderation_log`, `org_notes`, `ledger`, `ops_events`, `source_changes`, `idv_queue`, `email_challenges`, `pairing_codes`)

> **Status (S6a, the one-time codes): implemented and independently accepted at `2d7ddeb`
> within the reviewed backend development scope** (14 October 2026; readiness review §10,
> acceptance note) — one local implementation commit on `feat/sqlite-schema` on top of
> `7fbce74`, plus two local correction commits for review findings (the challenge code's copy in
> the persisted mail outbox and stored attempt-count validation — readiness review §10.6; the
> repository's participation in the store's unit of work, so a caught operation failure can no
> longer commit partial work — §10.7). The acceptance is a bounded code-review conclusion on the
> packaged server source (the Player app was not part of it), not production or deployment
> approval; not pushed, merged, deployed or run on real
> data; not production-approved. `email_challenges` and `pairing_codes` are live tables (migration
> `0008_one_time_codes`, `repositories/oneTimeCodes.mjs`): codes stored as sha256 hashes of the
> normalised value, expiry judged on every read and swept, attempt counting on the challenge, four
> rate-limit policies, the e-mail confirmation and the pairing exchange each one unit of work,
> durable issuance, deletion integration, backup/restore in both snapshot formats, and the copy-only
> rollback `scripts/oneTimeCodesRollback.mjs` (outstanding codes invalidated and counted). What was
> built, the decisions and the verification are in the readiness review §10. The guardian e-mail
> code stays plain (review §5.3). **The eight audit tables remain not started** (they wait for S4b).
>
> **Status (S6, the rest): not started.** The readiness review grounded in the code at `2178c5b` is
> [`s6-readiness-review.md`](./s6-readiness-review.md); where the bullets below differ from it,
> the review is current. In particular: the server line numbers below predate S4a and S5; the
> ledger truncation at `m29/index.mjs:618` **no longer exists** (removed in `9656a4b` with the
> signing unit of work — no path erases a committed ledger row today, so the "reversal row" item
> is withdrawn as a requirement, review §2.5); `RESTRICT` references to `players(id)` cannot ship
> before S4b because they would make today's hard delete fail (review §4.1); the `ops_events`
> CHECK list in the DDL is missing two kinds written today (review §2.6); the rollback below, which
> accepts losing post-S6 audit rows, is **not** the proposed path — a copy-only tool is (review
> §7); the migration identifier `0008_safety_audit` is a placeholder assigned from the actual
> order of approval (review §8; S6a took `0008_one_time_codes`). The smallest technically
> independent sub-step was the two code tables (review §6), now implemented as S6a; nothing of the
> audit tables is built or registered.

- **Objective.** Append-only audit tables live with `RESTRICT` references; one-time codes
  hashed with attempt limits; the ledger gets a reversal row instead of truncation on signing
  rollback (`m29/index.mjs:618`); the IDV admin toggle updates by id.
- **Depends on.** S4 (tombstone, so `RESTRICT` references can hold).
- **Files / tables.** `repositories/safety.mjs`, `repositories/audit.mjs`, migration
  `0008_safety_audit`; `server.mjs` `ledgerAppend` 595, `handleReport` 1647, blocks 1633/3751,
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

> **Status (S7a): independently ACCEPTED at `0641b2c600cd1f082436b4b24dbb052b98ee00d7`** (15 October
> 2026; three local commits on `feat/sqlite-schema` on top of `812e13b`, the last being the accepted
> one; review §8.6 holds the acceptance record, its verification on real Node v24.19.0 and its
> limits — not production or deployment approval): `notifications`, `notification_prefs` and
> `notification_pref_categories` are live tables since migration **`0009_notifications`**, with
> the feed's insertion order as a durable key (`seq`), the pre-S7a coalescing scan kept verbatim,
> the stored mandatory-false preference accepted at storage and forced on by the effective view,
> the acknowledgment atomic with the dispatch blob, writes staged into the snapshot save that
> carries the blobs they announce — their push and live event delivered only once that save
> committed — and a copy-only rollback proven on the actual `812e13b` build — review §8.3; the
> first independent review's four findings (effects before commit, owned-transaction memory,
> own `"__proto__"` keys and audience extras, the incomplete package) are corrected in §8.4, the
> second review's two participant-contract defects (an effect registered inside a unit by the
> default immediate participant, a caught precondition refusal bypassing the unit) and its
> replay-coverage gap in §8.5; both rounds are dated history, the acceptance in §8.6 is the current
> status.
> **Status (S7b): IMPLEMENTED, PENDING INDEPENDENT ACCEPTANCE — not accepted** (15 October 2026,
> one local commit on `feat/sqlite-schema` on top of `dc4b559`; review §9 as corrected by the
> independent review of `dc4b559` — the total attempt-shape CHECK, the callback timestamp contract
> with REAL columns, the first-match strict-equality lookup — and §9.7 the implementation record):
> `dispatches` and `dispatch_attempts` are tables since migration **`0010_dispatches`**, with the
> insertion order as a durable key (`seq`), the attempt position as the attempt key (no minted id),
> `notification_id` an indexed reference with no foreign key and no cascade (option A: an ordinary
> deletion keeps its dispatch rows exactly as before; orphans imported and counted, never refused),
> the sweep's rows, attempts and status changes staged into the same save as the outbox row, the
> injection counter and the ops/webhook rows it writes, the acknowledgment joined in the
> notification's unit, and a copy-only rollback proven on the actual `0641b2c` build; the three
> findings of the independent review of `26d492b` (patch refusals outside the participant boundary,
> nested unknown data shared by reference, the legacy non-finite callback clock's precedence) are
> corrected in a correction commit, review §9.8. Not
> production or deployment approval; retention stays an open decision.
> **Status (S7c–S7d): not started.** The evidence-based review is
> [`s7-readiness-review.md`](./s7-readiness-review.md);
> the text below is the sequence it derived and replaces the earlier assumptions of this
> section (recorded there, §0). No further migration identifier is assigned until a sub-step is
> authorised. **Blockers, exactly:** (1) the proposed `channels.request_id` references
> `recruitment_requests`, an S8 table that itself references S8's `recruitment_cases`, `trials`
> and `org_users`, while S8 lists S7 as a dependency — a transitional validated reference is
> proposed in the review §2.3 and needs approval, or S8a ships first; (2) message retention after
> a player deletion is an open policy question (`s4-deletion-decision.md` §4 "messages — review"),
> so no `players(id)` CASCADE/RESTRICT may be encoded for channels; (3) the ledger row every send
> writes stays a blob until the S6 `ledger` table, which waits for S4b, so the "no whole-database
> write on send" objective cannot be met by S7 alone (review §7.3).

- **Objective.** The nine S7 collections become tables in four sub-steps, each independently
  testable and rolled back copy-only without loss: **S7a** `notifications`,
  `notification_prefs`, `notification_pref_categories` (accepted at `0641b2c`); **S7b** `dispatches`,
  `dispatch_attempts` (implemented on top of `dc4b559`, pending independent acceptance; review §9:
  `notification_id` as a plain reference — no foreign key, no cascade, today's deletion and its
  retained dispatch rows preserved, orphan references counted not refused; migration
  `0010_dispatches`, so the `0010_recruitment` placeholder below moves when S8a is approved);
  **S7c** `outbox` (two writer shapes unified), `push_log`,
  `push_tokens` (storage move only — the staff-push re-keying, defect 10 of the schema
  document, is a behaviour change needing its own decision); **S7d** `channels`, `messages`,
  `message_attachments` (after the request-reference decision and the retention answer). The
  whole-database-write objective is met in phases measured by a synthetic benchmark (review
  §7.3), not claimed by any single sub-step.
- **Depends on.** S4a (live identity tables) for every sub-step; **S4b** for any `players(id)`
  reference and for the S6 ledger; **S8a** (or the approved transitional design) for
  `channels.request_id`; nothing else for S7a–S7c. "Depends on S4" in the earlier text did not
  establish that S4a alone suffices; it does not.
- **Files / tables.** Per sub-step, in the review §8.2 (S7a) and §2.3; `server.mjs` 828–877
  (`notify`), 897–917 (`openChannel`), 940–971 (`postMessage`), 3979–3981 (push register);
  `adapters.mjs` (mailer with the S6a withholding, push sender); `m13/delivery.mjs`;
  `m182/notificationPrefs.mjs`; `m23/contactRoutes.mjs:516–551` (`emailCopy.outboxId`, the
  reference S8c wants).
- **Data transformation.** Lossless, one-to-one mappings (review §1); accepted legacy shapes
  and concrete refusal conditions in review §5; nothing coerced or dropped silently; orphan
  dispatches and unknown fields are preflight findings resolved by record, not by the migration.
- **API compatibility.** Channel, notification and delivery payloads unchanged; messages stay
  oldest-first with insertion order preserved for equal timestamps (an ordering column to add to
  SQL03); the S6a outbox withholding and the development-only in-memory delivery unchanged.
- **Tests and acceptance.** Review §7.1–7.2: migration shapes and refusals, joined and caught
  failures, real COMMIT failures, two-connection reads, duplicate send/concurrency, ordering,
  permissions, backup/restore/rollback; existing `connectedE2E`, `apiE2E`, `m13E2E` (the delivery
  centre — there is no `m13Delivery*` suite), `m182E2E`, `m23P4AClosureE2E`, `m23ContactE2E`;
  browser suites `e2e/liveIntegration` and `e2e/m24f3InboxLive` are client checks outside
  `npm test`.
- **Rollback.** Copy-only per sub-step, rewriting every row into the blob shape the previous
  build reads (review §6.2) — **no post-cutover message, notification or delivery record is
  lost**; the earlier "pre-S7 backup + S6 commit (messages after S7 lost)" is withdrawn.
- **Commit boundary.** One commit per sub-step (S7a–S7d), each with its own rollback tool and
  tests.

### S8 — Recruitment core (file 02: 55 tables)

- **Objective.** Requests, trials, cases and rooms, decisions and snapshots, contacts,
  offers, signing packages, signings, follow-ups and outcome reports live; the shared
  `idempotency_keys` table replaces every `keys{}` structure; `players[].trialReports`
  retired (served from `trial_reports`).
- **Depends on.** S5, S6 (ledger rows for signings), S7c (the `outbox` rows that
  `recruitmentContacts[].emailCopy.outboxId` references — "contacts' outbox copies"), and
  the two unresolved relational-integrity decisions below, which must be closed **before
  S8a's migration is written**, not during it. Note the cross-reference with S7: the proposed
  `channels.request_id → recruitment_requests` means S7d needs S8a (or the transitional design
  in the S7 review §2.3), while S8c needs S7c — the sequence is S7a → S7b → S7c → S8a → S7d or
  S8c, decided when each is authorised:
  - *Player tombstone (schema O1, implemented at S4).* `02_recruitment.sql` today declares
    no foreign key on any `player_id` because `deletePlayerData` hard-deletes the player
    row. S4 replaces the hard delete with a tombstone row; S8a then amends
    `02_recruitment.sql` to add `REFERENCES players(id) ON DELETE RESTRICT` on every
    `player_id` column and ships that DDL in migration `0010_recruitment`. Until S4 has
    shipped and the file has been amended, the recruitment domain is **not ready to cut
    over**; the design is unresolved on this point, not finished.
  - *Org deletion policy (schema O2).* `org_id` columns in file 02 are `RESTRICT` on the
    assumption that no org deletion route exists. S3 shipped **without** one (no
    `deleted_at`, no hard delete; `suspended` is the only lifecycle flag, and `org_users`
    already enforces `RESTRICT` in practice), so the assumption still holds; the Founder's
    answer on open recruitment cases decides whether S8 keeps `RESTRICT` or adds a
    tombstone-aware rule.
- **Files / tables.** `repositories/recruitment/*.mjs` (one module per aggregate), migration
  `0010_recruitment`; `server.mjs` requests/trials routes (2068–2371, 2612), `m12/scouting.mjs`
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
- **Files / tables.** `repositories/scouting/*.mjs`, migration `0011_scouting`; `m12/passport.mjs`,
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
  migration `0012_verification_passport`; `m14/*`, `m15/*`, `m13/transitions.mjs`,
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
- **Files / tables.** `repositories/agent/*.mjs`, migration `0013_agent_compliance`;
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
  `repositories/discovery/*.mjs`, migration `0014_development_discovery`; `m12/journeys.mjs`,
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
- **Files / tables.** `repositories/operations/*.mjs`, migration `0015_operations`;
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

- Per domain, exactly one of three states, recorded in `/capabilities.dataLayer`:
  `blob` (untouched), `shadow` (blob authoritative; tables rewritten in the save
  transaction only while validation is switched on; report compares), `live` (tables
  authoritative; blob deleted; view read-only).
- There is **no dual write by application code**: in `shadow` the projection is derived
  from the blob inside the same transaction, so the two cannot diverge on commit; in `live`
  the blob no longer exists. A projection failure is counted and rolled back in its savepoint
  and the blob save still commits (S1 test "projection failure never blocks the blob save").
- A shadow is a validation aid, not a running default: it is off unless
  `SCOUTBOX_SHADOW_VALIDATION=1`, and its report must say `stale` or `never` whenever the
  tables are not from the last save. The lesson from S1's acceptance review applies to
  every later shadow (S3 orgs facets, S4): never put a full re-projection in the default
  write path; per-row repository writes are the only thing that runs on every save.
- Reconciliation is the shadow report (`status`, `reconciled`, per table `snapshotRows`,
  `tableRows`, `projectedRows`, `skipped`, `findings`, `accountedFor`; ids and reasons on
  the admin route and in the validation command) and, at cutover, the import's findings
  list, which the boot prints and stores in `ops_events` (`kind: 'data_import'`).

### C.3 Backups and dry runs on disposable copies

- Before every cutover boot: `POST /admin/backup` (today's copy of the file and media;
  from S13 `VACUUM INTO`). The operator then runs the dry run on the backup:
  `node scripts/validateShadow.mjs <backup-dir> --strict` (exists since S1; it copies the
  backup with `VACUUM INTO` into a temporary directory, projects there, prints per-table
  counts, refused rows with reasons and adjusted relationships, deletes the copy, and exits
  non-zero unless the result is `complete`). Each later step extends the same command to
  its own domain. A cutover is attempted only when the strict run on the latest backup
  exits 0; a refused row or an adjusted relationship is repaired or deliberately revoked
  on the current build first, with the action recorded in `ops_events`.
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
