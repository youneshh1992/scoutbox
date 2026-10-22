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
nothing of S4b is built and today's hard delete is unchanged; what remains to build and what still needs an answer
is in §D.1), **S5 implemented and
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
accepted), **the rest of S6 not started** (the eight audit tables; the foreign key on five of them waits for S4b,
review §4.1 — the tables themselves wait for an approval, §D.2),
**S7a independently accepted at `0641b2c600cd1f082436b4b24dbb052b98ee00d7`** (15 October 2026; a
bounded code-review conclusion on the packaged source — both reviewer scripts, the backend and
Player gates and the pre-S7a rollback boot verified by the reviewer on real Node v24.19.0 — not
production or deployment approval; the notification tables, migration `0009_notifications`, its
copy-only rollback; [`s7-readiness-review.md`](./s7-readiness-review.md) §8.3 records what was
built, §8.4–§8.5 the two correction rounds as dated history, §8.6 the acceptance and its limits:
no exactly-once external delivery, the explicit raw-transaction `reload()`, hook registration as the
caller's responsibility; the Player app was not touched), **S7b independently accepted at `ac50b60257b89387aa1dec44bad7f571e61aa74e`** (16 October 2026; the
bounded dispatch/attempt storage milestone and its three corrections — `dispatches` and
`dispatch_attempts` as tables, migration **`0010_dispatches`**, its copy-only rollback; backend 23 suites /
324 checks, Player 4 / 41 and the three reviewer scripts verified by the reviewer on real Node v24.19.0; not
production or deployment approval; review §9.9), **the notification-extras follow-up independently accepted at
`6ca66ba`** (review §9.10), **S7c independently accepted at `911918749687a3acdca430fe011d6c868ee640df`** (17 October
2026, for its bounded storage-migration scope — `outbox`, `push_log` and `push_tokens` as tables, migration
**`0011_outbox_push`**, its copy-only rollback; implemented on top of `6ca66ba` and corrected twice after independent
reviews, review §10.8, §10.10, §10.11 as dated history; the reviewer verified backend 25 suites / 348 checks, Player
4 / 41, `m13E2E` 212 checks, the six reviewer scripts and the actual pre-S7a/S7b/S7c rollback boots on real Node
v24.19.0; not production, security, legal-compliance or deployment approval; review §10.12),
**S7d independently accepted at `4f954ad92cda6ca5178cc6c3d5485265684e0c03`** (18 October 2026, for its bounded
backend storage-migration scope — implemented on top of `b67bce5` and corrected once after the independent review of
`62e9c1a`, review §11.9 and §11.10 as dated history, the acceptance record and its limits in §11.11; storage-only:
`channels`, `messages`, `message_attachments` as tables, migration **`0012_channels`**, the §2.3 transitional
code-checked request reference approved by the Founder as D-A, today's deletion of a deleted player's threads
reproduced inside the deletion unit as confirmed by D-B — a scope confirmation, not a retention decision; copy-only
rollback `scripts/channelsRollback.mjs` proven on the actual `b67bce5` build; the reviewer verified backend 27 suites /
363 checks, Player 4 / 41, the reviewer's own script, the six historical scripts and the real pre-S7a/S7b/S7c/S7d
rollback boots on Node v24.19.0; not production, security, legal-compliance or deployment approval). **All four S7
sub-steps are accepted. That completes the communications storage stage, not the migration:** `ledger`, `requests`,
`trials`, `recruitmentCases` and every other blob collection are still rewritten by every save (review §7.3), S4b,
the eight S6 audit tables and S8 are not started, and nothing is production-approved. **The current findings and the
decisions the next stage needs are consolidated in [§D](#d-the-next-implementation-stage--current-findings-and-the-decisions-required-19-october-2026-from-the-code-at-4f954ad)
(the Founder's list: §D.5).** S8–S14 planned. The evidence-based plan of S4 is
[`s4-readiness-review.md`](./s4-readiness-review.md).
Migration numbering: `0006` is `0006_media_deletions` (S4a); S5 took **`0007_player_subrecords`**;
S6a took the next unused identifier, **`0008_one_time_codes`** (the plan's placeholder
`0008_safety_audit` is withdrawn); S7a took **`0009_notifications`**; S7b took **`0010_dispatches`**
(the plan's `0010_recruitment` placeholder for S8a moves to the next free number when S8a is
approved); S7c took **`0011_outbox_push`** (the `0011_scouting` placeholder for S9 moves likewise); S7d took
**`0012_channels`** (accepted at `4f954ad`). **The next free identifier is `0013`** (`repositories/index.mjs:53`
registers `0001`–`0012` at `4f954ad`); it is taken by whichever step is approved next (§D.4), never reserved in
advance. The later steps' identifiers
in §B are placeholders, assigned from the actual order in which steps are approved and built.
Existing migration ids never change.

Sections: A principles that hold for every step · B the steps (S0–S14) · C cross-cutting
work (repository pattern, source of truth and dual writes, backups and dry runs, legacy
snapshots, determinism and reconciliation, crash recovery, production init vs demo,
performance, existing tests, what this plan is not) · **D the next implementation stage — current
findings from the code at `4f954ad` and the one list of decisions the Founder is asked for (§D.5)**.

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

> **S4b — what remains, from the code at `4f954ad` (19 October 2026): §D.1.** S4a is implemented and
> accepted (below); today's hard delete is unchanged (`server.mjs:4245–4305`, `repositories/identity.mjs:768–779`);
> `players.deleted_at` and `guardians.deleted_at` exist and are written by nothing. S4b's remaining work, the
> three answers it still needs (the country code, the pre-S4b dangling ids, the optional additional deletion
> behaviours) and its rollback shape are in §D.1, §D.4 (Candidate B) and §D.5 (Q1, Q3, Q6). The text below is
> the dated record.
>
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
> code stays plain (review §5.3). **The eight audit tables remain not started.** Which of them truly wait for
> S4b (the `players(id)` foreign key on five), which wait only for an approval of the no-FK shape, and which
> wait for nothing but authorisation (`moderation_log`, `ops_events`) is set out in §D.2 from the
> code at `4f954ad`; `idv_queue`'s guardian reference needs the identity-snapshot compatibility of §D.2a (the
> identity snapshot deletes and reinserts every guardian row — verified by the review of `6956f52`), so it ships
> only as an approved strict checked reference (Q4b) or after Alternative A's deferral (A0); the five player
> references are tolerant historical references (Q4; the per-reference contract in §D.4, corrected after the
> review of `e7f7692`); the candidate step S6b and the decisions it needs (Q4, Q4b, Q5) are in §D.4–§D.5. S6b
> does not meet the whole-snapshot-write objective (§D.4). **S6b is implemented since 19 October 2026 under
> those three decisions (status paragraph below; review §11) and independently ACCEPTED at `f0abd34` on
> 21 October 2026 (review §11.5).**
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
> independent sub-step was the two code tables (review §6), now implemented as S6a.
>
> **Status (S6b — the eight audit tables): IMPLEMENTED 19 October 2026; corrected 21 October 2026; INDEPENDENTLY
> ACCEPTED at `f0abd3459b435774c00b4e384b046eba23813e88` on 21 October 2026 for its bounded storage-migration scope
> (review §11.5 — the reviewer ran the unchanged `review-c6cf5e1-reproductions.mjs`, the full backend gate (29 suites,
> 379 checks) and the Player gate (4 suites, 41 tests) on Node v24.19.0, one attempt each; both `c6cf5e1` findings
> closed; the two earlier intermittent test failures not reproduced, causes unresolved). Not production, security,
> legal-compliance or deployment approval; not acceptance of S4b or S8. The next step is §D.6.**
> Built as §D.4 Candidate A on top of `1792fc7` (whose brief the independent review accepted), under the
> Founder's explicit decisions Q4, Q4b and Q5 of 19 October 2026 (recorded verbatim in
> [`s6-readiness-review.md`](./s6-readiness-review.md) §11 and in §D.5 below): migration `0013_safety_audit`
> (REGISTERED), `repositories/safetyAudit.mjs`, the eight tables with NO foreign key (the five player
> references tolerant and counted; the organisation and staff ids historical pointers because the block and
> report routes accept them unchecked today — a stated shape-compatibility decision; the IDV guardian reference
> strict in code), the writers converted, the copy-only rollback `scripts/safetyAuditRollback.mjs` proven on the
> actual `4f954ad` build. The "status (S6, the rest)" paragraph above and the bullets below are the dated
> record and are superseded by review §11 where they differ (no `RESTRICT` references, no reversal row — the
> truncation no longer exists — and the IDV toggle updates by row id as built). It removes the eight audit blobs
> from every save's serialisation and **does not meet the whole-snapshot-write objective** (§D.4). Not production,
> security, legal-compliance or deployment approval; not acceptance of S4b or S8. **Correction (21 October 2026,
> review of `c6cf5e1`):** a refused report or IDV patch no longer changes live state (F1), and a nested undefined in
> an audit record is stored as JSON stored it, so a partial Box Cam prefs row no longer fails (F2); review §11.4.
> That correction is the accepted commit.

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
> **Status (S7b): independently ACCEPTED at `ac50b60257b89387aa1dec44bad7f571e61aa74e`** (16 October
> 2026, for the bounded dispatch/attempt storage milestone and its three corrections; review §9.9
> holds the acceptance record and its limits — not production or deployment approval. Built as one
> local commit on `feat/sqlite-schema` on top of `dc4b559` and corrected once; review §9 as corrected by the
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
> corrected in the correction commit `ac50b60`, review §9.8 (dated history). Retention stays an open
> decision.
> **Status (notification extras follow-up): independently accepted at `6ca66ba`** for its bounded
> scope (review §9.10, §10.9).
> **Status (S7c): independently ACCEPTED at `911918749687a3acdca430fe011d6c868ee640df`** (17 October
> 2026, for the bounded storage-migration scope; review §10.12 holds the acceptance record, the reviewer's
> results on real Node v24.19.0 and its limits — not production, security, legal-compliance or deployment
> approval, and not acceptance of S7d, S4b, the remaining S6 tables or S8): migration `0011_outbox_push`
> registered; `outbox`, `push_log`, `push_tokens` are tables written through `repositories/outboxPush.mjs`;
> the prepared design was corrected by the review of `6ca66ba` before the implementation (the push row's
> existing save scheduling kept as it is, tokens stored losslessly as JSON with the route's rule and no
> uniqueness constraint, a nullable delivery destination), then corrected twice after the independent
> reviews of `40aa05c` (an array mail destination; raw JSON overflow tokens — review §10.10) and `78c14b9`
> (a non-finite number inside an accepted array destination kept live and persisted as the old JSON null —
> review §10.11), both dated history; the copy-only rollback is `scripts/outboxPushRollback.mjs`, proven on
> the actual `6ca66ba` build. The earlier intermittent push-timing observation did not recur in the
> reviewer's accepting run; no root cause is established (review §10.10, §10.12).
> **Status (S7d): independently ACCEPTED at `4f954ad92cda6ca5178cc6c3d5485265684e0c03` (18 October 2026) for its
> bounded backend storage-migration scope** — implemented on top of `b67bce5` (review §11.9), corrected once after the
> independent review of `62e9c1a` (§11.10: the unit-of-work restore of `repositories/channels.mjs` uses the graph
> memento, so a held nested view such as `channels.byId(id).readBy` reads the pre-unit state after an aborted unit),
> accepted as recorded in §11.11 (the reviewer's own gates and their limits) — not production, security,
> legal-compliance or deployment approval; not acceptance of S4b, the remaining S6 tables or S8; **all four S7
> sub-steps are now accepted, which completes the communications storage stage and not the migration** (the
> `ledger` and every other remaining blob are still rewritten by every save, review §7.3; the next stage and its
> decisions: §D). Migration `0012_channels` registered; `channels`, `messages` and `message_attachments` are tables written
> through `repositories/channels.mjs` (the acceptance routes' `openChannel`, `postMessage`, the three receipt
> routes, the account deletion); `db.channels` is a read-only view in insertion order with each thread's
> `messages` nested as before; every route answers as before; the copy-only rollback is
> `scripts/channelsRollback.mjs`, proven on the actual `b67bce5` build. The evidence-based review is
> [`s7-readiness-review.md`](./s7-readiness-review.md); the text below is the sequence it derived and replaces
> the earlier assumptions of this section (recorded there, §0). **The three blockers recorded here before the
> implementation, and how each stands:** (1) `channels.request_id` referenced `recruitment_requests`, an S8 table
> — the Founder approved D-A, the §2.3 transitional code-checked reference (`NOT NULL UNIQUE`, no foreign key,
> checked in code at open, import and every snapshot write) until recruitment requests move to tables at S8a,
> which rebuilds the table with the foreign key after its own preflight; (2) message retention after a player
> deletion is an open policy question (`s4-deletion-decision.md` §4 "messages — review"), so no `players(id)`
> CASCADE/RESTRICT is encoded — the Founder confirmed D-B, the storage-only reading: today's explicit deletion of
> the deleted player's threads, guardian–club threads included, is reproduced inside the deletion unit, and that
> confirmation decides no future retention policy; (3) the ledger row every send writes stays a blob until the S6
> `ledger` table, which waits for S4b, so the "no whole-database write on send" objective is narrowed by S7d, not
> met (review §7.3, §11.2, §11.9 — the benchmark shows the ledger blob still rewritten on every save).

- **Objective.** The nine S7 collections become tables in four sub-steps, each independently
  testable and rolled back copy-only without loss: **S7a** `notifications`,
  `notification_prefs`, `notification_pref_categories` (independently accepted at `0641b2c`); **S7b** `dispatches`,
  `dispatch_attempts` (independently accepted at `ac50b60`; review §9:
  `notification_id` as a plain reference — no foreign key, no cascade, today's deletion and its
  retained dispatch rows preserved, orphan references counted not refused; migration
  `0010_dispatches`, so the `0010_recruitment` placeholder below moves when S8a is approved);
  **S7c** `outbox` (two writer shapes unified under a structural `source` discriminator, the
  destination any JSON value — `to_address` / `to_json` — null included), `push_log`, `push_tokens` (any
  JSON token value stored losslessly; the route's matching rule; no uniqueness constraint; a non-finite
  number kept live and persisted as null, as the blob's JSON did) — storage move only, the staff-push
  re-keying (defect 10 of the schema document) a behaviour change carried through unchanged;
  **independently accepted at `9119187`, migration `0011_outbox_push`** (review §10.12; the three design
  assumptions the review of `6ca66ba` corrected are recorded in §10.3/§10.4/§10.7 and the two correction
  rounds in §10.10/§10.11 — none was a product decision); **S7d** `channels`, `messages`,
  `message_attachments` — **IMPLEMENTED on top of `b67bce5`, migration `0012_channels`, PENDING INDEPENDENT
  ACCEPTANCE** (review §11.5 as corrected in §11.7/§11.8 and implemented as recorded in §11.9: storage-only, the
  §2.3 transitional code-checked request reference (D-A approved), today's deletion reproduced inside the unit
  (D-B confirmed — a scope confirmation, not a retention decision), no player- or request-lifecycle
  CASCADE/RESTRICT — the `org_id` RESTRICT and the internal message/attachment cascades remain, `guardian_id`
  checked in code at open and on every identity, channel or request snapshot write (a bounded choice, with the
  deferred-foreign-key alternative stated) —, every present legacy field preserved in `extra_json` and absent
  optional keys preserved as absent (`absent_keys_json`), final-state validation of partial snapshots in both
  directions, channel-list and message order kept as `seq` and `position`). The
  whole-database-write objective is met in phases measured by a synthetic benchmark (review
  §7.3), not claimed by any single sub-step — S7d alone leaves the `ledger` blob (and, on the acceptance
  path, `requests` and `trials`) in every send's save (review §11.2).
- **Depends on.** S4a (live identity tables) for every sub-step; **S4b** for any `players(id)`
  reference and for the S6 ledger (S7d as prepared carries `player_id` without a reference clause,
  as `pairing_codes` does, so it does not wait for S4b — review §11.4); **S8a** (or the approved
  transitional design, decision D-A) for `channels.request_id`; nothing else for S7a–S7c. "Depends on
  S4" in the earlier text did not establish that S4a alone suffices; it does not.
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

> **S8a-core is implemented** (22 October 2026, migration `0015_recruitment`, on the design of §D.7 accepted at
> `d0f0205` under Q7a/Q7b/Q7c) and **awaits independent acceptance** — §D.8. S8b, S8c and S8d are not started. The
> bullets below are the original plan of the whole step and are kept as written.

- **Objective.** Requests, trials, cases and rooms, decisions and snapshots, contacts,
  offers, signing packages, signings, follow-ups and outcome reports live; the shared
  `idempotency_keys` table replaces every `keys{}` structure; `players[].trialReports`
  retired (served from `trial_reports`).
- **Depends on.** S5, S6 (ledger rows for signings), S7c (the `outbox` rows that
  `recruitmentContacts[].emailCopy.outboxId` references — "contacts' outbox copies"), and
  the two unresolved relational-integrity decisions below, which must be closed **before
  S8a's migration is written**, not during it. Note the cross-reference with S7: the proposed
  `channels.request_id → recruitment_requests` meant S7d needed S8a or the transitional design
  in the S7 review §2.3, while S8c needs S7c (accepted). S7a, S7b and S7c are accepted; S7d is
  implemented with the transitional reference the Founder approved (D-A; review §11.9, pending independent
  acceptance), so S8a now inherits the rebuild of `channels` with the real foreign key after its own
  preflight (true by construction if the transitional validation has held). Going S8a-first would not have removed the `recruitment_cases`
  dependency: `recruitment_requests.case_id` and `trials.case_id` reference a table of S8b, so S8a
  either carries those two columns as validated references without foreign keys (a transitional device
  of the S7 review §2.3 kind, needing its own approval) or grows to S8a+S8b; the request–trial pair
  itself needs no such device — both tables arrive in S8a and their mutual foreign keys can be
  enforced from the start (review §11.1, §11.3, corrected in §11.7 after the independent review of
  `46e5afe`). **S7d is accepted at `4f954ad` (18 October 2026)**; the S8a dependencies as they stand in the
  code — player tombstones, organisation lifecycle, the two `case_id` references to S8b, the conversion of
  the approved `channels.request_id` check into a real foreign key — are tabulated in §D.3 with the two
  approvals S8a would need (Q7a, Q7b). The sequence after S7 is decided when a step is authorised:
  - *Player tombstone (schema O1 — partially resolved on 12 October 2026; **S4b NOT implemented** when this was written — S4b-R, the retained player record, is implemented and independently accepted at `9b109dc` since 21 October 2026; what that changes for S8a, and what it does not, is §D.7).*
    `02_recruitment.sql` today declares no foreign key on any `player_id` because
    `deletePlayerData` hard-deletes the player row — and it still does: S4a kept today's deletion
    unchanged, and S4b (the tombstone rewrite) is not built. The Founder chose the full birth date
    for the retained record; the country-code and child-status questions stay open
    (`s4-deletion-decision.md` §10), and S4b cannot finish without the country-code answer. When
    S4b ships the tombstone row, S8a then amends `02_recruitment.sql` to add `REFERENCES
    players(id) ON DELETE RESTRICT` on every `player_id` column and ships that DDL in its
    migration (the `0010_recruitment` identifier below is a placeholder — `0010` is taken by
    `0010_dispatches`; S8a takes the next free number when approved). Until S4b has shipped and
    the file has been amended, the recruitment domain is **not ready to cut over**; the design is
    unresolved on this point, not finished.
  - *Org deletion policy (schema O2).* `org_id` columns in file 02 are `RESTRICT` on the
    assumption that no org deletion route exists. S3 shipped **without** one (no
    `deleted_at`, no hard delete; `suspended` is the only lifecycle flag, and `org_users`
    already enforces `RESTRICT` in practice), so the assumption still holds; the Founder's
    answer on open recruitment cases decides whether S8 keeps `RESTRICT` or adds a
    tombstone-aware rule.
- **Files / tables.** `repositories/recruitment/*.mjs` (one module per aggregate), migration
  `0010_recruitment` (a placeholder identifier: `0010` is `0010_dispatches`; the real number is
  assigned when S8a is approved); `server.mjs` requests/trials routes (2068–2371, 2612), `m12/scouting.mjs`
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
- **Files / tables.** `repositories/scouting/*.mjs`, migration `0011_scouting` (a placeholder: `0011`
  is taken by S7c's registered `0011_outbox_push`, review §10.5 — this stage takes the next free number
  when it is approved, as `0010_recruitment` did); `m12/passport.mjs`,
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
  migration `0012_verification_passport` (a placeholder: `0012` is `0012_channels`; the real number is assigned at approval, §D.6); `m14/*`, `m15/*`, `m13/transitions.mjs`,
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
- **Files / tables.** `repositories/agent/*.mjs`, migration `0013_agent_compliance` (a placeholder: `0013` is `0013_safety_audit`; the real number is assigned at approval, §D.6);
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
  `repositories/discovery/*.mjs`, migration `0014_development_discovery` (a placeholder; the real number is assigned at approval, §D.6); `m12/journeys.mjs`,
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
- **Files / tables.** `repositories/operations/*.mjs`, migration `0015_operations` (a placeholder; the real number is assigned at approval, §D.6);
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

---

## D. The next implementation stage — current findings and the decisions required (19 October 2026, from the code at `4f954ad`)

**Status.** All four S7 sub-steps are independently accepted (S7d at
`4f954ad92cda6ca5178cc6c3d5485265684e0c03`, 18 October 2026, `s7-readiness-review.md` §11.11). That
closes the communications storage stage only: `ledger`, `requests`, `trials`, `recruitmentCases` and every
other blob collection are still rewritten by every save (review §7.3), nothing is production-approved, and
S4b, the eight S6 audit tables and S8 are not started. This section is documentation only: a read-only
reading of the code at `4f954ad` against the existing decision records (`s4-deletion-decision.md` §10,
`s4-readiness-review.md` §9/§11, `s6-readiness-review.md` §3–§4/§9, `s7-readiness-review.md` §11.3–§11.4
and §8.1), narrowed to what is needed to choose the next safe stage. It replaces no earlier record; where an
earlier section of this plan still says "waits for S4b" without qualification, this section is current.
**§D.5 is the one Founder decision list; every other document links here rather than restating it.** **Refreshed
21 October 2026 after the acceptance of S6b at `f0abd34` (§D.6: S4b-R, since built and accepted) and again after the
acceptance of S4b-R at `9b109dc`: §D.7 is current for the next step and the decisions it needs (Q7a, Q7b, Q7c); §D–§D.6
stay as the dated record.**
Nothing here decides a retention period, infers compliance from a development choice, or reopens the
Founder's recorded choices (the full birth date; D-A; D-B; the legacy-minor rule).

**Corrected 19 October 2026 after the independent review of `6956f52`** (`review-6956f52-summary.txt`; its
design-check script `review-6956f52-design-checks.mjs` runs unchanged on this tree, exit 0, and verifies the
engine and store facts below on synthetic databases — design premises, not regressions in the accepted S7
code). Three defects of the first version are corrected in place: **F1** the proposed foreign keys to
`players(id)` and `guardians(id)` need **identity-snapshot compatibility**, not only an account-deletion
policy (§D.2, new §D.2a, §D.3, §D.4); **F2** moving the `ledger` and the other audit blobs does **not** meet
the no-whole-snapshot-write objective for a message send — the save still serialises every remaining blob
(§D.4 Candidate A, the recommendation, Q4); **F3** Candidate A no longer contradicts Q2: it is a
behaviour-preserving stage that **defers** child-status stamping and leaves Q2 OPEN, with the later additive
step described (§D.4, §D.5). The decision list is reduced to what the proposed next step needs; the other
questions are recorded, not demanded.

**Corrected again 19 October 2026 after the independent review of `e7f7692`** (`review-e7f7692-summary.txt`;
its design-check script `review-e7f7692-design-checks.mjs` runs unchanged on this tree, exit 0: three
in-memory engine checks and one check on the real player repository, unit of work and save). Two P2 defects of
the second version are corrected in place; S7 acceptance is unchanged and nothing is implemented. **F1** §D.2a
Alternative A claimed that `PRAGMA defer_foreign_keys` defers *every* foreign-key action and so preserves every
child across the identity DELETE/reinsert. It defers **enforcement of `RESTRICT`** only (the withdrawn claim
that RESTRICT cannot be deferred stays withdrawn); **`ON DELETE SET NULL` nulls the child's reference and
`ON DELETE CASCADE` deletes the child row at the parent's DELETE**, reinserting the parent undoes neither, and
COMMIT and `PRAGMA foreign_key_check` succeed in all three cases — a clean final check proves nothing about
preservation. §D.2a is now action-aware: the deferral design covers the drafted `RESTRICT` references exactly;
every `SET NULL` or `CASCADE` child of `players`/`guardians` needs a design that **preserves the parent rows**
or **reconstructs the children from the intended snapshot**, chosen when first needed, with exact-row tests.
**F2** Candidate A asked the five player-audit references to be refused when a parent is missing *and* to
import and preserve the ids of deleted players; the same row was required to pass and to fail (the reviewer's
check deletes a synthetic adult through the real repository with its ledger row retained, reopens, and saves an
unchanged snapshot — today it succeeds; a model of the strict rule rejects it). §D.4 now carries **one
per-reference contract**: the five historical player-audit references are **tolerant** (an unresolved id is
counted, never refused, never given a fabricated parent, never deleted), the `idv_queue` guardian reference is
**strict** (the `channels.guardian_id` pattern), and import, new writes, updates, account deletion, snapshots,
backup/restore, rollback and re-upgrade are specified for each; Q4 and Q4b are reworded to match. The S7
review's last stale §8.1 row is aligned with its corrected §7.3.

### D.1 S4b — what the code does today, what remains to build, what still needs an answer

**Today (file/line, `scoutbox-server/`).** `deletePlayerData` (`server.mjs:4245–4305`) is one unit of work
(`unit(`, :4257): media file ids queued (:4258), sessions revoked (:4259), the child's pairing code revoked
(:4260), **the player row hard-deleted** (`players.remove`, :4261 → `repositories/identity.mjs:768–779`:
`DELETE FROM players`, the S5 child rows and the `guardian_children` links cascade, every guardian's
`childIds` spliced at :775), requests and trials rewritten as id-only tombstones (:4268–4269;
`tombstoneRequest` :4222–4243, `tombstoneTrial` :4169–4219), names nulled on cases (:4270–4272),
assessments (:4273), contact responses (:4274–4276) and open-trial registrations (:4277–4279), the m24, m25,
m26, m28 and m29 hooks (:4282–4290), the player's threads deleted through the channels repository
(:4295, D-B), the player's notification rows deleted with the preferences retained (:4296), the ledger rows
left as they are (:4299); the files are removed after COMMIT (:4303). Routes: `DELETE /player/account`
(:4309–4313, adults) and `DELETE /guardian/children/:id` (:4323–4327). **Not touched by a deletion today:**
device push tokens (no `deleteFor` on the push-token repository; `adapters.mjs:152` still reads them by
audience), `outbox`/`pushLog` rows, `blocks`, `reports`, `moderationLog`, `orgNotes`, `idvQueue`,
`sourceChanges` (`s6-readiness-review.md` §3), the names kept in `signings`, `invoices`, `vouches` and squad
entries, the ledger's message-row names (`s4-deletion-decision.md` §5). The columns S4b would write exist and
are written by nothing: `players.deleted_at` (`docs/architecture/sql/01_identity.sql:195`) and
`guardians.deleted_at` (:128).

**What remains to build for S4b (technical, needs no new answer).**

1. `players.erase(id)` in `identity.mjs`, called at `server.mjs:4261` in place of `remove`: the row kept
   with `deleted_at`, `name` replaced, `birth_date` kept (decided), every other personal column nulled, the
   facets cleared; the twelve `player_*` rows and the `guardian_children` rows deleted **explicitly** (today
   they cascade with the row; a retained row cascades nothing) and `childIds` spliced as :775 does.
2. **Every reader excludes tombstones by default.** `findPlayer` (`server.mjs:687`) has about forty call
   sites in `server.mjs` and the modules read the players view in about one hundred and sixty places (a
   textual count of `findPlayer(` / `players.byId(` / `db.players`); the repository view must stop listing
   retained rows and expose them through one explicit accessor, and every list, count, directory and
   allowlist view must be re-asserted against that (the S4a allowlist tests, `s4-readiness-review.md` §9
   item 11, are the template). This is the bulk of S4b's surface.
3. The name snapshots on retained records replaced in the same unit where today's code leaves them
   (`s4-deletion-decision.md` §5 "Recruitment records": `recruitmentCases.history[].byName`, offer and
   package guardian names, `applications`, `campaignSubmissions`, `squadInvites`, `transitionCases`,
   `evidenceSuggestions`).
4. The per-table lifecycle statements for the three identity tables, the readiness tests at the age
   boundaries (`s4-deletion-decision.md` §7 notes — their expected answers wait for Q1 below), the
   copy-only rollback (§D.4) and the S5 tool's refusal of the new schema step.

**What still needs the Founder (details and options in §D.5).** Q1 the country code on the retained row
(`players.country` is `NOT NULL`, `01_identity.sql:158` — dropping it means a column rebuild, keeping it a
retention choice; it decides the threshold `wasMinorOn` applies and the erase method's exact column set);
Q3 the ids of players deleted **before** S4b that audit rows already carry (today's documented dangling
state, `s6-readiness-review.md` §3) — no retained row can be synthesised for them without fabricating the
`NOT NULL` name, birth date and country (:156–158), so the S4b foreign-key rebuild of the audit tables can
only go ahead with a decided treatment; Q6 the behaviour changes the decision record proposes beyond the
retained row (deleting the subject's push tokens, verification tokens and passport shares; nulling dangling
media ids; one ledger row recording the deletion — §8 item 9) — each is new behaviour, not a storage move,
and is not implied by S4b. The child-status stamp (Q2) is an S6 column decision, not an S4b item; nothing of
S4b depends on it, but a reviewer of a deleted player's safeguarding row depends on both Q1 and Q2 together
(`s4-deletion-decision.md` §10, last table row).

### D.2 S6 — the eight audit tables: which truly wait for S4b, and which "dependencies" are design choices

| Table (DDL `03_messaging_safety_audit.sql`) | Identity reference as drafted | Writers today (`server.mjs` unless stated) | What the drafted foreign key waits for |
|---|---|---|---|
| `blocks` (:626) | `player_id … REFERENCES players(id) ON DELETE RESTRICT` (:628) | insert :1762, :1801, :3991; **lift = hard delete** (`splice`, :4534) | **S4b** (account deletion) **and §D.2a** (snapshot replacement); the table itself waits for neither |
| `reports` (:670) | `target_player_id … RESTRICT` (:679) | insert :1155, :1790; status update :1803, :4461 | S4b and §D.2a — for the foreign key only |
| `org_notes` (:762) | `player_id … RESTRICT` (:765) | insert :2113 | S4b and §D.2a — for the foreign key only |
| `ledger` (:823) | `player_id … RESTRICT` (:827) | `ledgerAppend` :691–695 (one push; ~45 call sites) | S4b and §D.2a — for the foreign key only |
| `source_changes` (:887) | `player_id … RESTRICT` (:889) | `m181/sourceChanges.mjs:44`; cap of 20 000 by `splice` (:47) | S4b and §D.2a — for the foreign key only |
| `moderation_log` (:725) | none, by design | insert :1151 | **nothing** (authorisation) |
| `ops_events` (:857) | none (no person) | :1974; `m13/delivery.mjs:151`; `m13/enterprise.mjs:341, 445, 515, 519` | **nothing** (authorisation) |
| `idv_queue` (:994) | `guardian_id … REFERENCES guardians(id) ON DELETE RESTRICT` (:996) | insert :1440; status update :4523 | **§D.2a** — no guardian deletion route exists, but the identity snapshot deletes and reinserts every guardian row, so the drafted key fails an unchanged snapshot (verified); **not** "nothing but authorisation" as the first version of this section said |

**What is unavoidable and what is a choice — two engine facts, then choices.** *Fact 1 (account
deletion):* a `RESTRICT` reference to `players(id)` needs a row to point at after a deletion, and today's
deletion removes the row (`s6-readiness-review.md` §4.1) — the foreign key on the five player-referencing
tables waits for S4b. *Fact 2 (whole-snapshot replacement — the dependency the first version of this section
missed, reviewer's F1):* every snapshot-mode save (a restore, a snapshot tool, the persistence suites, any
`store.save` in tool mode) rewrites the identity pair by **deleting and reinserting** every row
(`IDENTITY_SNAPSHOT.replace`, `repositories/identity.mjs:205–207`: `DELETE FROM guardian_children; DELETE FROM
players; DELETE FROM guardians;` then the candidate rows) and runs `PRAGMA foreign_key_check` immediately after
(:225). With `PRAGMA foreign_keys = ON` (`store.mjs:104`) and an immediate `RESTRICT` child — a retained
`idv_queue` row naming a guardian, or a retained `ledger` row naming a **live** player — the `DELETE` is refused
at once and **saving an unchanged, valid snapshot fails** (the reviewer's design check installs the drafted DDL
in a disposable database and calls the real writer: `FOREIGN KEY constraint failed`, the save revision does not
advance, the parent and child rows survive; removing the child table makes the same save succeed; the ledger
case fails with the player still alive). A guardian "never deleted by a route" is deleted in storage on every
snapshot write; **a tombstone solves account deletion and nothing of snapshot replacement.** The S7 review
reached the same fact for `channels.guardian_id` (§11.8) and chose the code-validated reference. Account
deletion policy and whole-snapshot replacement are therefore two different dependencies, and both bind
wherever a foreign key to `players(id)` or `guardians(id)` is introduced — §D.2a. *Choices:* (i) the five
player-referencing tables and `idv_queue` **can** be created now with the reference column indexed and **no**
`REFERENCES` clause, reproducing today's dangling-id state exactly (§4.1's "proposed implementation"); SQLite
cannot add a foreign key with `ALTER TABLE`, so a later migration rebuilds the table (create–copy–drop–rename,
the S4a/S5 pattern) once §D.2a is in place — a known cost, not a blocker. That shape is a transitional device of
the D-A kind and **needs the Founder's explicit approval**: Q4 for the player references, and — because Q4 as
worded covers players only — a separate approval for the guardian reference of `idv_queue` (Q4b); neither is
approved by anything recorded so far. (ii) The "append-only" treatments the S6 review proposed
(`lifted_at`/`lifted_by` on `blocks` instead of the delete at :4534, §4.2) are **behaviour changes**;
preserving present behaviour means the block lift stays a row `DELETE` unless the Founder approves the change
(Q5). The status updates on `reports` and `idv_queue` and the `source_changes` cap are today's behaviour and
stay. (iii) Only `moderation_log` and `ops_events` wait for nothing but authorisation. (iv) The write-time
child-status stamp (D2) is a product decision (Q2); no column is reserved for it, and a step may defer it
(§D.4) — deferring is not answering.

#### D.2a Identity-snapshot compatibility — required wherever a foreign key to `players(id)` or `guardians(id)` is introduced

**Where it binds, by action (corrected after the review of `e7f7692`).** Snapshot compatibility is a property
of each reference's `ON DELETE` action, not of foreign keys in general. The drafted DDL at `e7f7692` (a count of
the `ON DELETE` clauses naming `players(id)` or `guardians(id)` in files 02–08; `sqlite-schema.md` §10's "48
references" was counted at an earlier revision and the per-action counts here supersede it):

| Action | References to `players(id)` | References to `guardians(id)` | What the identity DELETE/reinsert does to the child with `PRAGMA defer_foreign_keys = ON` |
|---|---|---|---|
| `RESTRICT` | 12 — the five audit tables (file 03: `blocks` :628, `reports` :679, `org_notes` :765, `ledger` :827, `source_changes` :889), 3 in file 04, 4 in file 05 | 1 — `idv_queue.guardian_id` (03:996) | enforcement is **deferred to COMMIT**; the child row is untouched; a reinserted parent satisfies it (S7 review §11.8 (b); re-verified by `review-e7f7692-design-checks.mjs`, child `{c, p}` before and after COMMIT) |
| `SET NULL` | 6 — 1 in file 04, 2 in file 05, 3 in file 07 | 7 — 5 in file 02 (`recruitment_requests.guardian_id` :537 among them), 1 in file 05, 1 in file 08 | the reference is **nulled at the parent's DELETE**; reinserting the parent does not restore it; COMMIT and `foreign_key_check` succeed (verified: child `{c, null}`) |
| `CASCADE` | 28 — 4 in file 04, 5 in file 05, 18 in file 07, 1 in file 08 (the S5 `player_*` tables are already live under this action) | 0 | the child row is **deleted at the parent's DELETE**; reinserting the parent does not restore it; COMMIT and `foreign_key_check` succeed (verified: child table empty) |

Not in the table: `recruitment_requests.player_id` (02:511) and `trials.player_id` (:634) carry no key by
design (§D.3); `pairing_codes.player_id` (S6a) and `channels.guardian_id`/`request_id` (S7d, D-A) are
code-validated. Where it binds: the five player-referencing audit tables and `idv_queue` (above); S4b's own
rebuild that would add `REFERENCES players(id)` to them; S8a's file-02 columns; and every reference in the
table. **S4b by itself does not make any of these keys ready**: it changes what account deletion does to a row;
the identity snapshot still deletes and reinserts every row. The S5 `player_*` tables show how the codebase
already lives with `CASCADE` under that rewrite: the identity replace lets the child rows cascade and **writes
them again from the snapshot's records after the parents** (`identity.mjs:201–204`, `:220–223`) — design A3
below, built once for one owner-scoped group whose rows the snapshot always carries. One of the designs below
must be built first or alongside each introduction, **chosen per reference by its action**, and recorded per
table.

**Alternative A — coordinated snapshot writing: deferral for the `RESTRICT` references, and an explicit
parent-preserving or child-reconstructing design for every `SET NULL` and `CASCADE` reference.**

*A0 — the deferral (covers the `RESTRICT` row of the table above exactly: the 12 player references and the one
guardian reference; nothing else).* (1) The snapshot-mode write transaction sets `PRAGMA defer_foreign_keys =
ON` right after `BEGIN` (`store.mjs` `write()`/`writeBody()`; the pragma is per transaction and resets at COMMIT
or ROLLBACK; the one occurrence today, `store.mjs:403`, is the test seam `failCommitOfOpenTransaction`, not the
writer). With the pragma on, the engine defers **enforcement of `RESTRICT`** to COMMIT, so a parent deleted and
reinserted inside the transaction commits with its `RESTRICT` children intact — the engine fact verified by the
`8330f08` probe (S7 review §11.8 (b)) and again by `review-e7f7692-design-checks.mjs`; the withdrawn claim that
RESTRICT cannot be deferred stays withdrawn. **The pragma does nothing for `SET NULL` or `CASCADE`:** both are
referential *actions*, executed at the parent's DELETE whatever the pragma says — the child's reference is
nulled, or the child row is deleted — and reinserting the parent undoes neither (verified by the same script:
`{c, null}` and an empty child table after COMMIT, with `foreign_key_check` clean in both cases). The first
version of this paragraph said the pragma defers "every foreign-key action"; **that is withdrawn.** **A
`DEFERRABLE INITIALLY DEFERRED` declaration alone is not a design:** with the pragma off, RESTRICT still refuses
at the DELETE whether or not the column is declared deferrable (§11.8 (a)); the pragma, not the declaration, is
what makes the rewrite legal for a `RESTRICT` child. (2) The early check at `identity.mjs:225` is narrowed to
the identity tables (`PRAGMA foreign_key_check(players)`, `(guardians)`, `(guardian_children)` and the S5 child
tables — SQLite accepts a table argument), because a `RESTRICT` child the same snapshot also removes is written
or pruned **after** the identity group in the dispatch order (`repositories/index.mjs:143–`: orgs → identity →
staff/sessions → media queue → channels → prunes → codes → notification group → the channel final-state
assertion) and would otherwise be a false orphan at that moment (§11.8 (d)). (3) One whole-database `PRAGMA
foreign_key_check` at the end of `writeTableBacked`, before COMMIT, so a genuine `RESTRICT` orphan — a retained
child whose parent the snapshot removed — is refused with table and ids (never a value) instead of the engine's
bare `FOREIGN KEY constraint failed` at COMMIT; a refusal rolls the whole save back, unrelated collections
included. **That check detects dangling `RESTRICT` references and nothing else: a nulled `SET NULL` reference
and a cascaded row both leave a consistent database, and no final check of any kind restores data.** (4) The
unit-of-work path is unaffected (no unit deletes and reinserts the identity pair; account deletion under live
`RESTRICT` children remains the S4b dependency of fact 1). (5) The copy-only rollback tools already run their
rebuilds with `PRAGMA foreign_keys = OFF` and check at the end (`coreIdentityRollback.mjs:188–223` and the S5–S7
tools), so they are unaffected; the previous build has no such child tables after the rollback.

*A1–A3 — for every `SET NULL` and `CASCADE` reference (the 6 + 7 `SET NULL` and the 28 `CASCADE` references
above).* One of three bounded designs, **chosen when the first such key is introduced and recorded per table**;
none is chosen here, and none is an unbounded persistence rewrite. **A1 — preserve the parent rows:** the
identity snapshot replace stops deleting and reinserting and instead **upserts the candidate rows and prunes
the rows the snapshot no longer lists** (the organisations' pattern, which is why `channels.org_id RESTRICT`
works today, and the constraint §D.3 already records for `recruitment_requests`). A parent that survives is
never deleted, so no action fires for its children; a parent the snapshot removes has its children nulled or
deleted **by intent**. Cost: the identity replace was made order-independent for removed-e-mail reuse,
e-mail swaps between retained guardians and co-guardians listed before their primary (`identity.mjs:196–200`;
`s4-readiness-review.md` §9 item 12); an upsert-and-prune replace must reproduce every one of those cases with
`UNIQUE` columns changing hands in one statement order — a bounded rewrite of one writer, re-asserted by the
existing identity suites. **A2 — enforcement off for the snapshot write only:** `PRAGMA foreign_keys = OFF`
**before** `BEGIN` (the pragma is a no-op inside a transaction — the rollback tools' pattern) for snapshot-mode
saves, a whole-database `PRAGMA foreign_key_check` before COMMIT, `ON` again after. No action fires, so every
child survives the parent's DELETE/reinsert as it is; the S5 child rewrite (`identity.mjs:220–223`) then relies
on **its own explicit deletes** rather than the cascade, and every other cascade the snapshot write relies on
becomes an explicit statement. Cost: a store-level mode switch the server mode must never take, and a suite
proving it is off only for the snapshot write. **A3 — capture and rewrite the retained children** (the S5
precedent, `identity.mjs:201–204` and `:220–223`): before the identity DELETE, read every `SET NULL`/`CASCADE`
child row the snapshot **retains** — including the rows of child collections the partial snapshot **omits**,
which the partial-snapshot contract says are kept as they are — and reinsert them after the parents with their
reference values as captured; the children of a parent the snapshot removes are dropped or nulled by the same
intent as today's cascade. Cost: one capture-and-rewrite step per child table group, growing with every new
`CASCADE`/`SET NULL` key; the S5 group already pays it. **Scope and cost of A:** A0 is three changes to
existing persistence code outside the new table group (`store.mjs`, `repositories/index.mjs`,
`repositories/identity.mjs`), every snapshot-mode suite (`testCoreSchema`, `testCoreIdentityMigration`,
`testIdentityRepositories`, `testMediaDeletions`, the S6a and S7 suites, the persistence and backup/restore
server tests) re-asserted, and the checks below written first; A1–A3 add the chosen design's cost. Once built,
every later `RESTRICT` key to the identity tables rides on A0; every later `SET NULL`/`CASCADE` key needs the
A1–A3 choice already made.

**Alternative B — an explicitly approved transitional checked reference (the D-A kind), per table, in one of
two stated forms.** The reference column carries no `REFERENCES` clause and no action; the identity
DELETE/reinsert cannot touch it, so snapshot compatibility is free and the question becomes **what the code
promises about the value**. *B-strict (a live reference):* the repository refuses a write naming a missing
parent, the cutover migration's preflight refuses a blob entry naming a missing parent, and a final-state
assertion runs at every snapshot write that touched either side (the `assertChannelReferencesConsistent` /
`assertPairingCodesConsistent` pattern, `repositories/index.mjs:185` and the S7d assertion, triggered on
identity rewrites too — §11.8's corrected trigger). Precedents already accepted on this branch:
`pairing_codes.player_id` (S6a, chosen for exactly this rewrite — `03_messaging_safety_audit.sql` header),
`channels.guardian_id` (S7d, §11.8), `channels.request_id` (D-A). It fits a reference whose parent the writers
and readers **require to exist today**. *B-tolerant (a historical reference):* the column is **shape-validated**
(a non-empty string of the id form, or `NULL` where the collection allows it) and indexed; the import **counts**
unresolved ids per table and imports the rows as they are; a snapshot write validates shape and uniqueness and
**reports** the unresolved count as a diagnostic (ids only), never a refusal; **no** final-state assertion
against the parent table; nothing is fabricated for an unresolved id and no row is deleted because of one. It
fits a reference whose rows are kept **on purpose after the parent is gone** — today's audit rows after an
account deletion (`server.mjs:4299`). The two forms are not mixed on one column, and "code-validated" without
the qualifier is not a specification (the second version of this section used it for both and so required the
same row to pass and to fail — the reviewer's F2); §D.4 assigns the form per reference for Candidate A.
**Scope and cost:** one assertion (strict) or one counter (tolerant) per table group and no change to the
store; a foreign key arrives later only through Alternative A — and, for a tolerant reference, only after a
decided treatment of the unresolved ids (Q3) — and a table rebuild. Each use is a separate approval (Q4 for the
five player references, Q4b for the `idv_queue` guardian reference, Q7 for file 02); nothing here widens D-A or
Q4 by implication.

**Required checks, whichever design a step takes (written first, failing on the tree before the step; every
check asserts exact child rows and exact reference values — never a count alone, never a clean
`foreign_key_check` alone).** (a) An **unchanged** valid snapshot saves and advances the revision with the new
table populated **row for row**. (b) A **retained parent referenced by retained** children survives a snapshot
that keeps the parent — run once with the child collection **omitted** (the partial-snapshot contract: the rows
are kept as they are) and once with it **supplied and repeated** — and every child row and reference value is
identical afterwards; for a `SET NULL` or `CASCADE` child this is the check that fails under A0 alone. (c) An
**intentional deletion or replacement under the lifecycle contract** — the snapshot removes a parent and its
children are removed, nulled or refused exactly as that table's contract says — produces exactly the documented
final rows. (d) **Domain-specific:** for a strict reference (A0's `RESTRICT` key, or B-strict) a snapshot that
removes a parent while **retaining children that name it** is **refused atomically** with ids only — no row
changed, revision unchanged, unrelated collections untouched; for a tolerant reference (B-tolerant) the same
snapshot is **accepted**, the child rows and their ids are unchanged, and the unresolved count is reported.
(e) An injected **failure before COMMIT** (a statement seam and the real COMMIT) leaves every table and the
revision unchanged, and the retry lands everything. (f) **Backup and restore** through the admin backup and a
restore into a new directory, and the **previous-build rollback copy and re-upgrade**, carry every parent and
child row and reference value — unresolved ids included for a tolerant reference. For Alternative A, (a)–(d)
also run with the pragma (A0) or the chosen A1–A3 mechanism deliberately off to prove the suite detects its
absence; for Alternative B, (d) is the assertion's refusal (strict) or the counter's report (tolerant).

### D.3 S8a — the dependencies as they stand

| Dependency | Today (file/line) | What S8a needs | Decision? |
|---|---|---|---|
| Player tombstones and deletion policy | `recruitment_requests.player_id` (`02_recruitment.sql:511`) and `trials.player_id` (:634) carry **no** foreign key by design; `deletePlayerData` rewrites both as tombstones in place (`server.mjs:4268–4269`) | the tombstone rewrites become repository updates inside the deletion unit; the two columns gain `REFERENCES players(id) ON DELETE RESTRICT` **only after S4b and with §D.2a in place** (schema §10 O9 — S4b alone leaves the snapshot DELETE/reinsert of `players`), or ship as today (no FK) — a validated-reference device needing its own approval | **yes**: S4b and §D.2a first, or approve the no-FK shape for file 02 (Q7a) |
| Organisation lifecycle (O2) | no route or repository method deletes an organisation (`repositories/orgs.mjs` has no remove; `suspended` is the only flag — `server.mjs:491, 509, 1054`); `org_id … RESTRICT` on requests (:513) and trials (:636) | nothing for S8a as the code stands: a `RESTRICT` reference nobody deletes from changes nothing. O2 decides only a **future** org-deletion route | no (recorded, not blocking) |
| Case references to S8b | `recruitment_requests.case_id` (:539) and `trials.case_id` (:633) reference `recruitment_cases` (:138, an S8b table); `caseId` is set by the case writer (`m12/scouting.mjs:460` and the eight `caseId` sites in `server.mjs`) | either S8a grows to S8a+S8b (`recruitment_cases` and its thirteen child tables, :138–401), or the two `case_id` columns ship as code-validated references without a foreign key until S8b rebuilds the tables — the D-A kind of device, **not** approved by D-A | **yes** (Q7b) |
| The approved transitional `channels.request_id` | checked in code at open (`repositories/channels.mjs:613–616`), at import (:512), at every snapshot write (`CHANNELS_TABLE.replace` :491 and `assertChannelReferencesConsistent` in `repositories/index.mjs`) | S8a's migration rebuilds `channels` with `request_id … REFERENCES recruitment_requests(id) ON DELETE RESTRICT` after its own preflight proves every `request_id` resolves — true by construction if the check has held; requests are never deleted today (tombstoned in place), so `RESTRICT` encodes nothing new for the routes. **Snapshot compatibility applies here too (§D.2a):** once `channels.request_id` is a live immediate `RESTRICT` child, the `recruitment_requests` snapshot replace must **upsert and prune** (the organisations' pattern, which is why `channels.org_id RESTRICT` works today) rather than delete and reinsert like the identity pair, or Alternative A must be in place. `contact_channel_id` (:538, "no FK" per :499) can become a real reference to `channels(id)` in the same migration since `channels` is now a table, under the same condition for the channels replace (which already deletes and rewrites rows, `CHANNELS_TABLE.replace`) | no new approval (D-A approved the conversion); a design constraint on S8a's replace, recorded |
| Size | 55 tables in file 02; S8a (requests + trials) is 14 of them plus `idempotency_keys` (:74); fifteen `db.requests` and ten `db.trials` sites in `server.mjs`, `db.requests` read by fourteen other modules and `db.trials` by twenty-three (textual count at `4f954ad`) | the largest aggregate; the copy-only rollback must prove the tombstone shapes, slots, history, day/schedule containers and `keys` losslessly on the actual `4f954ad` build | — |

**No placeholder table and no silently approved reference.** S8a must not create an empty
`recruitment_cases` to satisfy a foreign key, and must not treat D-A (one column, one check, one table)
as approval for the `case_id` or `player_id` devices.

### D.4 The smallest coherent next implementation milestone — three candidates, one recommendation

The next free migration identifier **was `0013` at `4f954ad`** (taken since by `0013_safety_audit`; **`0014` is the
next free identifier at `f0abd34`, §D.6**) (`repositories/index.mjs:53` registers `0001`–`0012`
at `4f954ad`; the plan's older placeholders `0008_safety_audit`, `0010_recruitment`, `0011_scouting` are
withdrawn, §B). Every candidate below takes `0013` **only when approved**, and every rollback is **copy-only
and preserves all post-cutover writes** (the S5–S7 pattern: a tool that never touches the source, writes
rows back into the blobs the previous build reads, refuses a later schema, and is proven by booting the
actual previous build on the copy) — the old plan's "backup + previous commit, audit rows lost" rollback is
not a path (`s6-readiness-review.md` §7).

> **Update, 19 October 2026 — Candidate A is IMPLEMENTED (pending independent acceptance at the time; corrected at
> `f0abd34` and independently ACCEPTED on 21 October 2026, review §11.4–§11.5; the next step is §D.6).** The independent
> review of `1792fc7` accepted this brief; the Founder answered Q4, Q4b and Q5 (§D.5, recorded verbatim in
> `s6-readiness-review.md` §11); the implementation is one local commit on top of `1792fc7`: migration
> `0013_safety_audit`, `repositories/safetyAudit.mjs` (the plan's `audit.mjs`), the writers converted, the copy-only
> rollback `scripts/safetyAuditRollback.mjs`, the suites `scripts/testSafetyAudit.mjs` and
> `scripts/testSafetyAuditServer.mjs` (written first and failing on the unchanged `1792fc7` tree), the benchmark
> `scripts/safetyAuditPersistenceBench.mjs`. What was built, where it departs from the wording below and why, and
> the verification are review §11. The text of Candidate A below is kept as the specification the implementation
> followed (dated history).

**Candidate A — S6b, the eight audit tables with checked identity references, behaviour preserved,
child-status stamping deferred (the step proposed next; IMPLEMENTED 19 October 2026, see the update above).** *Prerequisites:* **Q4** (the five player
references as **tolerant** checked references — §D.2a Alternative B in its B-tolerant form; the contract below),
**Q4b** (the `idv_queue` guardian reference as a **strict** checked reference — B-strict, the
`channels.guardian_id` pattern; a separate approval, not implied by Q4), **Q5** (block lift stays a delete, or
the `lifted_at` change is approved). Needs nothing from S4b and **no answer to Q1, Q2, Q3, Q6 or Q7**.
*Q2 is deferred, not answered:* the tables are created **without** a child-status column; when the Founder
decides Q2, a later **additive** migration adds the nullable columns (`subject_minor`, the rule, the basis —
SQLite `ALTER TABLE … ADD COLUMN`, no rebuild) and the writers start stamping; every row written before that
migration reads "unknown" for the stamp (no value is manufactured for it), and a "no" leaves the tables
exactly as built. Deferral is this plan's proposal for the step's scope, not a decision on Q2. *Order:*
`repositories/audit.mjs` (eight mirrors, staged save hook, unit-of-work participation through the graph
memento — review §11.10/§11.12 — so no nested view goes stale), **one** final-state assertion (B-strict:
`idv_queue.guardian_id` against the FINAL `guardians`, triggered on identity rewrites too — the S7d trigger)
and **one unresolved-id counter per table** for the five player references (B-tolerant: a diagnostic in ids,
never a refusal — the contract below), migration `0013_safety_audit` importing the eight blobs (preflight:
`ledger` `userId`/`scoutName` kept verbatim, no actor kind derived — §2.5 of the S6 review;
`moderationLog.context` keys the columns cannot hold → `extra_json` or refusal; `opsEvents.kind` outside the
CHECK list → the two missing kinds added first, §2.6; the `idv_queue` guardian reference resolved against the
file's `guardians` — strict, an unresolved guardian id refuses the cutover with ids only, and none is expected
because the writer runs with the guardian resolved; the five player references **shape-validated only**, every
unresolved player id **counted per table and imported as it is**, with no claim about why it is unresolved —
today's state, Q3 untouched), every writer converted (`ledgerAppend`,
`handleReport`, the block routes, `moderateOrRefuse`, notes, the sweep's ops events, the m181 cap, the IDV
toggle), the admin backup, the snapshot dispatcher, `scripts/safetyAuditRollback.mjs` (rows → the eight blobs
one-to-one; nothing lost; the S7d tool refuses a `0013` file). *Acceptance (measurable, honest):* the two
S6-review suites plus the §D.2a checks (a)–(f) in the forms the contract below assigns (B-tolerant for the
five player references, B-strict for `idv_queue`), written first and failing on `4f954ad`, **including the
deletion round trip: a synthetic adult deleted through the real deletion unit with its ledger, report, note,
block and source-change rows retained, then the admin backup, a restore into a new directory, the `4f954ad`
rollback copy and the re-upgrade — every retained row and its now-unresolved id identical at each step, and an
unchanged snapshot save accepted after the deletion** (the state `review-e7f7692-design-checks.mjs` shows
succeeding today and a model of the strict rule rejecting); every route payload unchanged; `isBlocked` and the admin lift behave as today; the deletion unit
leaves the eight collections untouched as today; **the benchmark reports, before and after: the number of
`collections` rows upserted per save and their bytes — the eight audit blobs and their bytes leave every
save, and the remaining blob rows and bytes serialised per message save are reported as they are, not
claimed reduced; the median save time; atomicity and rollback (an injected failure leaves nothing)**; the
actual `4f954ad` build boots the rollback copy. *What it does not do:* no `players(id)` or `guardians(id)`
foreign key (Alternative A and a rebuild later), no child-status column (Q2 deferred), no retention rule,
**and it does not meet the no-whole-snapshot-write objective** — see the paragraph after the contract.

**Candidate A's reference contract — one statement per reference (corrected after the review of `e7f7692`;
§D.2a Alternative B supplies the two forms; the acceptance checks, Q4 and Q4b point here).** Two domains, not
one rule. **Domain P — the five historical player-audit references** (`blocks.player_id`,
`reports.target_player_id`, `org_notes.player_id`, `ledger.player_id`, `source_changes.player_id`):
**tolerant**. These rows are kept on purpose after the person they name is gone — today `deletePlayerData`
hard-deletes the player and leaves every one of them in place (`server.mjs:4261`, `:4299`) — so an unresolved
id is the documented state, not an error, and **an absent id alone proves nothing about why it is absent** (a
deletion, a pre-S4a import, a report naming a player that never existed): the contract never infers "deleted
person" from it. **Domain G — the `idv_queue` guardian reference** (`idv_queue.guardian_id`): **strict**, like
`channels.guardian_id`. No route deletes a guardian, the writer runs inside the guardian's own authenticated
unit with the row resolved (`server.mjs:1436–1445`, `req.guardian`), and the admin toggle finds the entry by
the same id (`:4523`); a dangling guardian id would be a defect and is checked as one.

| Boundary | Domain P — the five player-audit references (tolerant) | Domain G — `idv_queue.guardian_id` (strict) |
|---|---|---|
| Initial import (`0013`) | shape-validated; **every unresolved id counted per table and imported as it is**; no row refused, deleted or given a fabricated parent; the counts land in the cutover record (ids only) | resolved against the file's `guardians`; an unresolved id **refuses the cutover** (ids only, nothing written) |
| New writes | **shape-validated only — no parent-existence rule.** Four of the five writers already resolve their subject before writing (`ledgerAppend`, `:691–695`, is called with an id its caller holds; org notes `findPlayer` → 404 at `:2106–2109`; blocks name `req.player.id` or a verified child at `:1758–1762`/`:3991`; the m181 writer takes the id its caller holds, `m181/sourceChanges.mjs:35`), but `handleReport` stores `targetPlayerId \|\| null` from the request body with **no existence check** (`:1771`, `:1783`). A parent-existence rule on `reports` would therefore **change behaviour** — a report naming an unknown player is accepted today — and is **not** part of Candidate A; if the Founder wants it, it is a separately labelled behaviour change with its own tests, not a storage property | the repository **refuses** a write naming a missing guardian — no observable change, because every writer resolves the guardian first (`:1436–1445`, `:4518–4526`) |
| Updates to historical rows | by row id (`reports.status`/`outcome`, the m181 cap's `splice`, the block lift's delete under Q5); the reference value is **never rewritten** and not re-checked on update | by row id (`idv_queue.status`, `:4523`); the reference is not re-checked |
| Account deletion (`deletePlayerData`) | **unchanged**: every row retained, its id becomes unresolved and stays as written; nothing is nulled, tombstoned or deleted; the deletion is never refused because of these rows | not reached (no guardian deletion route; S4b's guardian route, when designed, handles `idv_queue` explicitly — §D.1, O1) |
| Full or partial snapshot replacement | shape and uniqueness validated; the unresolved count per table **reported** as a diagnostic (ids only), **never a refusal**; an omitted collection is kept as it is (the partial-snapshot contract); §D.2a check (d) applies in its **tolerant** form | the final-state assertion against the FINAL `guardians` runs on every snapshot write that touched `idv_queue` **or** the identity pair (the S7d trigger); a retained entry naming a missing guardian is **refused atomically** (ids only); check (d) in its **strict** form |
| Backup / restore | unresolved ids round-trip identical through the admin backup and a restore into a new directory | round-trips; a restored file whose entries do not resolve is refused |
| Old-build rollback (`safetyAuditRollback.mjs` → the eight blobs; `4f954ad` boots the copy) | rows → blob entries one-to-one, unresolved ids included — exactly the blob the old build reads today | rows → the `idvQueue` blob one-to-one |
| Re-upgrade | the same counts, the same rows | the same assertion, the same rows |

Candidate A fabricates no parent or tombstone row, deletes no audit row, does not require Q3 to be decided (Q3
concerns a later **foreign key** on these columns, which a tolerant reference does not carry), and turns no
deletion into a refusal. The import's unresolved count is a **count**, not provenance: it says how many rows
name no present player, not that those players were deleted.

**What a send mutates versus what its save persists (reviewer's F2).** A message send mutates the
`channels` rows, a `ledger` row, a `notifications` row and a `pushLog` row. Its save persists **every
collection that is not a table**: `store.mjs:177–183` loops over `snapshot.db` and serialises and UPSERTs each
remaining blob regardless of change. The reviewer's design check excludes all eight audit names through the
real server-mode skip list, appends a real channel message and saves: `requests`, `trials` and an unrelated
collection receive an `UPDATE` with identical content; `ledger` is absent from the writes; the message is
committed. So moving the `ledger` (and the other seven) removes **their** serialisation and UPSERT work from
every save — nothing else. The first version of this section said Candidate A "takes the `ledger` off the send
path" and meets the objective "for the send path only"; **that is withdrawn.** The broader objective of S7
review §7.3 stays open until every collection a save persists is a table (S8–S14) or a separately authorised
change to the save path writes only changed blobs — a dirty-collection design that is **not** proposed here
and needs its own review against the S3 save contract. (The design check does not measure physical page
writes; its claim is about rows serialised and UPSERTed.)

**Candidate B — S4b, the retained player record.** Needs **Q1** (country) and **Q3** (pre-S4b dangling ids);
Q6 items only if the Founder wants them in the same step. Order: `players.erase`, the view filtering and
the explicit child deletions (§D.1 items 1–3), migration `0013_player_tombstones` (DDL rebuild of `players`
only if Q1 or Q3 make a `NOT NULL` column nullable; otherwise a cutover record and the lifecycle
statements), the readiness tests at the age boundaries, the identity suites extended. **S4b does not by itself
make the permanent player foreign keys ready** (§D.2a): adding `REFERENCES players(id)` to the audit or
file-02 tables in S4b's rebuild also needs §D.2a Alternative A built in the same step or before it — A0 for
the `RESTRICT` keys and, for any `SET NULL` or `CASCADE` key, one of A1–A3 chosen — with the §D.2a checks, and
a decided Q3 for the unresolved ids the tolerant audit references carry; without that, S4b ships the retained
row and the keys wait. Rollback — the honest difficulty: the
pre-S4b build (`4f954ad`) reads every `players` row as a live player, so a copy carrying tombstone rows would
show "Deleted player" entries as accounts; the copy-only tool therefore removes the retained rows from the
copy **and** preserves them in a table the old build does not read (the re-upgrade restores them), which is
"preserved, not visible" rather than lossless in place — to be verified on the actual `4f954ad` build at
implementation and stated as such.

**Candidate C — S8a (requests + trials).** Needs Q7a and Q7b (or S4b, §D.2a and S8b first); its snapshot
replace for `recruitment_requests` must upsert and prune, or Alternative A's deferral (A0) must exist, because
`channels.request_id` becomes a live `RESTRICT` child (§D.3); its five `guardians(id) … SET NULL` columns need
the A1–A3 choice as well; the largest aggregate. Not recommended as the
next step.

**Technical recommendation (not a decision).** If the Founder approves Q4 and Q4b and answers Q5,
**Candidate A** is the smallest coherent behaviour-preserving step: it needs no retention, deletion or
stamping answer, moves eight audit collections out of the per-save serialisation, and its rollback is lossless
in place. It does **not** meet the whole-snapshot-write objective and is not presented as doing so. If the
Founder would rather not approve further checked references, **Candidate B** is next once Q1 and Q3 are
answered — with Alternative A built if its rebuild is to carry foreign keys. Either way S8a follows, and
§D.2a's compatibility — A0 for a `RESTRICT` key, one of A1–A3 as well for a `SET NULL` or `CASCADE` key — has
to exist before any permanent key to the identity tables ships.

### D.5 Decisions required to proceed — the one list (product policy, technical approval, qualified review kept apart)

Already decided and **not asked again**: the full birth date on the retained record; D-A and D-B (S7d);
Q4, Q4b and Q5 (S6b, 19 October 2026 — below);
the legacy-minor rule (under-18 without a valid guardian link stops migration). O2 (organisation deletion)
blocks nothing now and is not asked. **Only the first three questions were needed for the step proposed next on
19 October (Candidate A, since built and accepted); since 21 October 2026 the step proposed next is S4b-R (§D.6),
which needs Q1 only — the rest are recorded for the stages that need them and are not required to proceed.** No
approval of an implementation is sought beyond Candidate A's concrete scope in §D.4; nothing is inferred from
silence.

**Needed for Candidate A (S6b) — ANSWERED by the Founder on 19 October 2026** (received in the review conversation;
explicit answers, not inferences; verbatim: *"Q4: Approve — preserve current behaviour (Recommended). Q4b: Approve —
move with strict guardian checks (Recommended). Q5: Keep today's removal behaviour for this migration
(Recommended)."* — the implementation record is `s6-readiness-review.md` §11; the three rows below are the questions
as asked, kept as the dated record):

| # | Question | Kind | What the app does today | Blocks | Options and practical consequences |
|---|---|---|---|---|---|
| Q4 | May the **five player-referencing audit tables** (`blocks`, `reports`, `org_notes`, `ledger`, `source_changes`) ship with `player_id` **indexed and shape-validated as a tolerant historical reference — no parent-existence rule, no `REFERENCES players(id)`** (§D.2a Alternative B, B-tolerant; the contract table in §D.4), a foreign key arriving only later through Alternative A, a decided Q3 and a rebuild? | **technical design approval** (the D-A kind) | the five collections are blobs rewritten by every save; their player ids stay as written after a deletion (`server.mjs:4299`) and `handleReport` accepts an unchecked `targetPlayerId` | Candidate A | **approve** — the five tables move now; today's state is reproduced exactly: unresolved ids are counted and reported, never refused, never given a fabricated parent, never deleted; the only refusals are shape refusals and name ids only; the key arrives only with Alternative A, Q3 and a rebuild. **decline** — the five tables wait for S4b, Q3 **and** Alternative A (Candidate B first, then the compatibility work). Approving Q4 approves no parent-existence rule for new writes (that would be a labelled behaviour change — §D.4 contract, "new writes") and says nothing about the whole-snapshot-write objective (§D.4) |
| Q4b | May `idv_queue` ship with `guardian_id` **indexed and strictly checked — a live reference refused when the guardian is missing, no `REFERENCES guardians(id)`** (Alternative B, B-strict; the `channels.guardian_id` pattern) — the guardian reference the identity snapshot would otherwise break even without any guardian deletion? | **technical design approval** (the D-A kind; separate from Q4, which covers players and is tolerant) | the collection is a blob; no guardian deletion route exists; every writer resolves the guardian first (`server.mjs:1436–1445`, `:4518–4526`); the identity snapshot deletes and reinserts every guardian row | Candidate A's `idv_queue` table | **approve** — the table moves with the other seven under the same assertion pattern as `channels.guardian_id` (S7d §11.8); no observable change for the routes. **decline** — `idv_queue` waits for Alternative A's deferral (A0); Candidate A ships seven tables |
| Q5 | Does a **lifted block** stay a row delete, or become a retained row with `lifted_at`/`lifted_by`? | **product/behaviour** | lifting deletes the row (`server.mjs:4534`); nothing records who lifted or when | the `blocks` table design | **preserve** (default) — the table reproduces today's delete; no history of lifted blocks. **change** — append-only history of blocks (the S6 review's proposal, §4.2); the admin list stays unchanged by default |

**Recorded for later stages — not required to proceed with Candidate A**

| # | Question | Kind | What the app does today | Blocks | Options and practical consequences |
|---|---|---|---|---|---|
| Q1 | May the two-letter **country code** stay on the retained record of a deleted player? — **ANSWERED by the Founder on 21 October 2026, verbatim: "Keep the country code (Recommended)"** (received in the implementation conversation; an explicit answer, not an inference; not to be asked again; S4b-R built under it, §D.6.2) | **product policy / privacy** (answered 21 October 2026) | the row is deleted; `players.country` is `NOT NULL` (`01_identity.sql:158`); today's helper `isAdult`/`adultAgeFor` (`domain.mjs:76–79`) applies a country's threshold when the country is known and **defaults to 18** when it is not — a development default, not a policy and not legal advice | S4b: the erase column set, `wasMinorOn`'s threshold, the boundary tests | **keep** — a country-specific threshold can be applied to the retained birth date; one more identifier retained. **drop** — the column becomes nullable for tombstones (a `players` rebuild in the S4b migration) and a future `wasMinorOn` cannot apply a country-specific threshold; the design must then choose **explicitly** between reporting the country-specific status of a deleted player as **"unknown"** and applying the default of 18 — a product/privacy choice, not one the code may make silently, and retaining no country does not force a knowingly wrong inference |
| Q2 | Should future safeguarding rows (`blocks`, `reports`, `moderationLog`, `orgNotes`) **record that the subject was treated as a child when written** (rule and basis)? | **product policy** (OPEN since 12 October 2026) | nothing is stamped; reviewers infer from the live birth date | **the stamping step only** — an additive migration after Candidate A (§D.4); Candidate A defers it and is not blocked by it | **yes** — nullable columns added by an additive migration, written by every later safeguarding row (a retention choice of its own); rows written before it read "unknown". **no** — the tables stay as built; reviews of a deleted player's row rely on the retained birth date and Q1 alone. **Deferral in Candidate A is neither answer** |
| Q3 | How are the **ids of players deleted before S4b**, already carried by audit and recruitment rows, treated when foreign keys are added? | **technical, with a privacy aspect** (new) | they dangle (documented state, `s6-readiness-review.md` §3); Candidate A imports and counts them as they are | S4b's foreign-key rebuild of the audit tables (and S8a's of file 02) — not Candidate A | **(a)** synthesise id-only retained rows for them — needs `name`, `birth_date`, `country` nullable for tombstones (a rebuild) and retains an id for a person deleted under the old rule (privacy review); **(b)** leave those tables without the player foreign key permanently and keep code-validated references (the D-A kind, as a permanent rule — approval needed); **(c)** delete the dangling audit rows — contradicts "never pruned" and is not proposed |
| Q6 | Which of the **additional deletion behaviours** the decision record proposes go into S4b: deleting the subject's device push tokens, verification tokens and passport shares; nulling dangling media ids; one ledger row recording the deletion (§8 item 9, itself a retention choice)? | **product policy** (each a behaviour change) | none of them happens today (`server.mjs:4245–4305`) | the S4b scope | **none** (default) — S4b is the retained row and the filtering only. **some/all** — each named item is specified, tested and recorded; the deletion ledger row records a guardian's id |
| Q7 | For S8a (as asked on 19 October): **(a)** may `recruitment_requests.player_id` and `trials.player_id` ship without a player foreign key before S4b and Alternative A, and **(b)** may the two `case_id` columns ship as code-validated references until S8b? — **REFRESHED on 21 October 2026 after S4b-R: the "before S4b" wording is obsolete; the current questions are Q7a, Q7b and Q7c in §D.7, which supersede this row** | **technical design approval** (devices of the D-A kind) | both references are plain ids in blobs | Candidate C (S8a) | see §D.7 |

**Already marked for qualified privacy/legal review, not asked of the Founder alone** (`s4-deletion-decision.md`
§8, unchanged): message retention against record-keeping duties (item 1); health information (2); audit free
text and excerpts (3); commercial records (4); guardian data after a child's deletion and guardian deletion
(5); open retention windows (6); deleted-but-referenced media (7); who may delete a child (8); recording the
deletion event (9, also Q6). No retention period is proposed here, and none of the options above
establishes compliance.

### D.6 Refreshed after the independent acceptance of S6b at `f0abd34` (21 October 2026, from the code at `f0abd34`) — the one recommendation and the one decision it needs

**Status.** S6b is independently accepted at `f0abd3459b435774c00b4e384b046eba23813e88` (`s6-readiness-review.md`
§11.5); S7a–S7d stay accepted at `4f954ad`. Thirteen migrations are registered (`repositories/index.mjs:55`,
`0001`–`0013`); **the next free migration identifier is `0014`** — verified against the registry, not copied from any
placeholder (taken by S4b-R on 21 October 2026, §D.6.2; `0015` is next). §D–§D.5 above are the dated record of 19 October (written at `4f954ad`, corrected twice); this section is
current where they differ, and it replaces no decision. Statements of §B–§D.5 that are now superseded, listed so no
reader acts on them: the §D status line "S4b, the eight S6 audit tables and S8 are not started" (S6b is done); §D.4's
"the next free migration identifier is `0013`" and "every candidate takes `0013`" (now `0014`); Candidate B's
placeholder `0013_player_tombstones` and its "pre-S4b build (`4f954ad`)" (the build the next step's rollback must be
proven on is the accepted **`f0abd34`**); §D.3's "the actual `4f954ad` build" for S8a's rollback proof (the build
accepted immediately before S8a, whichever it is then); and §B's remaining placeholder identifiers
`0012_verification_passport` (S10), `0013_agent_compliance` (S11), `0014_development_discovery` (S12) and
`0015_operations` (S13) — `0012` and `0013` are taken by `0012_channels` and `0013_safety_audit`, and every later stage
takes the next free number when it is approved, as S8a's and S9's notes already say. Candidate A's text and its
contract stay the specification S6b followed. **Nothing below is implemented, stubbed or reserved; no migration file,
column, repository method or test exists for it.**

**The three candidates, re-read against the accepted code.** Candidate A is done. Candidate C (S8a, requests and
trials) is the largest aggregate — 14 tables plus `idempotency_keys`; `db.requests` is read at 150 sites in 34 files
and `db.trials` at 112 sites in 33 files (textual count at `f0abd34`, `scoutbox-server/`); the tombstone shapes, slots,
history and day/schedule containers must round-trip losslessly — and needs two approvals (Q7a, Q7b), the A1–A3 choice
for its five `guardians(id) … SET NULL` columns and an upsert-and-prune replace for `recruitment_requests` (§D.3). It
is the step that would take the two biggest blobs out of every save; it is not the smallest. Candidate B narrows
further than §D.4 wrote it, and that narrowed form is the recommendation.

**Recommended next milestone — S4b-R, the retained player record (Candidate B narrowed: the retained row and the
reader contract only; no foreign key, no additional deletion behaviour, no new age rule).** *Why next, in plain
language:* it is the one remaining step the Founder has already partly decided (the full birth date,
`s4-deletion-decision.md` §10), it is the smallest coherent change left (one repository method, one view rule, one
migration record, one rollback tool, with the readers **re-asserted** rather than rewritten), and it removes
"fact 1" of §D.2 — account deletion deleting the row — from the path to every permanent `players(id)` key: after it,
the audit foreign keys wait on engineering (A0) and on Q3 only, and S8a's `player_id` columns can be designed against a
row that exists. It gives every retained audit row a real subject row, which is what decision O1 is for. *What it does
not do:* it moves no blob out of the per-save serialisation (`requests`, `trials` and the rest are rewritten by every
save exactly as today, §D.4) — S8a is the step that does, and it comes after.

*Exact scope (`scoutbox-server/`, line numbers of `f0abd34`).*

1. **`players.erase(id)`** in `repositories/identity.mjs`, called at `server.mjs:4273` inside the deletion unit in
   place of `players.remove` (`identity.mjs:768–781`, today's hard delete). The row **stays** with `deleted_at` set
   (the column exists since `0005`, `01_identity.sql:195`, written by nothing today), `name` replaced by one fixed
   tombstone string, `birth_date` kept (**decided**), `country` kept or nulled per **Q1**, every other personal column
   NULL (`email` among them, so the address is reusable exactly as after today's hard delete; `guardian_id` NULL),
   `facets_json` emptied. The twelve `player_*` rows and the `guardian_children` rows are deleted **explicitly** (today
   they cascade with the row; a retained row cascades nothing) and every guardian's `childIds` is spliced as `remove`
   does (`:775`). The pairing-code revocation, session revocation, media queue, the request and trial tombstones, the
   case/assessment/contact/open-trial name nulling, the m24–m29 hooks, the thread deletion (D-B) and the notification
   deletion stay exactly where they are in the unit (`:4270–4309`). Nothing else about `deletePlayerData` changes.
2. **The reader contract: a retained row is served by nothing that serves accounts.** `db.players`
   (`collectionView(P)`, `identity.mjs:370`), `players.byId` (`:571`), `byGuardian` (`:573`), `count` (`:574`),
   `guardians.linksOf` (`:793`), the identity snapshot read (`IDENTITY_SNAPSHOT.read`, `:143`) and the admin players
   list exclude retained rows; **one explicit accessor** (`players.retained(id)` / `players.retainedIds()`) exists for
   the deletion unit, the backup, the snapshot writer and the rollback tool, and nothing else calls it. Every reader
   then sees what it sees today after a hard delete — a missing row — so the 41 `findPlayer(` sites (`server.mjs:694`:
   `db.players.find`), the 17 `db.players` reads in `server.mjs`, the 159 `db.players` reads in 14 modules and the
   101 `players.byId(` sites are **re-asserted, not rewritten**; the dead `deletedAt`/`removedAt` checks
   (`m27/index.mjs:183, 597`) stay dead because the view never serves a retained row. The S4a allowlist and
   per-audience view tests (`s4-readiness-review.md` §9 item 11) are the template for the re-assertion.
3. **The identity snapshot carries retained rows through unchanged.** `IDENTITY_SNAPSHOT.replace` deletes every
   `players` row and reinserts the candidate (`identity.mjs:205–207`); the retained rows are **captured before the
   DELETE and reinserted after the candidate, byte-identical** (the S5 child-row precedent, A3 of §D.2a, applied to
   one row set), or excluded from the DELETE — an engineering choice at implementation, proven by the exact-row check
   below either way. The preflight (`validateCoreIdentity`, `:167`) never sees a retained row (it is not an account),
   so **the under-18-without-valid-guardian refusal is unchanged for every live record and is not applied to retained
   rows** — a retained minor's row has no guardian link by design. A snapshot or restore that lists a retained id
   **as a live record** is refused (ids only, nothing written): a deleted account is not resurrected by a save.
4. **Name snapshots on retained recruitment records** (§D.1 item 3; `s4-deletion-decision.md` §5 "Recruitment
   records": `recruitmentCases.history[].byName`, offer and package guardian names, `applications`,
   `campaignSubmissions`, `squadInvites`, `transitionCases`, `evidenceSuggestions`) are replaced by the tombstone
   string **in the same unit** — recommended in scope as an engineering choice (it is the erasure the deletion already
   performs where today's hooks reach, extended to the copies they miss); **excluded**: the commercial names
   (`signings`, `invoices`, `vouches`, squad entries — `s4-deletion-decision.md` §8 item 4) and the audit free text,
   excerpts and `ledger` message-row names (§8 item 3), which stay exactly as today pending qualified review.
5. **Migration `0014`** (proposed name `0014_player_erasure`; the number is taken only when the step is approved): a
   cutover record (counts only) and the per-table lifecycle statement for `players`; **no DDL change if Q1 is "keep"**
   (`deleted_at` exists; `birth_date NOT NULL` is kept); if Q1 is "drop", a rebuild of `players` making `country`
   nullable with a CHECK that a live row (`deleted_at IS NULL`) still carries it — the S4a/S5 create–copy–drop–rename
   pattern. The S6b tool `safetyAuditRollback.mjs` refuses a file carrying `0014` (exit 4, the chain rule).
6. **Failure behaviour.** The erase runs inside the existing deletion unit: a failure before COMMIT (a statement seam,
   the real COMMIT) leaves the row live, the links, sessions and queue entries unchanged and the files on disk, exactly
   as today; the retry lands everything once. A retained row is never created by anything but the deletion unit.
   **A fact the runbook must state:** the migration runner skips recorded migrations and refuses none it does not know
   (`repositories/database.mjs:31–35`), so the previous build (`f0abd34`) would **boot** a `0014` file and **serve a
   retained row as a live account** — which is why going back is the copy-only tool, never "run the old build on the
   file".
7. **Rollback — copy-only, "preserved, not visible", stated as such** (§D.4 Candidate B): `scripts/playerErasureRollback.mjs`
   copies the file, moves every retained row out of `players` into one table the previous build does not read,
   removes the `0014` record, revalidates the copy and never touches the source; the re-upgrade restores the rows
   exactly; proven by booting the actual **`f0abd34`** build on the copy (the retained ids absent from its routes and
   its admin list, every live account identical, a new signup and a new deletion accepted there, this build then
   re-upgrading the copy with the old build's writes and the preserved rows). The erased personal data cannot be
   restored by any rollback — the deletion is honoured either way (`s4-readiness-review.md` §9, S4b row).
8. **Backup and restore.** The admin backup carries retained rows under a key the previous build ignores, never inside
   `players` (a backup restored on the previous build must not resurrect a retained row as an account); a restore into
   a new directory imports them row for row; a backup listing a retained id inside `players` is refused at boot by
   name.
9. **Tests, written first and failing on the unchanged `f0abd34` tree** — a unit suite (`scripts/testPlayerErasure.mjs`):
   the exact retained column set per Q1; the twelve child tables and the links empty for the id; `childIds` spliced;
   `db.players`, `byId`, `byGuardian`, `count`, `linksOf`, the admin list and the snapshot read exclude the row and the
   explicit accessor serves it; an **unchanged** snapshot save (the collection omitted, then supplied and repeated)
   keeps every retained row byte-identical and advances the revision; a save listing the retained id as a live record
   is refused atomically; a failure before COMMIT and the real COMMIT leave everything unchanged and the retry lands
   it; the e-mail reusable after the erase; the under-18 refusal unchanged on live records — and a server suite
   (`scripts/testPlayerErasureServer.mjs`): the real `DELETE /player/account` and `DELETE /guardian/children/:id`
   (`server.mjs:4321–4337`) answer as today, every route that answers "removed" today answers the same, the retained
   audit rows (Q4) are untouched, the admin backup, a restore into a new directory, SIGKILL and restart, the rollback
   copy booted by the actual `f0abd34` build and the re-upgrade. The shortlist reader's 500 on a deleted player
   (`s4-deletion-decision.md` §2, a defect in a route) is **unchanged** by this step and stays a separate fix.
   Acceptance: both suites; both milestone gates with the six historical builds wired (`812e13b` or `2d7ddeb`,
   `0641b2c`, `6ca66ba`, `b67bce5`, `4f954ad`, `f0abd34`); the copy-only chain run in order on a synthetic file.

*Exclusions (each a later, separately approved step):* no `REFERENCES players(id)` or `guardians(id)` anywhere
(A0–A3 and Q3 untouched); no guardian deletion route; none of Q6's behaviours (push tokens, verification tokens,
passport shares, dangling media ids, a deletion ledger row); no `wasMinorOn` or any new age rule (no reader needs one
today; the first reader that does is the step that adds it, under Q1 and Q2); no child-status stamp (Q2); no change
to any audit row (Q4) or to the block lift (Q5); no retention rule or period; no S8a table; no dirty-collection
save.

**The three categories, kept apart.**

| Category | Items |
|---|---|
| **Already approved — not asked again** | the full birth date on the retained record (`s4-deletion-decision.md` §10); Q4, Q4b, Q5 (S6b); D-A, D-B (S7d); the under-18-without-valid-guardian migration refusal (unchanged for live records); the copy-only, nothing-lost rollback pattern (S5–S7, S6b) |
| **Ordinary engineering choices — recommended here, decided at implementation, each proven by an exact-row test** | the tombstone string; the view exclusion with one explicit accessor rather than a flag every reader must check; capture-and-reinsert versus exclusion from the DELETE in the snapshot replace; explicit child and link deletion; the recruitment name-snapshot replacement in scope, commercial and audit text out; migration shape per Q1; the "preserved, not visible" rollback table; the backup key for retained rows; `wasMinorOn` deferred to its first reader |
| **Founder decision required for this scope** | **Q1 only** (below). Q3 is **not** required: no foreign key is added, so the ids of players deleted before S4b stay the tolerant, counted references Q4 approved. Q6 is **not** required: the step excludes every additional behaviour, which is the "none" default of §D.5 as a scope statement, not an answer. Q2, Q7 are not touched |

**Q1 — the one question (unchanged in substance from §D.5, re-asked because this step cannot be finished without it).**
*May the two-letter country code stay on the retained record of a deleted player?* The erase method writes exactly the
retained column set; `players.country` is `NOT NULL` (`01_identity.sql:158`); the code must not choose this silently.

- **Keep (recommended).** The retained record is `id`, `deleted_at`, the tombstone name, `birth_date`, `country`.
  Consequences: no `players` rebuild (the migration is a record and a lifecycle statement); a country-specific
  majority threshold (18 by default; KR 19, TH 20, EG 21, SG 21 — `domain.mjs:7–14`) can later be applied to the
  retained birth date without a knowingly wrong inference; one more identifier (two letters) is retained beside the
  full birth date the Founder already chose, which is the more identifying of the two. Recommended because the chosen
  full birth date is only usable for the question it was kept for if the threshold that applies to it is known.
- **Drop.** The retained record omits `country`. Consequences: a `players` rebuild in the migration (`country`
  nullable for retained rows, still required for live ones); any later status question about a deleted player in
  KR, TH, EG or SG must **explicitly** answer "unknown" or apply the default of 18 — a product/privacy choice to be
  made when that reader is added, not by the code; the least data retained.
- Either way: the answer is a retention choice that the qualified privacy/legal review of `s4-deletion-decision.md` §8
  still has to see; neither option establishes compliance; nothing here reopens the birth-date choice.

**After S4b-R** (recorded, not proposed now): S8a (Candidate C) with Q7a/Q7b, or the A0 deferral together with the
first permanent `RESTRICT` key once Q3 is decided — in the order the Founder chooses then.

#### D.6.1 S4b-R — clarifications resolved before coding (21 October 2026, from the code at `d16362f`; the implementation record is `s4-readiness-review.md` §12 once built)

These correct and narrow §D.6 where the Founder's review of it found ambiguity. They are the specification the
implementation follows; where §D.6 differs, this section is current.

**1. The retained row, column by column, against the LIVE `players` table** (`identityPreflight.mjs:92–135`, the
STRICT DDL migration `0005` created; 42 columns). Three kinds of value are kept apart: an **identifier**, a
**retained personal fact** (only what the Founder decided), and a **fixed storage placeholder** — a constant the
table's constraints need, never the person's previous value and never read back as a fact about the person.

| Column(s) | Retained row | Kind |
|---|---|---|
| `id` | kept | identifier (what every audit, recruitment and commercial row points at) |
| `deleted_at` | the deletion instant (`INTEGER`, ms) | the one new fact: that and when the account was deleted |
| `birth_date` | kept | retained personal fact — **decided** (`s4-deletion-decision.md` §10) |
| `country` | **Q1**: kept (retained personal fact) **or** removed — but the column is `NOT NULL`, so "removed" needs the schema change in item 2 | retained personal fact or not, per the Founder |
| `name` | the constant `'Deleted player'` | fixed storage placeholder (the column is `NOT NULL`; the constant is not a name) |
| `academy_plus`, `first_team_seeker`, `identity_verified`, `medical_shared` | `0` | fixed storage placeholders — the columns' declared defaults, **not** the person's previous values (a verified player's row reads `0` afterwards; that is a placeholder, not a statement that the person was unverified) |
| `availability`, `contract_status`, `level`, `medical_condition_status` | `'not_seeking'`, `'unknown'`, `'amateur'`, `'unknown'` | fixed storage placeholders — the declared defaults, same rule |
| `city`, `position`, `foot`, `height_cm`, `weight_kg`, `squad_number`, `contract_until_date`, `market_value_range`, `agent_name`, `football_category`, `lat`, `lng`, the seven `stats_*`, the four `prefs_*`, `programme_track`, `programme_started_at`, `password_hash`, `created_at`, `guardian_id`, `facets_json` | `NULL` | nothing of the person (the `(lat IS NULL) = (lng IS NULL)` CHECK holds; `facets_json` NULL means no unknown field and no shape metadata survives) |
| the twelve `player_*` child tables, `guardian_children` | **rows deleted explicitly** in the same transaction (today they cascade with the row; a retained row cascades nothing) | owned rows and links |

The retained row is **never read as a player record**: no reader decodes it through the mapping, the placeholders are
never served, and the only readers are the deletion unit (the collision check), the snapshot writer, the backup, the
`/capabilities` count and the rollback tool.

**2. Whether a schema change is necessary.** **Q1 is answered: the country code is KEPT** (the Founder, 21 October 2026, verbatim: *"Keep the country code (Recommended)"*). With **Q1 = keep**: none — every constraint of the live table is
satisfied by the mapping above (`deleted_at` exists since `0005`; `birth_date NOT NULL` keeps its value; the
placeholders satisfy every `NOT NULL` and `CHECK`), so migration `0014` is a cutover record, an import of the
`playersRetained` backup collection (item 5) and nothing else. With **Q1 = remove**: a **rebuild of `players`** is
necessary (SQLite cannot relax `NOT NULL` in place): create–copy–drop–rename under the runner's `foreignKeysOff`
(the `0005` pattern; the twelve `player_*` tables and `guardian_children` reference `players(id)`), with
`country TEXT` nullable **and** `CHECK (deleted_at IS NOT NULL OR country IS NOT NULL)` so a LIVE row still requires
it — "keep country" is therefore not assumed to mean "no schema work" (it does mean that, but only because the
mapping above was checked column by column), and "remove" is not assumed to be a one-line change.

**3. The name cleanup is today's, not more.** `deletePlayerData` (`server.mjs:4257–4313`) already nulls or
tombstones names where its hooks reach (requests and trials as id-only tombstones; `recruitmentCases.playerName`,
assessments, contact responses and open-trial registrations nulled; the m24–m29 hooks). S4b-R **preserves exactly
that** and changes only one statement of the unit: `players.remove` → `players.erase`. §D.6 item 4's proposal to
replace the remaining name copies (`recruitmentCases.history[].byName`, offer and package guardian names,
`applications`, `campaignSubmissions`, `squadInvites`, `transitionCases`, `evidenceSuggestions`) is **withdrawn from
this milestone as an "engineering choice"**: it is additional erasure of recruitment and guardian-name copies, a
behaviour change in its own right, and goes into no step without the Founder's explicit authorisation. It is recorded
here as a proposed extension (together with the commercial names and the audit free text of
`s4-deletion-decision.md` §8 items 3–4), not scheduled.

**4. What the step gives the audit rows — corrected.** §D.6 said S4b-R "gives every retained audit row a real
subject row". That is wrong. It gives one to every audit row whose subject is deleted **under the new behaviour**,
from the cutover on. The ids that audit and recruitment rows carry today for players deleted before S4b-R, imported
before S4a, or never existing (`handleReport`'s unchecked `targetPlayerId`) **stay exactly as they are**: preserved,
counted under Q4, resolved to nothing. **No historical retained row is fabricated for them** — that is Q3, untouched.
The `/capabilities` report keeps the Q4 count (`unresolvedPlayerReferences`: ids naming no `players` row at all) and
adds, beside it, the count of references that name a **retained** row — a count, not provenance.

**5. Backups, restores, snapshots and the rollback copy — the retained records' shape.** A retained record travels
as `{ id, deletedAt, birthDate, country? }` (`country` only under Q1 = keep) in a collection of its own,
**`playersRetained`**, **never inside `players`**: the admin backup exports it beside the live `players`; a restore
into a new directory imports `players` through `0005` as today and `playersRetained` through `0014` (shape-validated;
an id that is also a live player **refuses the boot** with ids only, nothing written); a snapshot save that carries
`playersRetained` may only ADD retained records — every stored record must be listed with its four facts unchanged, or the
whole save is refused with ids only (the protected contract, corrected after the independent review of `6d66655`, §D.6.3; the
first implementation replaced the stored set with the supplied collection, which let an ordinary save prune a deletion record
or amend its facts) — one that omits it keeps them as they are, and the identity replace — which deletes and reinserts every `players` row —
**captures the retained rows before its DELETE and reinserts them byte-identical after the candidate**, refusing a
candidate that lists a retained id as a live record. The copy-only rollback tool writes `playersRetained` as a legacy
blob into `collections` and removes the rows from `players`: the previous build (`f0abd34`) loads the blob into memory
under a name no route reads, keeps it through its saves and exports it in its backups, and **serves nothing of it as
an account**; the re-upgrade imports it back through `0014`. The erased personal data is not restored by any of this.

**6. The danger the runbook states.** The migration runner skips recorded steps and refuses none it does not know
(`repositories/database.mjs:31–35`). Booting the previous build **directly on a `0014` file** therefore does not fail:
that build reads every `players` row as an account and would serve a retained row as a live, passwordless player
named "Deleted player" with the retained birth date (and country). Going back is the rollback tool, never the old
build on the live file. The server suite proves the danger on a synthetic copy and the tool's copy as the answer.

**7. Other SQL readers of `players` that must not resolve a retained row as a player:** the identity load
(`identity.mjs:259`, `:435`), the snapshot read (`playerSubrecords.mjs:567`, used by backups and the rollback
chain), the media-queue ownership check (`mediaDeletions.mjs:77`), the pairing-code consistency check and the
pairing-code write (`oneTimeCodes.mjs:209`, `:295` — a code naming a retained id is refused, as one naming a missing
id is today). The guardian checks (`channels`, `idv_queue`) read `guardians`, which S4b-R does not touch.

**8. Unchanged, and not asked again:** Q4/Q4b/Q5; D-A/D-B; the full birth date; the under-18-without-valid-guardian
refusal (it applies to live records in `validateCoreIdentity`; a retained row is not a record and never reaches
it); today's e-mail behaviour (a player row has no e-mail column; an adult logs in by player id, so nothing about
addresses changes); Q2, Q3, Q6, Q7 untouched.

#### D.6.2 S4b-R as implemented (21 October 2026, one local commit on `feat/sqlite-schema` on top of `d16362f`; written while AWAITING INDEPENDENT ACCEPTANCE — **since corrected (§D.6.3) and independently ACCEPTED at `9b109dc`, §D.7**)

Built exactly to §D.6 as narrowed by §D.6.1, under the Founder's answer to Q1 (the country code kept, recorded verbatim in
§D.5): migration `0014_player_erasure` (REGISTERED; a cutover record and the `playersRetained` import — no table, no column,
no foreign key, no retention period); `players.erase` in `repositories/identity.mjs` called by `deletePlayerData` in place of
`players.remove` (everything else of the deletion unit unchanged); the retained rows excluded from every account reader and
served by the narrow accessors only; the identity snapshot carrying them through its rewrite and refusing a resurrection;
the backup's `playersRetained` collection and its import on restore; the copy-only rollback `scripts/playerErasureRollback.mjs`
(the records moved into the `playersRetained` legacy blob the previous build serves to nobody; the erased data restored by
nothing); the two suites `scripts/testPlayerErasure.mjs` and `scripts/testPlayerErasureServer.mjs`, written first and failing on
the unchanged `d16362f` tree. The implementation record, where it departs from the wording above and why, and the verification
are `s4-readiness-review.md` §12. **The next free migration identifier is `0015`.** Not production, security, legal-compliance
or deployment approval; not acceptance of S8, of the foreign keys (A0–A3, Q3) or of anything Q2, Q6 or Q7 name.

#### D.6.3 Correction after the independent review of `6d66655` (21 October 2026; written while S4b-R was still AWAITING INDEPENDENT ACCEPTANCE — accepted since at `9b109dc`, §D.7)

The review found one P2 finding, reproduced two ways by its unchanged script (`review-6d66655-reproductions.mjs`, exit 1:
F1a and F1b REPRODUCED on `6d66655`). **F1:** `PLAYERS_RETAINED.replace` deleted the whole stored retained set and
inserted the supplied collection, so an ordinary snapshot save carrying an empty or partial `playersRetained` could erase a
deletion record — after which a later save could re-create the id as a live account (F1a) — and a same-id record could
rewrite the stored birth date, country and deletion instant (F1b). The generic "a supplied collection replaces the table"
convention had silently overridden the narrower promise the retained record exists for. **Correction (one commit on top of
`6d66655`):** the contract is now PROTECTED — a supplied collection may only add records; every stored record must be listed
with its four facts unchanged, and a stored record that is not listed, or listed with a changed fact, refuses the whole
save atomically (`RETAINED_RECORD_PROTECTED`, ids only; accompanying changes to other collections roll back with it; no
transaction stays open). New records are validated as before (shape, no duplicate, no live id); omitted collections keep
the rows; a fresh restore and a re-upgraded rollback copy still import through migration 0014. No stored row is ever
deleted or updated by a save. The unit test that blessed pruning was corrected (its expectation conflicted with preserving
retained deletion facts) and a dedicated regression covers the empty and subset collections, each changed fact separately,
the two-save prune-then-recreate sequence, the live-id collision, the rollback of accompanying changes and the positive
controls. The reviewer's script, unchanged, reports both checks CORRECT on the corrected tree. No decision was reopened or
added: the four retained facts and the Founder's two choices stand; no retention period, correction or purge policy, age
rule, foreign key, guardian lifecycle change, field or migration identifier was introduced.

### D.7 After the acceptance of S4b-R at `9b109dc` (21 October 2026, from the code at `9b109dc`) — the next implementation milestone and the decisions it needs

**Superseding note (22 October 2026).** The design below, as corrected three times, was independently accepted at
`d0f0205`, the Founder answered Q7a, Q7b and Q7c (verbatim in §D.8.1), and S8a-core is **implemented** behind migration
`0015_recruitment` — **awaiting independent acceptance**. §D.8 is the implementation record; the statements in this
section that say "not started", "not reserved", "unanswered" and "awaiting independent review" describe the state at
`d0f0205` and are kept as the record of that state.

**Status.** S4b-R (the retained player record, migration `0014_player_erasure`) and its F1 correction are independently
accepted at `9b109dc41f44159b082dd261b2de78a2bab13762` (`s4-readiness-review.md` §12.5). S6b stays accepted at `f0abd34`,
S7 at `4f954ad`. Fourteen migrations are registered (`repositories/index.mjs:56`, `0001`–`0014`); **the next free
identifier is `0015`** — verified, not reserved and not created here. This section is documentation and technical
preparation only: nothing below is implemented, stubbed or reserved. It supersedes §D.3, §D.4 Candidate C and the
§B S8 "player tombstone" bullet where they say S8a waits for S4b; §D.5's Q7 row is superseded by Q7a–Q7c below.

**Correction record (21 October 2026, after the independent review of `a6c40f3`).** The review accepted the S4b-R
acceptance record and found three P2 design defects in the first version of this brief, each reproduced by its
script `review-a6c40f3-design-checks.mjs` (the drafted DDL, the unchanged open-day handler run with synthetic
dependencies, the actual club view — not a real HTTP run, not a defect in any implemented repository; the script
still reproduces all four hazards against the UNCHANGED draft file 02, by design, because the draft is amended at
implementation, §D.7.3): **D1** — the documented requests-then-trials order could not insert a new linked pair
(`recruitment_requests.trial_id` named a trial that did not exist yet) and, deferral or not, could not replace a
request's trial (`UNIQUE(trials.request_id)` refused the arrival before the departure); **D2** — the drafted partial
unique index "one pending request per (org, player, type)" would refuse invitations the open-day outcome route
creates today without that guard; **D3** — `blockedBy` was called a dead field and dropped although `trialClubView`
reads it and `tombstoneTrial` carries it, and two other draft omissions (`trials.keys.accept`, the tombstone's
`trialDetails.instructions`) broke the lossless round trip. §D.7.2–§D.7.7 below are corrected in place; the
corrections are engineering and data-preservation choices and add **no** product decision. The probes
`probe-s8a-write-algorithm.mjs` (20 checks, with a control that reproduces D1a/D1b under the old order),
`probe-s8a-open-day-roundtrip.mjs` (5) and `probe-s8a-lossless-fields.mjs` (8) are in the handoff of this correction
(§D.7.8). **S8a is not started; migration `0015` is not reserved; Q7a, Q7b and Q7c are unanswered; this brief awaits
independent review before it is put to the Founder.**

**Second correction (22 October 2026, after the independent review of `cd7dc95`).** That review closed D2 and D3 at
the design level and the original D1 cases (the new pair, the `request_id` replacement), and found **one P2 remaining
in D1**: with the retained partial index `trials_one_open_per_case` (`UNIQUE(case_id) WHERE case_id IS NOT NULL AND
workflow_state NOT IN ('completed','cancelled')`), a valid snapshot that completes trial-1 and adds a new open trial-2
in the same case failed under the cd7dc95 phases when trial-2 was listed first — the closing survivor kept its request
and its case, so phase 2(a) never released its index slot before the arrival — and committed when listed second
(`review-cd7dc95-case-handoff.mjs`, derived from the first write probe with the actual drafted index installed and
`case_id` bound; the first probe had neither). **Corrected in place:** phase 2 of §D.7.5 now has three steps —
departures (a changed `request_id` **or `case_id`** is a departure), **releases** (a parent-preserving update of
every surviving trial that leaves the predicate, before any arrival), then the upserts — with the argument why every
remaining `UNIQUE` refusal is a genuine final-graph conflict; §D.7.3 names the write-order rule beside the retained
index; the other retained unique constraints are checked for the same category in §D.7.5. The product constraint is
kept, not dropped. Proof: `probe-s8a-write-algorithm-cases.mjs` (13 checks, the drafted indexes of the six modelled
tables installed from file 02, both input orders for every valid final graph, the cd7dc95 writer as the control). No
product decision is added or changed; D2 and D3 stay closed as written. **The brief still awaits independent review.**

**Third correction (22 October 2026, after the independent review of `f2121b5`).** That review closed the case-index
ordering finding (completion, cancellation, re-entry and case handoff in full snapshots) and found **one related P2**:
under the f2121b5 phases a changed `case_id` was a *departure* (delete + reinsert), so `ON DELETE SET NULL` cleared
the request's retained back-reference and, with `requests` omitted as the partial-snapshot contract allows, phase 3
restored nothing and the pair assertion refused a valid case-only change (case-1 → case-2, case-1 → NULL, a swap of
two open survivors) that committed when the unchanged requests were resent (`review-f2121b5-partial-case.mjs`).
**Corrected in place (§D.7.5 phase 2):** departures are only trials no longer listed or whose `request_id` changes;
a survivor leaving its case slot — by state or by key — is **released by a parent-preserving `UPDATE` that parks
`case_id` to NULL**, never deleted, so no `SET NULL` fires and its retained link, children and request row survive;
the arrivals then write the final `case_id` and state. No link is reconstructed from a trial alone; an actual
reassignment, a replacement or new trial a retained request does not name, conflicting supplied back-references and
two open trials in one case are still refused; a deliberate removal still leaves the back-reference NULL; supplied
request values stay authoritative. Proof: `probe-s8a-write-algorithm-partial.mjs` (20 checks: every partial save
compared, as an exact dump, with the equivalent full save in both trial orders; the f2121b5 phases as the control).
No product decision is added; D2 and D3 stay closed. **The brief still awaits independent review.**

#### D.7.1 What S4b-R changed for the recruitment step, and what it did not

A `players` row now outlives an account deletion as the retained record (id, deletion instant, birth date, country;
§D.6.1), so "fact 1" of §D.2 — that a `RESTRICT` reference to `players(id)` has no row to point at after a deletion —
no longer holds for deletions performed under the new behaviour. **It does not make a player foreign key ready**:
"fact 2" is untouched — the identity snapshot still deletes and reinserts every `players` row (`identity.mjs:205–207`),
so any `REFERENCES players(id)` still needs §D.2a (A0 for `RESTRICT`; A1–A3 for `SET NULL`/`CASCADE`) — and the ids
of players deleted before S4b-R, pre-S4a imports and ids that never existed still resolve to nothing (Q3, open; nothing
is fabricated for them). The drafted file 02 declares **no** `players(id)` key on `recruitment_requests.player_id` or
`trials.player_id` (`02_recruitment.sql:511`, `:634`), so S8a as drafted never depended on S4b for a key; what it
needed was an explicit approval of that no-key shape (the old Q7a). The retained row changes the *meaning* of a
recruitment player reference, not the schema (§D.7.3).

#### D.7.2 The candidates, and the recommendation

- **Candidate F — a snapshot/foreign-key foundation first** (§D.2a Alternative A: A0, the `defer_foreign_keys`
  deferral, plus A1, an upsert-and-prune rewrite of the identity replace). Cost: a rewrite of `IDENTITY_SNAPSHOT.replace`
  that must reproduce the order-independence cases the review of `9656a4b` demanded (removed-e-mail reuse, e-mail
  swaps between retained guardians, co-guardians listed before their primary) with `UNIQUE` columns changing hands,
  every snapshot-mode suite re-asserted, the §D.2a checks (a)–(f) written first — and it delivers nothing observable:
  the only keys it would unlock are the audit keys (Q3 still open) and keys S8a does not need. **Not recommended now.**
- **Candidate G — the audit foreign keys.** Needs Q3 and Candidate F. Not available.
- **Candidate C — S8a, requests and trials, narrowed to need no identity key and no answer to Q2, Q3 or Q6.**
  **Recommended.** Plain language: it is the next domain in the plan's order; it was never blocked by the player
  row but by three approvals of checked references; it takes the two largest remaining blobs out of every save (the
  bench below: on a fixture of 400 requests and no trials, every save still serialises 77 811 bytes of the `requests`
  blob — the only blob left in that fixture — after S6b and S4b-R; a real file carries `trials`, with their schedules,
  histories and day containers, as well); and it converts the D-A transitional `channels.request_id` check into the
  real foreign key the S7d acceptance promised. What it does **not** do: it does not touch any identity key (A0–A3 and
  Q3 stay where they are), and it does not meet the whole-snapshot-write objective — `recruitmentCases`, contacts,
  offers, signings and every other blob are still rewritten by every save (§D.4).

**Can S8a safely proceed next?** The recommendation stands as **S8a-core**, on this evidence rather than by
assertion: no key to `players(id)` or `guardians(id)` (so §D.2a does not bind); the request and trial tables written
by the **six-phase write of §D.7.5** — parent-preserving upserts, the back-reference parked and assigned after the
trial exists, departures before arrivals for a changed `request_id`, parent-preserving releases (the case slot
parked) of survivors leaving their `trials_one_open_per_case` slot before any arrival, explicit prunes, final-state
assertions, immediate constraints throughout — which the probes `probe-s8a-write-algorithm.mjs`,
`probe-s8a-write-algorithm-cases.mjs` and `probe-s8a-write-algorithm-partial.mjs` show construct a new pair on an
empty database, re-save an unchanged graph byte-for-byte, replace a trial, complete or cancel a trial and open the
next one in the same case **in either input order**, apply a case-only change **with `requests` omitted** exactly as
with them supplied, honour partial snapshots and refuse every invalid final state with a rollback (the a6c40f3 order,
the cd7dc95 phases and the f2121b5 phases fail their control cases); the
drafted "one pending request" index **withdrawn** so the open-day route's invitations stay valid (§D.7.3, D2); the
mapping made lossless (§D.7.3, D3); and three explicit approvals (Q7a, Q7b, Q7c) that this correction neither
narrows nor infers. "Upsert-and-prune" alone was not a complete solution and is no longer claimed to be one.

#### D.7.3 The recommended scope — S8a-core

**Collections → tables** (DDL `02_recruitment.sql`, already drafted; the plan's `0010_recruitment` placeholder is
withdrawn; the number is assigned at approval):

| Blob today | Tables | Owned children (CASCADE from the owner) |
|---|---|---|
| `requests` (39 reads in 13 modules + 15 in `server.mjs`; writers `server.mjs:2266`, `:2898`, the accept/decline/suspend routes, `tombstoneRequest` `:4234`, the m23 trial-invitation routes, m12/m17 case links) | `recruitment_requests` (:509) | `request_trial_slots` (:563); the request's `keys.invite` → `idempotency_keys` (:74) |
| `trials` (69 reads in 23 modules + 10 in `server.mjs`; writers `server.mjs:2347` (acceptance), `tombstoneTrial` `:4181`, `m23/trialRoutes.mjs` (schedule, attendance, day, completion, history), the report route, the reminder sweep) | `trials` (:630) | `trial_schedule_sessions` (:715), `trial_session_evidence` (:736), `trial_schedule_revisions` (:766), `trial_attendance` (:792), `trial_reminders` (:810), `trial_day_staff` (:828), `trial_day_consents` (:851), `trial_day_checkins` (:867), `trial_day_status_events` (:882), `trial_reports` (:906, `RESTRICT`), `trial_history` (:933, `RESTRICT`); the trial's `keys` → `idempotency_keys` |
| `channels` (S7d, live) | rebuilt with `request_id … REFERENCES recruitment_requests(id) ON DELETE RESTRICT` (the D-A conversion) and `contact_channel_id` left as it is (a plain id: contacts are S8c) | — |

Sixteen tables (14 of file 02 plus `idempotency_keys` and the `channels` rebuild). **Lossless mapping** (corrected,
D3): every scalar to its column, every nested container to its child table in list order, the tombstone shapes exactly
(`playerName` NULL, `message` NULL, `notes` `''`, `guardianId` NULL, `recipient` dropped, the slots reduced to times and
venue name/town, the schedule sessions stripped, the history detail reduced to the keys the tombstone keeps —
`tombstoneTrial`/`tombstoneRequest` are the specification and stay the writers), `subjectRemovedAt` →
`subject_removed_at`, `rev/revAt/revBy`, the `reminders` markers, `trialDetails.altSlots` kept as retained JSON, and
**the presence discipline of S6b/S7d on both tables and inside `trialDetails`**: a row carries `absent_keys_json`
(the known keys that were ABSENT, dotted for nested keys) and `extra_json` (every key the columns and child tables do
not hold, kept exactly, `null` included), so present-and-null, absent and non-null all come back as they were, and a
live `undefined` persists as absence (the blob's JSON rule, as S7d keeps it). **The draft's deliberate omissions are
withdrawn** — nothing a stored record carries is dropped, derived-ness or an absent creation writer being no reason:

| Draft (file 02, superseded by this table until amended at implementation) | Corrected mapping | Why |
|---|---|---|
| `blockedBy` "dead field, not migrated" (trials notes) | kept: `extra_json.blockedBy` when present (a value or `null`); absence recorded | read by `trialClubView` (`m23/trial.mjs:517`) and carried by `tombstoneTrial` (`server.mjs:4224`); with an imported non-null value the actual club view returns it and the a6c40f3 mapping turned it into `null` (the probe's control) |
| `trials.keys.accept {key: null, fp}` "NOT migrated" (idempotency notes, line 52) | kept exactly in the trial row's retained `keys` JSON (`extra_json.keys.accept`); the other `keys` acts go to `idempotency_keys` as drafted | `idempotency_keys.key` is `NOT NULL CHECK (length … )`, so the row cannot hold it; the writer produces it (`server.mjs:2339`) and the backup/rollback round trip must reproduce it |
| the tombstone's `trialDetails.instructions: null` "stray key, dead field" (requests notes) | kept as a present-and-null key: `extra_json.trialDetails.instructions` | `tombstoneRequest` writes it (`server.mjs:4246`); presence is data |
| `recipient.playerId` "derived, not stored" (both tables) | derived AND verified: the import and every write assert `recipient.playerId === player_id`; a mismatch is kept in `extra_json` with ids only, never normalised away | exact round trip, nothing invented |
| the `day` container "presence is derived" (trials notes) | presence recorded (`absent_keys_json`): a trial without a `day` key comes back without one; the tombstone's shape follows the stored presence | `tombstoneTrial` emits `day` only when the key exists |
| `workflowState` absent → `'legacy_accepted'`; `rev` absent → `1`; `reminderSent`, `notes`, `org_trusted_partner` and the other `NOT NULL DEFAULT` columns | the column takes the DDL's default and the absence is recorded, so the key comes back absent, not as the default | the probe found this on `reminder_sent` and `org_trusted_partner`: without the record the default would be fabricated into the blob |

The amendment to file 02 at implementation is therefore: add `absent_keys_json` and `extra_json` to `recruitment_requests`
and `trials` (the S7d `CHECK`s), correct the three mapping notes above, and withdraw the index below; **file 02 is
unchanged in this correction** (so the reviewer's script still reproduces the hazards against it). `players[].trialReports`
stays derived: the identity repository's `trialReports` accessor (`repositories/index.mjs:272`, today
`trialReportsFor(db.trials, …)`) reads the `trial_reports` table through the new repository. **Preserved behaviour:**
every route payload; the idempotency replay/conflict rules exactly (`idempotency_keys` notes); the deletion unit's
tombstoning of a deleted player's requests and trials in place (today's behaviour, S4b-R unchanged); the trial-accept
gate and the case links; **and the two different duplicate rules of the two request writers, exactly as they are
(D2):** the direct route `POST /org/players/:id/request` refuses a second pending request of the same type in code
(`REQUEST_PENDING`, `server.mjs:2212`), while the open-day outcome route (`server.mjs:2869–2917`) creates a pending
trial invitation per successful registration outcome with no such guard — two outcomes for one adult and one club
produce two valid pending invitations today (`probe-s8a-open-day-roundtrip.mjs`: the unchanged handler, run twice with
synthetic dependencies). **The drafted partial unique index `recruitment_requests_one_pending` (file 02 line 553) is
withdrawn from S8a-core**, with its "duplicate pending request" refusal test (§D.7.6): the probe's control shows the
index cannot even be created over the two valid rows. The non-unique lookup index on `(org_id, player_id, type,
status)` stays for the route's scan. Nothing is deduplicated, no invitation is deleted or "fixed by hand", no request
is refused that succeeds today; the registration outcome (an `openTrials` blob edit) and its invitation (a row) are
written by the same save transaction, so a failed save records neither (the probe). Whether a product-wide
one-pending rule should exist is a **separate, undecided product question** that this brief does not raise and
Q7a–Q7c do not answer. The other unique indexes in scope, each checked against its writers: `UNIQUE(trials.request_id)`
(structural — `issueAcceptedTrial` is the one writer and both respond routes accept a `pending` request only,
`server.mjs:1573`, `:3428`); `request_trial_slots UNIQUE(request_id, day)` (`validateInvitation` refuses two slots on one
day, `trialRoutes.mjs:323`); `trials_one_open_per_case` (`trialRoutes.mjs:367–369` refuses a second pending invitation
and a second open trial per case; the legacy respond routes accept only what that route invited — kept, and the dry
run counts any legacy exception before cutover, **reported, never resolved by the migration**; if one exists the index
is withdrawn the same way, not the row; **because it is a partial index on a parent row written by upsert, the write
must release a survivor that leaves its predicate before any arrival — §D.7.5 phase 2(b), the review of `cd7dc95`**); `trial_session_evidence_one_active` (D-12, `trialRoutes.mjs:700`:
linking twice is a replay); `trial_day_consents_one_per_actor` (checked at implementation against `m12/journeys.mjs`
the same way, withdrawn if any writer bypasses it); `channels_request_id` (live since S7d).

**Readers and writers:** `db.requests` and `db.trials` become read-only views (insertion order, each trial's
containers nested in list order) over one participant's mirrors — the S7d/S6b pattern, staged into the route's next
save or the enclosing unit through the graph memento; the writers listed above call the repository; the channels
repository's `requests` accessor (`index.mjs:443`) and `readRequestsBlob` (`channels.mjs:438`) read the table.

#### D.7.4 What a player reference means on a recruitment row (not Q4, which approved the audit tables only)

| The player named by `player_id` | What the row is | What the step does |
|---|---|---|
| **live** | an active request or trial | the id resolves to the live row; no foreign key (Q7a); the deletion unit still rewrites the rows as tombstones when the account goes |
| **retained after deletion (S4b-R)** | the tombstoned row (`subject_removed_at` set, names and words removed) | the id resolves to the retained record — nothing of the person comes back; the tombstone stays the stored shape |
| **historically missing** (deleted before S4b-R, pre-S4a import, an id that never existed) | the tombstoned or legacy row | the id resolves to nothing: **preserved and counted** at import and in the report (ids only), never refused, never deleted, **never given a fabricated record** (Q3 untouched) |

Q4's approval covers the five audit tables and nothing else; this table is what **Q7a** asks the Founder to approve for
the two recruitment tables.

#### D.7.5 References, foreign keys and the snapshot write — every proposed key and its action

| Column | Drafted | Proposed for S8a-core | Why |
|---|---|---|---|
| `recruitment_requests.player_id`, `trials.player_id` | no key | **no key**; tolerant historical reference (§D.7.4) | an identity key needs §D.2a; Q3 open — **Q7a** |
| `recruitment_requests.guardian_id`, `.recipient_guardian_id`, `trials.recipient_guardian_id` | `REFERENCES guardians(id) ON DELETE SET NULL` | **no key**; a **strict** checked reference (the `channels.guardian_id` / Q4b pattern: the writer resolves the guardian, the import refuses an unresolved id with ids only, a final-state assertion runs on every snapshot that writes the tables or rewrites the identity pair); NULL on tombstones as today | `SET NULL` fires at the guardian DELETE of every identity rewrite whatever `defer_foreign_keys` says (§D.2a, verified) — it would null the recipient of every request on every snapshot save; A1–A3 is Candidate F — **Q7c** |
| `recruitment_requests.case_id`, `trials.case_id` | `REFERENCES recruitment_cases(id) ON DELETE RESTRICT` | **no key**; a **strict** checked reference against the retained `recruitmentCases` blob (the D-A device for `channels.request_id`, a second use) until S8b creates the table and rebuilds | `recruitment_cases` is S8b; D-A approved one column once and does not cover these two — **Q7b**; the alternative is S8a+S8b in one step (13 case tables more) |
| `trials.request_id` | `REFERENCES recruitment_requests(id) ON DELETE RESTRICT`, UNIQUE | **as drafted** | the parent row is upserted (phase 1) before any trial names it and pruned (phase 5) after its dependants are gone, so `RESTRICT` fires only on an intentional removal that forgot a dependant; the UNIQUE value changes hands by departure-then-arrival (phase 2a before 2b), never in place |
| `recruitment_requests.trial_id` | `REFERENCES trials(id) ON DELETE SET NULL` | **as drafted** | the back-reference of a bidirectional pair: inserted NULL / parked NULL where it changes (phase 1), assigned after the trial exists (phase 3); `SET NULL` fires only at an intentional trial departure (phase 2a) and phase 3 rewrites what it touched — deferral is neither used nor would it stop the action |
| `channels.request_id` | code-checked (D-A) | **`REFERENCES recruitment_requests(id) ON DELETE RESTRICT`** in the `channels` rebuild of the same migration | the conversion D-A approved "until S8a"; the preflight proves every `request_id` resolves (true by construction if the check has held) |
| `recruitment_requests.org_id`, `trials.org_id`, `trial_reports.org_id` | `REFERENCES orgs(id) ON DELETE RESTRICT` | **as drafted** | `orgs` is written by upsert-and-prune already (why `channels.org_id RESTRICT` works today); O2 blocks nothing |
| `recruitment_requests.user_id` | `REFERENCES org_users(id) ON DELETE RESTRICT` | **as drafted** | `org_users` is replaced-and-pruned, parent-preserving |
| the child tables' `request_id` / `trial_id` | `CASCADE` (`RESTRICT` on `trial_reports`, `trial_history`) | **as drafted** | owned rows, rewritten by their owner's writer (delete + insert in list order); a cascade fires only on an **intentional** departure of the owner, and the two `RESTRICT` children are deleted explicitly, first, in that same departure — a `DELETE FROM trials` that forgot them is refused, which is what `RESTRICT` is for |
| `recruitment_requests.contact_id`, `.contact_channel_id`, `trial_session_evidence.box_session_id` | no key | no key | contacts are S8c, Box Cam is S12 |

**The write algorithm (corrected, D1 — one algorithm for the cutover import, a restore, every route write staged
into its save, a full snapshot and a partial snapshot).** The first probe, `probe-request-trial-actions.mjs`, showed
what the drafted actions do (delete-and-reinsert of `trials` nulls `recruitment_requests.trial_id`; delete-and-reinsert
of requests is refused by its `RESTRICT` children, or with `PRAGMA defer_foreign_keys` commits and cascades
`request_trial_slots` away) and that re-upserting an **existing** pair fires nothing — but it never tried a **new**
pair or a **replacement**, and the review's script showed both fail under "requests upserted with their final
`trial_id`, then trials": the request names a trial that does not exist yet (D1a, `FOREIGN KEY`), and a replacement
trial arrives while the old one still holds `UNIQUE(trials.request_id)` (D1b, `UNIQUE`, deferral or not — SQLite
defers foreign-key *checks*, never `UNIQUE`, and never the `SET NULL`/`CASCADE` *actions*). The corrected write runs
inside the one save transaction (the store's `write()`), with constraints **immediate** throughout — no
`defer_foreign_keys`, so every refusal names the statement and the row — in six phases:

1. **Requests, back-reference parked.** Every supplied request is upserted (`INSERT … ON CONFLICT(id) DO UPDATE`,
   parent-preserving). A NEW request is inserted with `trial_id` **NULL**; a SURVIVING request keeps its stored
   `trial_id` only when it already equals the final value (the unchanged pair), otherwise it is parked NULL. Its owned
   slots are rewritten (delete, insert in list order).
2. **Trials** (corrected after the reviews of `cd7dc95` and `f2121b5`). (a) **Departures** = stored trials the
   snapshot no longer lists + stored trials whose supplied `request_id` differs — and nothing else. `request_id` is the
   pair's key: a change of it is a real reassignment or removal, so its request back-reference is *meant* to change
   (`UNIQUE(request_id)` changes hands by departure and arrival, never by an in-place re-key). Their `RESTRICT`
   children (`trial_reports`, `trial_history`) are deleted explicitly, then the trial row (`CASCADE` takes the rest;
   `SET NULL` clears the request that named it — the supplied requests rewrite theirs in phase 3; an omitted request
   keeps NULL, which is right for a removal and is refused by the pair assertion for a reassignment). **A changed
   `case_id` is not a departure** (the f2121b5 defect: it deleted a surviving trial, `SET NULL` erased a retained link
   that was not meant to change, and a partial save was refused). (b) **Releases** = surviving trials whose stored row
   holds a slot of `trials_one_open_per_case` (`case_id` not NULL, `workflow_state` open) and whose final row does not
   hold **that same slot** — it is terminal, or in another case, or caseless: a **parent-preserving `UPDATE` that parks
   `case_id` to NULL** — nothing deleted, children untouched, no `SET NULL`, the request row untouched — for every
   such trial **before any arrival**. (c) **Arrivals and the rest:** every supplied trial is upserted with its final
   `case_id` and `workflow_state` (new rows; departed rows re-inserted; parked survivors receive their final case; a
   terminal trial re-entering the predicate — no route does that today, a restore may carry it) and its owned
   containers rewritten in list order (sessions, evidence, revisions, attendance, reminders, day tables, history,
   report). **Why the input order does not matter — stated precisely:** when (c) begins, every row that holds a case
   slot is a survivor that holds that same slot in the final graph (a *final holder*: members that leave or change case
   were parked in (b); trials that change request were deleted in (a)); a terminal survivor that will re-enter is **not
   yet** a member — it becomes one at its own arrival; so any `UNIQUE` refusal inside (c) is a conflict between two
   rows that both hold the slot in the final graph (two open trials in one case), whatever the array order. A plain
   sort of the input is not relied on; `defer_foreign_keys` is not used and would not defer a `UNIQUE` check anyway.
   **Why a retained link survives a partial save:** a case-only change never deletes the trial, so
   `recruitment_requests.trial_id` is never touched by an action; the pair assertion then finds the unchanged pair
   intact without any request being resent — and no link is ever *reconstructed* from a trial: a new or replacement
   trial whose retained request does not name it is refused.
3. **Requests, back-reference assigned.** `UPDATE recruitment_requests SET trial_id = <final>` for every supplied
   request — the trial exists now; an id that resolves to nothing is refused here.
4. **Channels** — the S7d replace, `request_id` now a real key: a channel naming a request outside the final table is
   refused at its `INSERT`.
5. **Requests pruned** — stored requests the snapshot no longer lists (`CASCADE` takes the slots); a request still named
   by a trial or a channel refuses the save by `RESTRICT`: an intentional removal removes its dependants in the same
   snapshot.
6. **Final-state assertions** (whenever either table, `channels`, `recruitmentCases` or the identity pair was written):
   `PRAGMA foreign_key_check` empty; the bidirectional pair (every trial's request names that trial; every request's
   trial names that request); every `case_id` in the final `recruitmentCases` (Q7b, if approved strict); every guardian
   column in the final `guardians` (Q7c, if approved strict); every channel's request resolves (the key's job, kept as
   a message-quality check). A failure throws with ids only and the whole save rolls back.

Inside `writeTableBacked` the order is: orgs → identity → playersRetained → users/sessions → media queue → **phases
1–5 above** → the existing prunes → codes → notifications → the audit group → **phase 6**. **Omitted collections**
keep their rows (the partial-snapshot contract) and the retained side judges the supplied one: a snapshot that
supplies `trials` and omits `requests` is checked against the retained requests (a new trial its retained request does
not name is refused by the pair assertion; an empty `trials` list prunes every trial, children explicitly, and `SET
NULL` leaves each request consistent); one that supplies `requests` and omits `trials` likewise (a request naming a
trial that is not retained is refused in phase 3; removing a request whose trial is retained is refused in phase 5);
one that supplies `channels` and omits `requests` is checked by the key (today's `readRequestsBlob` becomes a table
read). **A case-only change to a surviving trial (case-1 → case-2, case-1 → NULL, NULL → case-1, a swap of two open
survivors) with `requests` omitted persists exactly what the same change with the unchanged requests supplied
persists** — the omitted collection is retained, not required (the review of `f2121b5`). **Parent rewrites:** the identity rewrite touches no recruitment row (no identity key); an `orgs` rewrite is
upsert-and-prune already. **Proof** (`probe-s8a-write-algorithm.mjs`, the drafted DDL for the six request/trial tables
plus a synthetic `channels` with the proposed key; exact rows of all seven tables compared, and after every refusal the
canonical dump unchanged and no transaction open): an empty database receiving a complete new request/trial/channel
graph; the unchanged graph re-saved byte-identically; a valid replacement trial (old trial and children gone, new
present, `trial_id` moved, the request's slots untouched); the reversed input order (identical dump); partial snapshots
with either side omitted; deliberate invalid final references (trial → missing request, request → missing trial,
channel → missing request, a pair mismatch, a request removed while its trial/channel stay, two trials naming one
request); an intentional removal with its dependants; a swap of two surviving trials; owned children preserved across
an unrelated change. The **control** runs the a6c40f3 order on the same inputs and reproduces D1a and D1b. **That
probe installs none of the drafted indexes and binds no `case_id`, so it proves nothing about the partial index** —
the gap the review of `cd7dc95` found. **Proof of the corrected phase 2** (`probe-s8a-write-algorithm-cases.mjs`: the
same six drafted tables with **every drafted index of those tables installed from file 02** except the withdrawn
`one_pending`, `case_id` bound on every trial row, two synthetic cases, the synthetic `channels` with the proposed key;
exact rows of all eight tables; **every valid final graph written in both trial orders and the dumps compared**;
every refusal followed by an unchanged dump and no open transaction): completion and cancellation each followed by a
new open trial in the same case; the released survivor's history and report rows byte-identical (no departure
happened); two open trials left in one case refused in both orders; a terminal trial re-entering the predicate,
accepted when the other open trial leaves in the same snapshot and refused when it stays; case-key handoffs between
survivors (a swap of `case_id` between two open trials; a survivor leaving its case while a new open trial takes it)
— no route re-cases a trial (only `request.caseId` is set, at invitation, `trialRoutes.mjs:409`), so these are
outside the routes' input contract and handled by the snapshot/restore contract as departure + arrival; the empty
database with two open trials in two cases; the `request_id` replacement and swap; the partial snapshots (a
trials-only completion lands: the release needs no `requests`); the invalid references including a missing case. The
**control** runs the cd7dc95 phases (departures by `request_id` only, no releases) and reproduces the reviewer's
order dependence. **That probe's writer still departed on a changed `case_id`** — the gap the review of `f2121b5`
found; its full-snapshot results stand, its partial-save results do not cover a case-only change. **Proof of the
corrected phase 2 across partial saves** (`probe-s8a-write-algorithm-partial.mjs`, the same model; **every
requests-omitted save compared, as an exact dump of all eight tables, with the equivalent full save on an identically
seeded database, in both trial orders**): case-1 → case-2, case-1 → NULL, a swap of two open survivors, NULL →
case-1, a same-case completion — all identical to the full save; the released survivor's history rows and the request
rows byte-identical (nothing deleted); the controls each refused with the prior rows restored and no open transaction
— an actual request reassignment with requests omitted, a missing case, a replacement trial and a new trial that the
retained request does not name, conflicting supplied back-references (supplied values are authoritative), two open
trials left in one case in both orders; a deliberate trial removal with requests omitted leaves the back-reference
NULL (the documented prune); and the earlier guarantees re-proven under the corrected phases (completion/cancellation
then a new open trial in both orders, re-entry accepted only when the holder leaves, the `request_id` swap and
replacement, the new graph in both orders, the invalid references). The **control** runs the f2121b5 phases and
reproduces the reviewer's three refusals. **What the model does not exercise and therefore does not claim:**
`trial_session_evidence`, the revisions, attendance, reminders and day tables, `idempotency_keys`, the full column
mapping — it is a design model, not a production mapper; those are the implementation's tests (§D.7.6).

**The same category checked for every other retained unique constraint in this write strategy** (a conflict can
only be an ordering artefact where a unique key is held by a *surviving parent row written by upsert*; children are
rewritten whole per owner — every row of the owner deleted, then the list inserted — so a child never meets its own
stale row): `trials.request_id UNIQUE` → departure + arrival (above); `trials_one_open_per_case` → a parked release for
every exit from a slot, by state or by case key (above; never a departure, which would erase a retained link); `request_trial_slots UNIQUE(request_id, day)`,
`trial_reports UNIQUE(trial_id)`, `trial_session_evidence_one_active`, `trial_day_consents_one_per_actor`,
`idempotency_keys` primary key `(owner_table, owner_id, act, key)` → all keyed by their owner and rewritten whole with
it, no cross-owner handoff possible; `channels_request_id` → the S7d replace deletes every thread before inserting
(and a handoff of a request between threads is already refused by the routes); `recruitment_requests` → primary key
only (`one_pending` withdrawn, D2); `recruitment_cases_one_open_room` and the offer/package/signing indexes → not in
S8a-core (S8b and later; the same rule applies when their tables are written). No constraint is dropped to hide an
ordering problem; the D2 withdrawal stands on its own ground (a writer that bypasses the rule today), as written.

**Two different failure contracts, stated so they are not confused (both already the store's, `store.mjs:200–235`).**
An **ordinary staged save** (a route's `persist()`/`persistNow()`): the route changed the mirrors (the request's status,
the new trial) and the SQL waits for the next save; if that save fails anywhere (a phase above, a blob write, COMMIT),
the transaction rolls back, the hooks discard what they wrote, and **memory is left as it is — the pending state is
retained and the next save retries everything still different from the committed state**. A **unit of work**
(`store.unitOfWork`, the deletion unit, the acceptance if it is one): on any failure the transaction rolls back **and
memory is restored to the pre-unit state in place** (the graph memento; each participating repository restores its
records and views), so no fragment of the failed operation is persisted later; retrying means running the whole unit
again. The S8a repository follows the S7d/S6b participant pattern (`snapshotState`/`restoreState`, `flush`, `commit`,
`rollback`) so both contracts hold for the request/trial mirrors exactly as they hold for channels.

#### D.7.6 Failure, rollback and proof

- **Atomic failure:** every write is staged into the route's next save or the enclosing unit; a failure before COMMIT
  and at the real COMMIT leaves every table, the mirrors (held nested views of a trial's `schedule`, `day`, `history`
  through the memento) and the revision unchanged; the retry lands once (the two contracts of §D.7.5). Negative tests:
  a request naming a missing guardian (Q7c strict), a case id not in the final cases (Q7b strict), a trial whose
  request is absent, a request whose trial is absent, a channel whose request the snapshot removes, a pair mismatch,
  two trials naming one request, an idempotency replay with a different fingerprint — each refused with ids only and
  nothing written. **Withdrawn (D2):** the "duplicate pending request" refusal — the storage step refuses nothing the
  routes accept today; the direct route's `REQUEST_PENDING` stays a route test, unchanged. **Added (D1, D3):** the
  positive cases of the write probes as repository tests (new pair, unchanged, replacement, reversed order, partial
  either side, intentional removal, swap, children preserved; **completion/cancellation followed by a new open trial
  in the same case in both orders, the released survivor's children untouched, two open trials in one case refused in
  both orders, a re-entry, the case-key handoffs; every case-only change with `requests` omitted equal to the same
  change with them supplied**) with the a6c40f3 order, the cd7dc95 phases and the f2121b5 phases as failing controls; the
  presence round trip for `blockedBy` (value / `null` / absent), `keys.accept`, `day` present/absent, the tombstone's
  `trialDetails.instructions`, and every `NOT NULL DEFAULT` column with its key absent — compared through the actual
  `trialClubView`, `trialFamilyView`, `tombstoneTrial` and `tombstoneRequest` outputs and the backup shape.
- **Copy-only rollback** `scripts/recruitmentRollback.mjs`: every row of the sixteen tables written back into the
  `requests` and `trials` blobs in insertion order in the writers' literals (tombstones included, containers nested,
  `keys` reassembled), `channels` rebuilt back to the `0012` definition without the key, the tables dropped, the record
  and meta key removed, the revision advanced; **nothing written after the cutover is lost**; refusals leave no output.
  Proven by booting the **actual `9b109dc` build** (`SCOUTBOX_PRE_S8A_SERVER`) on the copy: the same requests, trials
  and threads in its routes, a new request and an acceptance written there into its blobs, this build re-upgrading the
  copy with those writes. The `playerErasureRollback.mjs` tool refuses a file carrying the new record (the chain rule).
- **Performance** (required, because the step removes large blobs): the S6b bench extended with a `trials` fixture
  (schedules, revisions, day containers, histories), run on `9b109dc` and on the step's tree with the same fixture —
  rows and bytes serialised per save, the recruitment blobs' share, median/mean/p95 save time; reported as measured.
  **Claimed:** the two blobs leave every save. **Not claimed:** the whole-snapshot-write objective — every other blob
  is still rewritten by every save.
- **Tests written first and failing on the unchanged `9b109dc` tree:** a unit suite (the mapping round trip for every
  shape the writers produce — the P4B invitation with slots, a legacy trial, a scheduled trial with revisions,
  attendance, day containers and a report, both tombstones; the view and the staged writes; the §D.2a-style checks
  (a)–(f) for the request/trial/channel references in their strict forms; the partial-snapshot cases; the bidirectional
  assertion; the idempotency table) and a server suite (every route, the deletion unit's tombstones against a retained
  row and against a pre-S4b-R dangling id, the backup and a restore into a new directory, SIGKILL, the two failure
  seams, the rollback copy booted by the actual `9b109dc` build, the re-upgrade), plus the existing recruitment
  batteries (`m12*`, `m17*`, `m23*`, `apiE2E`, `connectedE2E`) and both milestone gates with the seven historical builds.

#### D.7.7 The decision brief — three categories

| Category | Items |
|---|---|
| **Already approved — not asked again** | the full birth date and the country code on the retained record; Q4 (audit), Q4b, Q5; D-A (`channels.request_id`, including its conversion to a key at S8a) and D-B; the under-18-without-valid-guardian refusal for live records; the copy-only rollback pattern; today's deletion behaviour (tombstones in place) |
| **Engineering choices — recommended here, decided at implementation, each proven by an exact-row test** | the six-phase write of §D.7.5 (immediate constraints, no deferral, departure before arrival, explicit prunes) and its final-state assertions; `extra_json`/`absent_keys_json` on both tables with the presence discipline of §D.7.3 (every draft omission withdrawn: `blockedBy`, `keys.accept`, `trialDetails.instructions`, `day` presence, the `NOT NULL DEFAULT` absences, `recipient.playerId` verified); the `trialReports` accessor over the table; the withdrawal of the `one_pending` index and of any other NEW unique index a writer bypasses (counted by the dry run, reported, never resolved by the migration); the bench's `trials` fixture; the mirrors' memento participation. **None of these is a product decision; none was changed by the a6c40f3 review into one.** |
| **Founder decisions that block S8a-core** | **Q7a, Q7b, Q7c** below. Not needed: Q2, Q3, Q6, O2 (no organisation is deleted; `RESTRICT` encodes nothing new), the whole-snapshot-write objective |

**Q7a — the player references on recruitment rows (refreshed; the "before S4b" wording is gone).** May
`recruitment_requests.player_id` and `trials.player_id` ship **without** a `players(id)` foreign key, as the file
drafts them, under the meaning in §D.7.4 — a live id resolves, a retained id resolves to the retained record, a
historically missing id is preserved and counted, never refused, never given a fabricated record? *Kind:* technical
design approval of a tolerant historical reference (the D-A kind; Q4 does not cover it). *Options:* **approve
(recommended)** — S8a-core as above; the key arrives, if ever, through Candidate F and a decided Q3, with a rebuild.
**decline** — S8a waits for Candidate F and Q3 (no retained-record step helps: the snapshot rewrite is the obstacle).
*Consequence of approving:* nothing observable changes; the import and the report count the unresolved ids.

**Q7b — the two case references.** May `recruitment_requests.case_id` and `trials.case_id` ship as **strict checked
references** against the `recruitmentCases` collection (the D-A device, a second and third use: the writer resolves
the case, the import refuses an unresolved id with ids only, the final state is asserted) until S8b creates
`recruitment_cases` and rebuilds the two tables with the real key — or must S8a grow to S8a+S8b (the 13 case tables, the
rooms, decisions, snapshots and comments: more than doubling the step)? *Kind:* technical design approval. *Options:*
**approve the checked references (recommended)** — S8a-core stays bounded; S8b's rebuild is a known cost of the
create–copy–drop–rename kind. **combine** — one larger step, one review, the same approvals later. *Consequence of
approving:* a case id that resolves to nothing in legacy data refuses the cutover until fixed by hand (the dry run
lists them first).

**Q7c — the guardian references on recruitment rows.** May `recruitment_requests.guardian_id`,
`recruitment_requests.recipient_guardian_id` and `trials.recipient_guardian_id` ship **without** the drafted
`guardians(id) ON DELETE SET NULL` key, as **strict** checked references (the Q4b pattern)? *Kind:* technical design
approval. *Why the drafted key cannot ship:* `SET NULL` fires at the guardian DELETE of every identity rewrite,
regardless of deferral (§D.2a, verified), so every snapshot save would null the recipient of every routed request;
preventing that is Candidate F's A1–A3. *Options:* **approve strict (recommended)** — a request naming a guardian that
does not exist is a defect and is refused, as `idv_queue` and `channels` do today; the dry run counts any legacy
mismatch before the cutover. **approve tolerant** — unresolved guardian ids counted, never refused (weaker; the writer
always resolves the guardian today, so nothing is gained). **decline** — S8a waits for Candidate F.

**Not asked:** anything about retention, correction or deletion of recruitment data; a product-wide one-pending
rule for invitations (the open-day route has none today and keeps none — §D.7.3, D2 — and whether one should exist is
undecided and outside this brief); Q2, Q3, Q6; the organisation lifecycle (O2); any UI change. No answer is inferred
from this section, from an earlier recommendation, from the a6c40f3 review or from silence. **This corrected brief is
itself awaiting independent review and is not yet put to the Founder.**

#### D.7.8 Evidence for this section

- `probe-request-trial-actions.mjs` and its output, and the bench report on `9b109dc` (`logs/bench-9b109dc.json`: 1
  blob row, 77 811 bytes serialised per save, median 1.64 ms, on the S6b fixture of 400 requests), in the handoff of
  the acceptance milestone (`a6c40f3`).
- The independent review of `a6c40f3`: `review-a6c40f3-design-checks.mjs` (D1a, D1b, D2, D3 reproduced; exit 0 means
  the hazards are reproduced, not that the design passes) — its output on `a6c40f3` and on this tree are in the
  handoff of this correction, unchanged.
- `probe-s8a-write-algorithm.mjs` (20 checks: the six-phase write on the drafted DDL, exact rows, rollbacks, the
  a6c40f3 order as the control), `probe-s8a-open-day-roundtrip.mjs` (5: the unchanged handler's invitations stored
  and round-tripped without the withdrawn index, the index's refusal as the control, the one-transaction outcome +
  invitation), `probe-s8a-lossless-fields.mjs` (8: presence round trips through the actual `trialClubView`,
  `tombstoneTrial` and `tombstoneRequest`, the a6c40f3 mapping's loss as the control) — run on Node 22 and 24, in the
  handoff of the first correction (`cd7dc95`).
- The independent review of `cd7dc95`: `review-cd7dc95-case-handoff.mjs` (the cd7dc95 writer unchanged, the actual
  drafted `trials_one_open_per_case` installed, `case_id` bound; exit 0 means the hazard **and** the opposite-order
  positive control reproduced — baseline evidence, kept unchanged, its expected failure not rewritten) and
  `probe-s8a-write-algorithm-cases.mjs` (13 checks: the corrected phase 2 with the drafted indexes installed, both
  input orders, the cd7dc95 writer as the control) — run on Node 22 and 24, in the handoff of the second correction.
- The independent review of `f2121b5`: `review-f2121b5-partial-case.mjs` (the f2121b5 writer unchanged; the three
  case-only changes refused with `requests` omitted and committed with them supplied; exit 0 means the hazards and
  controls reproduced — baseline evidence, kept unchanged) and `probe-s8a-write-algorithm-partial.mjs` (20 checks:
  the parked release, every partial save equal to its full save in both orders, the controls, the earlier guarantees
  re-proven, the f2121b5 phases as the control) — run on Node 22 and 24, in the handoff of the third correction.

All probes are synthetic and disposable, kept outside the tracked source; nothing was added to the application, the
schema file, a migration or a test.

### D.8 S8a-core as implemented (22 October 2026, one commit on `feat/sqlite-schema` on top of `d0f0205`, corrected once after the independent review of `6d77aa7` — §D.8.10; written while AWAITING INDEPENDENT ACCEPTANCE — implemented with review corrections, not accepted)

**Status.** S8a-core — `requests` and `trials` as tables (`recruitment_requests`, `request_trial_slots`, `trials` and
its eleven owned child tables, `idempotency_keys`; `channels` rebuilt with the real `request_id` key) — is
**implemented** behind migration `0015_recruitment` (REGISTERED, `repositories/index.mjs`), on the design of §D.7 as
corrected three times and **independently accepted at `d0f0205`** (the review of `d0f0205` accepted the parked-release
design of §D.7.5 and closed the D1, D2, D3, case-handoff and partial-save findings; nothing in §D.7 is changed by this
section — it records what was built against it). The implementation is **not independently accepted**; it is not
production, security, legal-compliance or deployment approval; **S8b is not started; the full migration is not
complete; the whole-snapshot-write objective is not met** (§D.8.7). The next free migration identifier is `0016`.

#### D.8.1 Authorisation — the three answers, verbatim

Asked after the design acceptance at `d0f0205`, answered by the Founder on 22 October 2026 before any source change,
recorded here and not to be asked again:

| Decision | The Founder's answer, verbatim | Meaning in the implementation |
|---|---|---|
| **Q7a** — the player references on recruitment rows | **"Approve tolerant (Recommended)"** | `recruitment_requests.player_id` and `trials.player_id` carry no key; a live id resolves, a retained id resolves to the retained record, a historically missing id is preserved and **counted** (`meta.recruitmentCutover.players.{live, retained, missing}` at import; `/capabilities` `dataLayer.domains.recruitment.unresolvedPlayerReferences` and `retainedPlayerReferences` live) — never refused, never given a fabricated record, never deleted |
| **Q7b** — the two case references | **"Approve strict checks (Recommended)"** | `case_id` on both tables carries no key until S8b; every write (`addRequest`, `addTrial`, the flush) and every import or snapshot refuses with ids only (`RECRUITMENT_CASE_MISSING`) a case id that is not in the FINAL `recruitmentCases` collection (the supplied one, or the retained blob), and the final state is asserted on every save that touches either table, the cases blob or the identity pair |
| **Q7c** — the guardian references | **"Approve strict (Recommended)"** | `guardian_id`, `recipient_guardian_id` (requests) and `recipient_guardian_id` (trials) carry no key (the drafted `SET NULL` would fire at every identity rewrite); a write or import naming a guardian that is not in the `guardians` table is refused with ids only (`RECRUITMENT_GUARDIAN_MISSING`); the final state is asserted on every save that touches either table or rewrites the identity pair — an identity-only rewrite that removes the guardian a minor's invitation names is refused whole |

Preserved, not asked again: D-A (`channels.request_id`, now converted into the real key), D-B (a deleted player's
threads deleted explicitly), the full birth date and the country code on the retained record, Q4/Q4b/Q5 (the audit
tables), the legacy-minor stop rule, the copy-only rollback pattern, today's deletion behaviour (tombstones in place).
Still open, untouched: Q2, Q3, Q6, O2, a product-wide one-pending rule for invitations (the open-day route keeps its
several pending invitations — D2), the whole-snapshot-write objective.

#### D.8.2 What was built

- `repositories/recruitment.mjs` — the shapes (the writers' literals key for key), the generated DDL
  (`RECRUITMENT_DDL`, sixteen definitions with `CHANNELS_DDL_WITH_KEY`), the mapping engine (encode/decode with
  `absent_keys_json`, `offtype_json`, `extra_json`, `raw_json`), the validation (`validateRequest`, `validateTrial`,
  `validateCollections` — ids only), the six phases (`phases123`, `prune`, `assertRecruitmentConsistent`), the
  whole-snapshot access (`RECRUITMENT_SNAPSHOT.read/replace/prune`), the import (`importRecruitmentBlobs`) and the
  repository (`createRecruitmentRepository`: `requestsView`, `trialsView`, `addRequest`, `addTrial`,
  `tombstoneForPlayer`, `trialReportsFor`, `exportRequests`, `exportTrials`, `counts`, `pending`, the save hook with
  `flush`/`commit`/`rollback`/`snapshotState`/`restoreState`).
- `repositories/migrations/0015_recruitment.mjs` — runs after `0014` inside the runner's one transaction with foreign
  keys OFF (the `channels` rebuild drops a table `messages` references; `PRAGMA foreign_key_check` must be empty before
  COMMIT): creates the fifteen tables, imports the file's `requests` and `trials` blobs through the repository's own
  validation (never from the seed, never from memory), rebuilds `channels` with the key (every thread, message and
  attachment copied back with its seq/position — byte-identical, tested), retires the two blob rows, records counts
  only in `meta.recruitmentCutover`. Any refusal aborts the step with `RECRUITMENT_IMPORT_BLOCKED` and the specific
  refusal in the detail (an invalid entry, `PAIR_MISMATCH`, `RECRUITMENT_CASE_MISSING`, `RECRUITMENT_GUARDIAN_MISSING`,
  `RECRUITMENT_ORG_MISSING`, `RECRUITMENT_USER_MISSING`), ids and positions only; the runner rolls back and the next boot
  refuses the same way.
- `repositories/recruitmentRollback.mjs`, `scripts/recruitmentRollback.mjs` (`npm run rollback:recruitment`) — §D.8.6.
- `repositories/index.mjs` — `0015` registered; `requests` and `trials` in `TABLE_BACKED`; `readTableBacked` reads
  both from the tables; `writeTableBacked` runs phases 1–3 after the media queue, the channels replace (phase 4), the
  request prune (phase 5) before the staff and organisation prunes, and phase 6 at the end; `attachDataLayer` attaches
  the recruitment repository BEFORE the channels repository (so a thread's request row lands in the same save before the
  thread row), drops the in-memory arrays (a restored backup's blob is what the migration imported; a stale copy is
  reported and its blob row deleted), defines `db.requests` / `db.trials` as the read-only array views, late-binds the
  identity repository's `trialReports` accessor to `recruitment.trialReportsFor`, and reports the domain in
  `/capabilities` (`mode: 'live'`, row counts, pending writes, the two player-reference counts, the reference policy).
- Callers converted (every route payload unchanged): `server.mjs` — the direct invitation (`recruitment.addRequest`),
  the open-day outcome route (`addRequest`), `issueAcceptedTrial` (`addTrial`), the deletion unit
  (`recruitment.tombstoneForPlayer` in place of the two array replacements; `tombstoneRequest`/`tombstoneTrial` stay the
  writers); `m13/enterprise.mjs` — the backup exports `requests` and `trials` through the repository (detached copies in
  the legacy shapes). Every other reader and in-place writer (twenty-five modules) is untouched: the records the views
  hold are the mutable objects those modules edit, and the next save's flush writes the changed ones.
- `repositories/channels.mjs` — `readRequestsBlob` reads the table once `0015` is recorded (the channel checks keep their
  meaning); `repositories/identity.mjs` — the trialReports reconciliation reads the trials from the tables
  (`readTrialsCollection`) once `0015` is recorded; `repositories/users.mjs` — `replace(…, { prune: false })` and
  `prune()` (§D.8.5); `store.mjs` — `BEGIN IMMEDIATE` (§D.8.5).
- `docs/architecture/sql/02_recruitment.sql` amended to the implemented sixteen definitions (the rest of the file stays a
  draft); `03_messaging_safety_audit.sql` carries the `channels` key; `scripts/testSchemaDdl.mjs` compares the sixteen
  tables with the migration column for column and index for index.

#### D.8.3 The six phases, as implemented (plan §D.7.5, one algorithm for the import, a restore, a flush and a snapshot)

1. **Requests, back-reference parked** — `INSERT … ON CONFLICT(id) DO UPDATE`; `trial_id` NULL on insert; a survivor keeps
   its stored `trial_id` only when it equals the final one (`CASE WHEN … IS @trial_id THEN … ELSE NULL END`); slots and
   keys rewritten (delete, insert in list order).
2. **Trials** — (a) departures = stored trials not supplied or whose `request_id` differs: `trial_reports`,
   `trial_history` and the owner's `idempotency_keys` rows deleted first, then the row (the cascades take the rest,
   `SET NULL` clears the request that named it); (b) releases = survivors holding a `trials_one_open_per_case` slot whose
   final row does not hold that same slot: `UPDATE trials SET case_id = NULL` — never a delete; (c) arrivals: every
   supplied (or, in a flush, every changed) trial upserted with its final case and state, its children rewritten in list
   order.
3. **Requests, back-reference assigned** — `UPDATE … SET trial_id = <final>` for every supplied (or changed) request.
4. **Channels** — the S7d replace, its key real; in a flush the channels repository's own hook, registered after.
5. **Requests pruned** — stored requests no longer listed; a thread still naming one is refused first with ids
   (`CHANNEL_REQUEST_MISSING`, the message the S7d check used), a trial still naming one by the pre-write check
   (`PAIR_MISMATCH`, ids) or the `RESTRICT` key.
6. **Final-state assertions** — the pair (`r.trial_id IS NOT t.id` only where the request's `trialId` key is PRESENT:
   the pre-P4B pair — a request without the key beside its trial — is tolerated and counted as `legacyPairs`), every
   `case_id` in the final `recruitmentCases` (Q7b), every guardian column in the final `guardians` (Q7c), every org and
   staff id (ids first, then the keys). A refusal throws with ids only inside the save transaction.

A **flush** (server mode) writes only the records whose committed fingerprint (`JSON.stringify` of the record, taken at
the last COMMIT) differs, removed ids pruned, then asserts the final state against the live `recruitmentCases`; a failed
ordinary save keeps the records as they are and the next save lands them once (fingerprints follow COMMIT only); an
aborted unit of work restores both mirrors through the graph memento — every record, nested object and array by
identity, so a held `trial.schedule` reads the pre-unit value — and the edits pending before the unit stay pending.
Proven in `scripts/testRecruitment.mjs` (both trial orders, the unchanged save byte-identical, replacement, swap,
completion/cancellation then a new open trial in the same case in both orders, re-entry only when the holder leaves,
every case-only change with `requests` omitted equal to the full save, the deliberate removal, two open trials refused in
both orders, missing request/trial, pair mismatch, a new trial for a request naming null, reassignment with requests
omitted, missing case supplied or retained — a cases-only change included —, missing guardian supplied or by an
identity-only rewrite, a request removed under its trial or its thread, a channel naming a request outside the table, a
malformed collection; the statement failure, the real COMMIT failure, the joined failure, the caught participant
refusal; held nested views; the hook-registration precondition).

#### D.8.4 The lossless mapping, as implemented (§D.7.3, D3)

Every scalar of the writer's literal is a column of the same nullability the writer has — no `NOT NULL DEFAULT`, no
vocabulary or length `CHECK` (a storage step changes no product rule; the identifiers the keys need are `NOT NULL`);
every known nested object (`trialDetails`, `trialDetails.private`, `recipient`, `schedule`, `schedule.proposedBy`, …,
`completion`, `lifecycle`, `revBy`, `day`, `day.arrival`, `day.emergency`, `day.collection`) is columns of the same row;
every list is a child table keyed `(owner…, position)` in list order (`trial_session_evidence` by `(trial_id,
session_position, position)`), a non-object element kept verbatim in `raw_json`; `reminders` is `trial_reminders`
(`sent_at` for an integer marker, `value_json` otherwise); `keys` is `idempotency_keys` for the replayable acts (a
NON-EMPTY list act's entries; a value act with a string key such as `keys.invite`) with the entry verbatim in
`entry_json`, while every other act stays on the owner row under `keys` in `extra_json` exactly as written —
`trials.keys.accept {key: null, fp}`, an EMPTY list act (no row could carry its presence), an empty object, a null, any
other value — so every act comes back present and distinct; acts are set as own data properties, so an act named
`__proto__`, `constructor` or `toString` is data (the review of `6d77aa7`, F1, §D.8.10). A known key
that is ABSENT is listed in `absent_keys_json` (dotted for nested keys) and comes back absent; a present `null` is NULL
and comes back null; a present value the column cannot hold is kept verbatim in `offtype_json` under its path; every
unknown own key at any level is kept in `extra_json` (nested extras under their known parent key) and spread back first;
a live `undefined` is absence and a non-finite number persists as JSON `null` (the blob's rules). `blockedBy` is
`blocked_by_json` (a value, `null` or absent); the tombstone's `trialDetails.instructions: null` is a present-and-null
column; the `day` container's presence is recorded; `recipient.playerId` is stored and counted when it differs from
`player_id` (`recipientMismatch`); a trial without a `workflowState` key stays without one (`preP4bShape` counted at
import; `isLegacyTrial` reads it as before). Round trips proven for every writer shape (the P4B invitation with slots,
private details, keys and recipient; the contact; the open-day literal with `trustedPartner` absent; the legacy direct
request; the accepted request; both tombstones; the scheduled, accepted, pre-P4B, worked and cancelled trials; unknown
fields at record, nested-object and list-entry level; off-type values; a live non-finite number) and through the real
routes, the backup, a restore and the rollback copy.

#### D.8.5 Constraints against the producers — what was found and what changed around the design

- `recruitment_requests_one_pending`: withdrawn (D2), as designed. `trials_one_open_per_case`,
  `request_trial_slots_one_per_day` (the drafted `UNIQUE(request_id, day)` as a partial index),
  `trial_session_evidence_one_active` (over `(trial_id, session_position, box_session_id)`),
  `trial_day_consents_one_per_actor`, `trial_reminders_marker`, `channels_request_id`: installed; no fixture, route or
  suite produced a conflict. A legacy file that does is refused at the cutover with the engine's `UNIQUE` message —
  **reported, never resolved by the migration** (the dry run on a copy lists it; §D.7.3).
- **The staff key and the snapshot write order.** `recruitment_requests.user_id → org_users` (RESTRICT, as drafted)
  made the staff prune, which `USERS_TABLE.replace` ran inside itself before the recruitment write, fail on any snapshot
  that removed a staff member together with their requests. Changed: `replace(…, { prune: false })` upserts only and
  `USERS_TABLE.prune` runs after the request prune (children before parents, like every other prune of the write); the
  sessions, which name the staff, are written after that prune, so a session of a staff member the snapshot no longer
  lists is still refused with its id, as before (`scripts/testSessions.mjs`). `0003_sessions_live` keeps the old
  one-call form. The organisation and staff ids of supplied requests are checked with ids against the FINAL supplied
  collections before the keys fire (`RECRUITMENT_ORG_MISSING`, `RECRUITMENT_USER_MISSING`).
- **`BEGIN IMMEDIATE` for saves and units of work** (`store.mjs`, two lines). The recruitment flush reads before it
  writes (the final-state assertions). A deferred `BEGIN` whose first statements are reads holds a WAL read snapshot;
  when another process commits in between, the later upgrade to a write fails at once with "database is locked"
  (SQLITE_BUSY_SNAPSHOT, which the busy handler never retries) — the S2 busy-timeout test failed that way on the first
  run. A save is a write transaction; it now takes the write lock at `BEGIN` through the busy handler, and the S2 test
  proves the wait. The unit-of-work suites' `BEGIN` seams were updated to the new statement.
- **The channels prune check.** A snapshot that removes a request while a thread still names it was refused by the S7d
  final-state check (`CHANNEL_REQUEST_MISSING`, ids) when `requests` was a blob; with the key it would be the engine's
  bare `FOREIGN KEY constraint failed`. The request prune names the threads first with the same code and ids.
- **The measured behaviour of the previous build on a `0015` file differs from the brief's prediction.** §D.7.6 expected
  the accepted `9b109dc` build to serve no requests and no trials. Measured on the actual build
  (`scripts/testRecruitmentServer.mjs`): its boot-contract integrity check finds the two collections ABSENT, logs
  `INTEGRITY STORE_MISSING requests, trials` and the process exits 1 before listening — nothing served, nothing written.
  Safer than predicted; the rollback tool is still the only way back (§D.8.6).
- **A legacy JSON snapshot older than schema 2304.** The snapshot migrations run on the loaded arrays before the data
  layer attaches; `m230_005_trial_workflow` backfills the P4B containers on every trial in memory and, on a blob file,
  the next save persisted them. Since `0015` imports the FILE's blob and never the array, a `db.json` from before M23 P4B
  restored directly onto this build keeps its pre-P4B trials as they were (counted as `preP4bShape`; readable through
  `isLegacyTrial`; the containers are added by the routes the first time they write). Backups written by any build with
  the SQLite store are at or beyond 2304 and unaffected. Recorded in OPERATIONS.md; not changed here (the rule "never
  import from memory" stands).
- **The M23 batteries' synthetic rows outside the writers' literals.** Running every `m12*`, `m17*`, `m23*`,
  `connectedE2E` and `apiE2E` script (§D.7.6) on this tree and on the untouched `9b109dc` build found five scripts
  whose fixtures write, straight into a snapshot, rows no production writer produces: a request without `userId` or
  with a made-up staff id (`m23ContactPersistence`, `m23RecruitmentJourneyHardeningE2E`, `m23P4AClosureE2E`;
  `issueRecruitmentRequest` always sets the logged-in staff member and the drafted `user_id` key is `NOT NULL …
  RESTRICT`), a request naming a staff member that is not in `users` (`m23TrialPersistence`, `m23TemporalIntegrityE2E`;
  the staff row is created by the dev login later in the script), trials naming requests that do not exist
  (`m23P4AClosureE2E`'s four "legacy" trials, `m23TemporalIntegrityE2E`'s `trial-p57`, `m23TrialPersistence`'s legacy
  trial; the drafted `trials.request_id` key), eight trials naming the same request (`m23TrialPersistence` §3;
  `UNIQUE(request_id)`) and six open-looking trials in one case (the same section; the kept product constraint
  `trials_one_open_per_case`, which treats every state other than completed/cancelled as open). The accepted design
  refuses each with ids (`RECRUITMENT_IMPORT_BLOCKED` naming the entry, `RECRUITMENT_USER_MISSING`, `PAIR_MISMATCH`,
  the engine's `UNIQUE` message) and repairs nothing. Those fixtures are adapted to the writers' literals with the
  reason stated in each (the staff row and the real id supplied; the invitation each trial came from supplied; one
  request per trial; the corrupt rows that were open made terminal while their corruption is unchanged). **What this
  means for a real file:** the P4A guarantee that a trial row with garbage FIELDS never breaks the app still holds
  (fields are kept losslessly; the routes still name and omit such rows); a trial whose `requestId` names no request,
  a request naming no staff member, two trials naming one request or two open trials in one case is a legacy
  inconsistency the cutover REFUSES with ids on a copy (§D.7.3's dry run) and an operator resolves by hand — the
  migration does not reconstruct, drop or rewrite a row. No production path produces such a row today (requests are
  tombstoned, never removed; staff are marked `removedAt`, never removed; the routes keep one open trial per case).
  Every other battery passes on this tree with the same count as on `9b109dc`; the failures of `m23BootContract`,
  `m23Persistence` and `apiE2E` are identical on `9b109dc` (pre-existing).
- **Key order.** A record read back from the tables carries its keys in the stored shape's order (`blockedBy`, for
  one, after `revBy`); the blob kept the writer's insertion order. Every key and value is identical — the route
  payloads are the same objects — but a textual `JSON.stringify` comparison across a restart is no longer byte-equal;
  `m23P4AClosureE2E` compared that way and now compares canonically (keys sorted at every level), reason stated.
- **The P4A tolerance of alien entries ends at the cutover.** `m23TrialPersistence` §3 proved that a `null`, a string
  and a number in the trials blob were ignored at boot ("never fatal"). Since `0015` imports the blob through the
  repository's own validation, such an entry is refused with its position and kind (`RECRUITMENT_IMPORT_BLOCKED: trials
  entry #1 is not an object (null) …`), nothing is imported, the file is not modified and the next boot refuses the
  same way — an operator fixes a copy by hand (§D.7.3's dry run). The seven corrupt-but-object rows of that section are
  still stored as they are and still named and omitted by the routes. The section now proves both contracts (§3, §3b).
- **Not changed, reported:** the direct route's `REQUEST_PENDING` rule and the open-day route's several pending
  invitations (both kept); the idempotency replay/conflict rules (in the routes, reading the record's `keys`); the
  trials' 50-entry cap per act (a writer rule kept as data); `players[].trialReports` derived, never stored.

#### D.8.6 Rollback, copy-only, and the chain

`npm run rollback:recruitment -- <data-dir> <fresh-empty-dir>` (`scripts/recruitmentRollback.mjs`,
`repositories/recruitmentRollback.mjs`): opens the live file read-only and copies it (VACUUM INTO), refuses a copy that
carries a later step (`LATER_SCHEMA`, exit 4), never applied `0015` (`NOT_CUT_OVER`, exit 5), whose tables are missing
(`UNEXPECTED_SCHEMA`, exit 10) or whose output directory is not empty (exit 1); writes every request and every trial back
into the `requests` and `trials` blobs in insertion order in the writers' literals (children nested in list order, keys
reassembled, every absent/null/off-type/unknown field as recorded); recreates `channels` in its `0012` definition (no
request key) with every thread, message and attachment row for row; drops the fifteen tables; removes the record and
`meta.recruitmentCutover`; advances `saveSeq`; checks every foreign key; VACUUMs; revalidates (integrity, the record
and meta key gone, the tables gone, the key gone, the threads row for row, both blobs holding exactly the counts, every
other table byte-identical). A failure at any step removes the output. **Nothing written after the cutover is lost.**
The chain: `playerErasureRollback.mjs` refuses a file carrying `0015` (`LATER_SCHEMA`) and accepts this tool's output;
every earlier tool and suite that rolls a live file back now starts with this tool (the suites' `preS6b`/`preS4bR`
helpers). Proof on the **actual `9b109dc` build** (`SCOUTBOX_PRE_S8A_SERVER`; `scripts/testRecruitmentServer.mjs`): the
rollback copy boots there, serves the same requests, trials and threads in its routes, accepts a new invitation and an
acceptance into its blobs, and this build re-upgrades the copy with those writes exactly; the same build booted DIRECTLY
on a copy of the live `0015` file exits 1 at boot (`STORE_MISSING`) and writes nothing.

#### D.8.7 Performance — measured, and what is not claimed

`bench-s8a.mjs` (in the handoff; synthetic fixture of 400 requests — half P4B invitations with slots and keys — and 200
worked trials with every container, on the fixture players; the accepted `9b109dc` modules against this tree's modules
on the same file; Node 22.22.0; median of 15 saves):

| | `9b109dc` (blobs), run 1 / run 2 | S8a-core (tables), run 1 / run 2 |
|---|---|---|
| one-record save (a trial's status + a pushed attendance row) | 12.2 / 19.6 ms | 13.4 / 17.3 ms |
| unchanged save | 7.5 / 10.8 ms | 8.9 / 13.1 ms |
| bytes `JSON.stringify` produced for the two collections per save | 1 422 874 (the two blobs) | 1 429 037 / 1 422 272 (the change-tracking fingerprints) |
| recruitment statements per one-record save | 0 (one blob row) | 36 (one trial row, its children rewritten, the assertions) |
| first boot (migrations + attach) / warm reboot | 29 / 20 ms; 28 / 19 ms | 486 / 216 ms; 544 / 197 ms |
| file size after the runs | 3.1 MB | 3.6 MB |

Two runs on the same machine (the second during the final gates); the save medians moved by more between the runs than
between the builds, so the save figures say only "within noise of each other".

**Claimed:** the two blobs leave every save; a changed record lands as its own rows; the rollback and the lossless round
trip. **Not claimed:** a faster save — the fingerprint pass still serialises every record on every flush (the same
bytes the blob cost), so the save time is unchanged within noise; the boot is slower (sixteen tables decoded into the
mirrors); the file is larger; **the whole-snapshot-write objective is not met** (every other blob is still rewritten by
every save). Cheaper change tracking (a version counter the twenty-five in-place writers would have to bump) is a
separate, undecided piece of work.

#### D.8.8 Tests and evidence

- **Failing-first** (recorded on the unchanged `d0f0205` tree, source-identical to `9b109dc`, before any source edit):
  `scripts/testRecruitment.mjs` and `scripts/testRecruitmentServer.mjs` fail there on the concrete assertion "the last
  registered/recorded migration is 0015_recruitment" (logs in the handoff).
- **New suites, green on the implementation:** `scripts/testRecruitment.mjs` (11 tests since the corrections of
  §D.8.10 — the nine below plus the F1 and F2 regressions: the migration and cutover
  counts, the lossless mapping of every writer shape, the import refusals with ids only, the repository in staged mode,
  the two failure contracts with the statement failure and the real COMMIT failure, the six-phase snapshot write with
  the reviewer's transition matrix as extra coverage, the atomic refusals, the snapshot read and the identity
  reconciliation against the table, the rollback tool and the chain) and `scripts/testRecruitmentServer.mjs` (3 tests:
  the real server — boot, the direct invitation and acceptance as rows with no blob behind them, listings, the staff and
  report routes, `REQUEST_PENDING`, SIGKILL durability, `/capabilities`; two stored open-day invitations and a request
  of a missing player through the backup/restore path, the deletion unit against a real COMMIT failure and its retry;
  the backup shapes, a restore row for row, the previous build on the live copy, the rollback copy, the chain, the
  `9b109dc` boot on the copy and the re-upgrade; since §D.8.10 five tests: the route-facing replay controls and the
  null-blob boot refusal added). Both in the `npm test` chain.
- **Existing suites adapted** (the reason stated in each): the migration list and the rollback chain (one link longer)
  in every suite that asserts them; the suites that used `requests` as "the unrelated plain blob" now use `vouches`;
  `testChannels` and `testChannelsServer` read the request rows; `testPlayerSubrecords` adds its trials through the
  repository with a request each; the dump exclusion lists; `testSchemaDdl` compares the sixteen tables.
- **Gates** (CLAUDE.md "Milestone gates"): the backend chain on Node 22 and Node 24 with the **seven** historical builds
  booted for real (`SCOUTBOX_PRE_S7A/S7B/S7C/S7D/S6B/S4BR/S8A_SERVER` = `812e13b`, `0641b2c`, `6ca66ba`, `b67bce5`,
  `4f954ad`, `f0abd34`, `9b109dc`), the Player suite — commands, versions, exits, counts and skips in the handoff's gates
  record. The two intermittent S6b failures of the `c6cf5e1` review remain "not reproduced; cause unresolved".
- **The batteries of §D.7.6** — every `m12*`, `m17*`, `m23*` script, `connectedE2E` and `apiE2E` (forty-two scripts,
  outside the `npm test` chain) — run one by one on this tree AND on the untouched `9b109dc` build, so that every
  failure is classified: the pre-existing failures of `m23BootContract`, `m23Persistence` and `apiE2E` are identical on
  both; five scripts whose synthetic fixtures write rows outside the writers' literals were adapted (§D.8.5) and pass;
  every other script passes with the same counts on both builds. The record (both runs per script, the adapted runs,
  the logs) is in the handoff.
- **The design-model scripts keep their baseline meaning.** The five synthetic probes of §D.7 and the reviewer's
  design-model scripts (`a6c40f3`, `cd7dc95`, `f2121b5`, `d0f0205`) model the DRAFTED file 02 and the pre-S8a handler
  source; they were re-run on an unchanged `d0f0205` checkout (Node 22 and 24) with the recorded results (probes
  20 / 13 / 20 / 5 / 8; the hazards and the matrix reproduced). On this tree they stop at the first implemented
  difference (file 02 now carries the implemented definitions; the open-day handler calls the repository) — recorded in
  the handoff, not rewritten. The retained-record scripts (`6d66655`, `9b109dc`) pass on this tree.

#### D.8.9 Known limitations (nothing hidden)

1. The save-time objective is not met (§D.8.7); boot is slower; the file is larger.
2. Dirty detection is a serialisation fingerprint per record per flush: correct, not cheap.
3. A legacy `db.json` older than schema 2304 restored directly keeps pre-P4B trials without the containers (§D.8.5).
4. `case_id` and the guardian columns are code-checked references until S8b (Q7b) and Candidate F (Q7c); a legacy file
   with an unresolved case or guardian id refuses the cutover until fixed by hand.
5. `/capabilities` counts unresolved player references; it does not say why an id is absent (Q3 untouched).
6. The cutover refuses, with positions and ids, a legacy file the blob store tolerated: an entry in `requests` or
   `trials` that is not a record, a trial naming no request, a request naming no staff member, two trials naming one
   request, two open trials in one case (§D.8.5). The P4A "never fatal" tolerance of alien entries ends there; the
   file is not modified and an operator fixes a copy by hand. No production writer produces such rows.
7. A record read from the tables carries its keys in the stored shape's order, not the writer's insertion order;
   values are identical (§D.8.5).
8. The implementation awaits independent acceptance; S8b (cases, rooms, decisions) is not started.
9. The F1 correction (§D.8.10) preserves every act from the moment it is in place. A database converted by the
   reviewed `6d77aa7` build would already have discarded an empty list act or a prototype-named act at its cutover or
   at a later save; nothing can reconstruct those from the tables — the authoritative original (the pre-cutover file or
   a backup written before the conversion) would be needed. No real database was converted by that build (the
   implementation is not deployed; the Founder authorised review only).

#### D.8.10 Review corrections (the independent review of `6d77aa7`; one commit, implemented, pending independent acceptance)

The review of `6d77aa7` left S8a-core **implemented, not accepted**, with two P2 findings and one ineffective test
assertion, reproduced by its two scripts (`review-6d77aa7-reproductions.mjs`: six failing cases;
`review-6d77aa7-mapping-matrix.mjs`: 3,150 snapshot round trips, six mismatches, all empty action lists). The accepted design (§D.7)
is not reopened; Q7a/Q7b/Q7c stay as recorded; the write phases, the reference checks and the product constraints are
unchanged. Corrected in one bounded commit:

- **F1 — every idempotency act preserved losslessly** (`repositories/recruitment.mjs`, the `keys` branch of
  `encodeLevel` and the `keys` decode of `readRecords`). Two mechanisms at one boundary: an act whose value was `[]`
  was placed in the row map but emitted no child row, so its own key disappeared (`keys.schedule: []` came back as no
  `schedule`); an own act named `__proto__` (own in the writer's object and own again after `JSON.parse`) was assigned
  with `rows[act] = entry`, which sets the prototype of an ordinary object, so it disappeared too. Now only a NON-EMPTY
  list act and a value act with a string key become `idempotency_keys` rows; every other act — an empty list, an empty
  object, a null, `keys.accept {key: null, fp}`, any other value — is held on the owner row under `keys` in
  `extra_json` exactly as written (the existing presence/extra mapping; no DDL change, no new refusal, nothing renamed),
  and every act is set and read as an OWN data property (`__proto__`, `constructor`, `toString` are data). Non-empty
  lists keep their order, duplicates and fingerprints; replay and conflict behaviour, expiry, the routes and the
  product constraints are untouched. Proven for both collections through the cutover, a whole-snapshot save, the staged
  repository (in place, an unchanged save writing nothing), a reopen, the copy-only rollback and the re-upgrade
  (`scripts/testRecruitment.mjs`), and through the real routes — an invitation's `clientKey` replays and conflicts, a
  reschedule's `clientKey` replays across a restart, a backup, a restore, the rollback copy (the pre-S8a build replays
  the same key from its blob) and the re-upgrade, with the hand-written acts beside the real key
  (`scripts/testRecruitmentServer.mjs`). The reviewer's matrix: 3,150 round trips, zero mismatches, zero refusals.
- **F2 — a present `null` blob refused** (`importRecruitmentBlobs`). `read(name) ?? []` turned a PRESENT row holding
  JSON `null` into an empty collection before the shape check, so migration `0015` completed, removed the malformed blob
  and recorded itself. Now only a genuinely ABSENT row defaults to `[]`; a present `null` refuses with
  `RECRUITMENT_IMPORT_BLOCKED: the <name> blob must be an array of entries (got null)` like an object, a string or a
  number — no table created, the blob, the record, `saveSeq` and every other row untouched, no transaction left open,
  the next attempt refused the same way; absent blobs and explicit `[]` still cut over. Proven on both collections in
  the unit suite and through a real boot on a pre-S8a file (the rollback tool's own output and a file the `9b109dc` build
  wrote): the server exits 1 before listening and the file is left as it was. Control: a `null` collection in a
  `db.json` is refused earlier by the legacy import (`LEGACY_IMPORT_FAILED`), never served.
- **C1 — the rollback test's source-preservation check made real** (`scripts/testRecruitment.mjs`). The assertion
  `bytesEqual || true` could not fail. The test now establishes a controlled boundary (`PRAGMA wal_checkpoint(TRUNCATE)`
  with every connection closed, so the file pair is stable and the WAL carries no frame), records the SHA-256 of the
  main file, the WAL's byte count, the logical content of every table and the revision, and requires all four to be the
  same after the tool ran and again after an injected failure before the tool's COMMIT (which also leaves no output).
  The source held on the reviewed tree too (the defect was coverage, not behaviour): the check passed on `6d77aa7`.
- **Failing first.** The F1 and F2 regressions were recorded failing against the unchanged `6d77aa7` source before the
  correction (the unit F1 at the cutover read-back, the unit F2 on "missing expected exception", the server F1 at the
  backup export, the server F2 with the server listening over a null blob); the reviewer's two scripts, unchanged, exit
  1 on `6d77aa7` and 0 on the corrected tree (logs in the handoff).
