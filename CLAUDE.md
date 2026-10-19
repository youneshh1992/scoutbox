# ScoutBox — approved Agent, Pro, Player and Grassroots UI

## Architecture rules — 9 October 2026

These rules follow the Founder's acceptance of the October 2026 architecture
review. They apply to every tool and person working in this repository and sit
alongside the design approvals below, which they do not change.

### Trunk, branches and approvals

- `main` is the trunk and is always the current product. Every change branches
  from `main`, is named after the change (`fix/org-login-roles`,
  `refactor/data-layer-users`), merges back through a pull request with green
  CI, and is deleted afterwards. Nobody continues another tool's branch; the
  pull request is the handoff.
- Approved baselines are annotated tags (`<app>-ui-approved-<date>`,
  `<app>-baseline-<date>`), not commit hashes in prose. Pushes, merges to
  `main`, tags and deployments happen only on the Founder's explicit
  instruction, and never with a force-push.
- Scratch files, backups and generated bundles stay out of Git. Do not add new
  top-level milestone report files; record durable decisions in the relevant
  README, `scoutbox-server/OPERATIONS.md` or this file.

### Feature freeze

Until the data-layer rebuild below is complete, no new product features are
started. Work in scope: defects, security, the rebuild itself, test coverage,
and design changes the Founder explicitly requests.

### Server structure

- No new top-level `db.<collection>` arrays and no new `migrateMxx` collection
  lines. New persistent state is a table owned by a domain repository under
  `scoutbox-server/repositories/`, created by a versioned migration in
  `repositories/migrations/`, written per row inside a transaction. Every
  write to a migrated domain goes through its repository; the old
  `db.<collection>` is that repository's read-only view (a direct write
  throws), which existing readers may keep using until the domain's readers
  move to repository queries. Unmigrated domains keep working as they are
  until their turn. Migrated so far: `users` (staff accounts, `org_users`,
  STRICT with a real `org_id → orgs` foreign key since S3), `sessions`
  (`repositories/sessions.mjs`: tokens stored only as `token_hash`, returned to
  the client once; every session read, creation and revocation goes through
  the repository, never through `db.sessions`) and `orgs`
  (`repositories/orgs.mjs`: identity, plan, verification flags, suspension,
  password hash, e-mail domain, MFA policy, location and federation reference
  are columns and change only through `orgs.insert` / `orgs.update`; the
  nested facets `tactical`, `squad`, `lookingFor`, `federationCheck`,
  `agencySettings`, the `verification` object and any unknown field live in
  the row's `facets_json` until their own steps and are still mutated in place
  on the record `db.orgs` serves, persisted by the repository's flush inside
  every save and counted as persisted only once that save committed;
  assigning a column-backed field on that record throws, nested values of
  `location` / `federationRef` included; a first installation is initialised
  once from explicit state (`meta.orgsInit`), never inferred from an empty
  table, and `attach` never imports an in-memory array; no org deletion route
  exists and none is to be added before O2 is decided);
  `players`, `guardians` and `guardian_children` are live since S4a
  (`repositories/identity.mjs`, migration `0005_core_identity_live`, registered
  and attached at boot between the organisations and the staff): scalars and
  the split composites are columns changed only through `players.insert` /
  `players.update` / `players.ageUp` / `players.remove` and `guardians.insert`
  / `guardians.update`; `childIds` derives from the link rows; `coGuardians`,
  the outstanding guardian `emailCode` (plain, not hashed until S6) and
  unknown fields ride in `facets_json` and are still mutated in place on the
  records `db.players` / `db.guardians` serve; assigning a column-backed field
  or `childIds` on a view throws. **Player sub-records are live since S5**
  (`repositories/playerSubrecords.mjs`, migration `0007_player_subrecords`,
  note `docs/architecture/s5-player-subrecords.md`): `media` (+ tags),
  `attendance`, `timeline`, `badges`, `drills`, `drillResults`, `activityLog`,
  `externalIds`, `seasonHistory`, `medical.records` and `programme.completed`
  are rows of the twelve `player_*` tables, keyed by `(player_id, position)`
  where no client-visible id exists (nothing is minted; order and legal
  duplicates are kept; unknown item fields ride in the row's `extra_json`);
  the record keeps every array in place, read-only, items included, and the
  ONLY writers are `players.addItem` / `players.setItems` / `players.patchItem`
  (and `insert` / `restore`, which write a record's arrays as rows) — a route
  that writes a child row together with a blob, an audit row or a column runs
  in one unit of work. **One-time codes are live since S6a** (independently
  accepted at `2d7ddeb` within the reviewed backend development scope; not
  production-approved; `repositories/oneTimeCodes.mjs`, migration
  `0008_one_time_codes`):
  the club e-mail challenge and the child pairing code are rows of
  `email_challenges` / `pairing_codes` stored only as sha256 hashes of the
  normalised code; `db.emailChallenges` / `db.pairingCodes` are hash-free
  read-only views; issuance is durable before the code is sent; the
  confirmation and the pairing exchange each consume the code in ONE unit of
  work with the organisation's verification / the session; every mutation of
  the repository joins an open unit of work through the store's participant
  API (`unit.join`), so a failure after a statement poisons the unit even when
  its caller catches the error, runs in a transaction of its own outside a
  unit, and runs inside a raw transaction a tool opened without a BEGIN of
  its own (an open transaction is never taken for a unit); wrong codes are
  counted (ten cancel a challenge; a row at the limit is never redeemed, and
  a stored-format entry must carry a count from 0 to 9) and rate-limited; the
  challenge mail is sent with `secrets: [code]` so the persisted outbox record
  withholds the code (dev transport: full text in process memory only, for
  `/admin/outbox`); a backup exports the
  hashed rows and a legacy plain-code backup is hashed on import; the
  copy-only rollback is `scripts/oneTimeCodesRollback.mjs` (outstanding codes
  invalidated and counted) and the S5 tool refuses a file carrying 0008. The
  guardian e-mail code stays plain. **Notifications and category notification
  preferences are live since S7a** (independently accepted at commit
  `0641b2c600cd1f082436b4b24dbb052b98ee00d7` for the bounded migration
  milestone — not production approval; `repositories/notifications.mjs`,
  migration `0009_notifications`; `docs/architecture/s7-readiness-review.md`
  §8.6):
  `db.notifications` / `db.notificationPrefs` are read-only views over the
  repository's in-memory mirror of the three tables; the ONLY writers are
  `notifications.create` / `coalesce` / `markRead` / `ack` / `deleteForAudience`
  / `updatePrefs` (server.mjs `notify`, m13 delivery, m182 preferences, the
  deletion unit); the feed is reverse INSERTION order (`seq`), never timestamp
  order; coalescing is the pre-S7a reverse scan kept verbatim; a mandatory
  category stored false is kept as stored and forced on by the effective view;
  in the running server a write is STAGED — visible at once, durable inside the
  next snapshot save together with the blob edits made alongside it, or inside
  the enclosing unit of work's commit, never ahead of the action it announces;
  its push and its `notify` live event are effects of that write
  (`notifications.afterDurable`) and run only once the save that carried the
  row COMMITTED — never before, never after a failed save (they wait for the
  retry), never for a rolled-back unit; `notify()` requests the save, no
  effect ever does. Inside an open unit of work an effect is queued in EITHER
  mode, whatever runner the instance was given, and runs only on the unit's
  commit report (discarded with its rollback). In immediate mode (tools,
  tests) an owned transaction that fails restores the repository's memory in
  place, and an instance given the participant API joins a unit only once its
  save hook is registered — that precondition, like every other, is checked
  inside `unit.join`, so a caught refusal still poisons the unit. Unknown
  fields are copied as own properties (an own `"__proto__"` key is data, never
  assigned), and an audience, acknowledgment contract or category map with an
  unknown field refuses the whole migration or snapshot write;
  the acknowledgment and the dispatch rows commit in one unit; the copy-only
  rollback is `scripts/notificationsRollback.mjs` (every row written back in
  order; nothing lost) and the S6a tool refuses a file carrying 0009.
  Since the review of `ac50b60` the notification repository detaches unknown
  NESTED data exactly as the dispatch repository does (a prototype-safe JSON
  clone at ingress, export and snapshot; a value JSON cannot carry refuses the
  write) — independently accepted at `6ca66ba` for that bounded correction.
  **Delivery dispatch records and their attempts are tables since S7b**
  (independently accepted at commit
  `ac50b60257b89387aa1dec44bad7f571e61aa74e` for the bounded migration
  milestone and its three corrections — not production approval;
  `repositories/dispatches.mjs`, migration `0010_dispatches`;
  `docs/architecture/s7-readiness-review.md` §9 as corrected, §9.7–§9.9): `db.dispatches` is a read-only view over
  the repository's mirror (insertion order, attempts nested); the ONLY writers
  are `dispatches.create` / `recordAttempt` / `patch` (m13/delivery.mjs sweep,
  acknowledgment and callback); the eighteen-key literal is required whole and
  never normalised; `notification_id` is an indexed reference with NO foreign
  key and NO cascade (an ordinary deletion keeps its dispatch rows; orphans are
  imported and counted, never refused, pruned or re-parented; retention stays
  OPEN); the attempt-shape CHECK is total (`ok IS NOT NULL` on a send row); a
  note row never counts as a send; `delivered_at` / `opened_at` are REAL
  columns holding the callback route's finite number exactly, fractional or
  not (a non-finite callback clock is kept in memory for the process as the
  previous build did — no later event replaces it — and stored null), every
  server-written clock an INTEGER; EVERY refusal of create / recordAttempt /
  patch is a participant failure raised inside the joined boundary (a caught
  refusal still poisons the unit); unknown nested data is a detached
  prototype-safe JSON clone at ingress, export and snapshot (a value JSON
  cannot carry refuses the write); the callback lookup is the FIRST row in insertion order whose
  providerMessageId strictly equals the event's (explicit null matches the
  first null row, an omitted id matches nothing); writes are STAGED into the
  same save as the outbox row, the injection counter and the ops/webhook rows
  of the pass, the acknowledgment joined in the notification's unit; there is
  NO effects queue (a dispatch has no push and no live event); the copy-only
  rollback is `scripts/dispatchesRollback.mjs` (every row and attempt written
  back; nothing lost) and the S7a tool refuses a file carrying 0010.
  **The mail outbox, the push log and the device push tokens are tables since
  S7c** (independently ACCEPTED at commit
  `911918749687a3acdca430fe011d6c868ee640df` on 17 October 2026 for its bounded
  storage-migration scope — not production, security, legal-compliance or
  deployment approval, and not acceptance of S7d, S4b, the remaining S6 tables
  or S8; implemented on top of `6ca66ba`, corrected after the independent
  reviews of `40aa05c` and `78c14b9`, both dated history;
  `repositories/outboxPush.mjs`, migration `0011_outbox_push` with its DDL
  amended in place before acceptance; `docs/architecture/s7-readiness-review.md`
  §10 as corrected by the review of `6ca66ba`, §10.8, §10.10, §10.11, the
  acceptance §10.12): `db.outbox`, `db.pushLog` and `db.pushTokens` are
  read-only views over one participant's three mirrors (insertion order); the
  ONLY writers are `outbox.append` / `outbox.markDelivered` (adapters.mjs mailer
  — the record before the provider call, the live answer on the caller's
  record AND the row), `outbox.append` (m13/delivery.mjs `fakeSend`, `to` as the
  dispatch holds it — null included), `pushLog.append` (the push sender, run by
  the notification's after-durable effect AFTER the notification's save: the
  row lands with the later save the sender's `nextId()`/`persist()` already
  schedules — nothing new scheduled, no guarantee implied) and
  `pushTokens.register` (`POST /push/register`: any truthy JSON value is the
  token, stored LOSSLESSLY as JSON text and decoded on read; the route's `===`
  rule — a primitive collapses an earlier row of the same value and type,
  objects and arrays never — reproduced; NO uniqueness constraint). The two
  outbox literals are told apart structurally (`source`, a total CHECK: NULL is
  "absent key"); the destination is ANY JSON value — a string in `to_address`,
  null, any other value (the ARRAY the coercing invite routes hand the mailer)
  in `to_json`, decoded on read (review of `40aa05c`, F2), a non-finite number
  inside that array kept live and persisted as the old JSON null (review of
  `78c14b9`, §10.11); a non-finite token
  value (JSON `1e400`) is kept live and persisted as null, a replacement
  deleting by row seq (review of `40aa05c`, F1); a scratch file at `40aa05c`
  (outbox without `to_json`) is refused by name, rolled back by the tool and
  re-upgraded; the two fire-and-forget mail sites observe their promise;
  vocabularies are open; unknown and nested data are detached clones; a failed ordinary staged save keeps its
  pending state for the next save, an aborted unit restores the pre-unit
  state; the copy-only rollback is `scripts/outboxPushRollback.mjs` (every
  row written back in its writer's literal; nothing lost; proven on the actual
  `6ca66ba` build) and the S7b tool refuses a file carrying 0011. The staff
  push identity, the plain-code mail sites and retention are carried through
  unchanged, not decided. **Message threads are tables since S7d** (independently
  ACCEPTED at commit `4f954ad92cda6ca5178cc6c3d5485265684e0c03` on 18 October
  2026 for its bounded backend storage-migration scope — not production,
  security, legal-compliance or deployment approval, and not acceptance of S4b,
  the remaining S6 tables or S8; implemented on top of `b67bce5` and corrected
  once after the independent review of `62e9c1a`, both dated history —
  `docs/architecture/s7-readiness-review.md` §11.9, §11.10, the acceptance
  §11.11; approved by the Founder's explicit decisions D-A and D-B, recorded
  verbatim in §11.9; `repositories/channels.mjs`, migration `0012_channels`).
  **All four S7 sub-steps are accepted; that completes the communications
  storage stage, not the migration** — the `ledger`, `requests`, `trials`,
  `recruitmentCases` and every other remaining blob are still rewritten by
  every save (review §7.3); the next stage's findings and the Founder's
  decision list are `docs/architecture/sqlite-migration-plan.md` §D (the one
  list: §D.5; Q4/Q4b/Q5 answered and S6b built since — below). S7d: `db.channels` is a read-only view in insertion
  order with each thread's `messages` nested in array order; the ONLY writers
  are `channels.open` (the two acceptance routes' `openChannel` — the literal
  unchanged, the request checked against the live `requests` collection, the
  organisation and the guardian checked by name, one thread per request),
  `channels.appendMessage` (`postMessage`; the duplicate-`clientMsgId` answer
  stays the writer's rule), `channels.markRead` (the three receipt routes) and
  `channels.deleteForPlayer` (`deletePlayerData`, inside the deletion unit:
  today's deletion of the deleted player's threads, guardian–club threads
  included — D-B, a scope confirmation, not a retention decision). The tables
  carry `request_id NOT NULL UNIQUE` with no foreign key (D-A, the §2.3
  transitional code-checked reference until S8a), `player_id` with no
  lifecycle clause, `guardian_id` code-validated at open and against the FINAL
  guardians table on every identity, channel or request snapshot write (§11.8),
  `org_id RESTRICT`, the internal message/attachment cascades, `seq`/`position`
  order, `absent_keys_json` (absence preserved as absence) and `extra_json` at
  every level (`orgUserIdForNotify` and unknown fields preserved exactly);
  a failed ordinary staged save keeps its pending state, an aborted unit
  restores the pre-unit state IN PLACE through the graph memento
  (`repositories/memento.mjs`) — every object of the mirror by identity, so a
  held nested view (`channels.byId(id).readBy`, a message's `sender` or
  `attachment`, an unknown nested field) reads the pre-unit value afterwards
  and follows the next committed write (the review of `62e9c1a`); the copy-only rollback is
  `scripts/channelsRollback.mjs` (every thread and message written back;
  nothing lost; proven on the actual `b67bce5` build) and the S7c tool refuses a
  file carrying 0012. Retention stays OPEN (S4b). **The eight safeguarding and
  audit collections are tables since S6b** (IMPLEMENTED 19 October 2026 on top of
  `1792fc7`, whose next-stage brief the independent review accepted; PENDING
  INDEPENDENT ACCEPTANCE — not production, security, legal-compliance or
  deployment approval, not acceptance of S4b or S8; `docs/architecture/s6-readiness-review.md`
  §11, plan §D.4/§D.5; `repositories/safetyAudit.mjs`, migration
  `0013_safety_audit`). Built under the Founder's explicit decisions of
  19 October 2026, recorded verbatim in review §11 and not to be asked again:
  **Q4 "Approve — preserve current behaviour"** — the five historical player
  references (`blocks`, `reports`, `org_notes`, `ledger`, `source_changes`) stay
  when the player is absent, unresolved ids are counted and never refused,
  invented or deleted, no parent-existence rule on any writer (`handleReport`
  still stores a truthy `targetPlayerId` of any type as received); **Q4b
  "Approve — move with strict guardian checks"** — `idv_queue` moved with the
  application check that the guardian exists (new writes, the import, every
  snapshot write that carries the queue or rewrites the identity pair; an
  identity-only replacement removing a referenced guardian is refused
  atomically, ids only); the database foreign key is a later step; **Q5 "Keep
  today's removal behaviour"** — lifting a block deletes its row. NO foreign key
  on any of the eight (the organisation and staff ids are historical pointers
  because the block and report routes accept them unchecked — a stated
  shape-compatibility decision); no vocabulary CHECK; `seq` order;
  `absent_keys_json` / `offtype_json` / `extra_json` keep every writer's literal
  (absence as absence, a numeric or object `targetPlayerId` as received); the
  ledger's `userId` / `scoutName` verbatim, no actor kind; the moderation
  context whole; every ops-event kind a row; writes staged into the route's
  next save or the enclosing unit (the IDV row commits with the guardian's
  columns); the copy-only rollback is `scripts/safetyAuditRollback.mjs` (every
  row written back in its writer's literal; nothing lost; proven on the actual
  `4f954ad` build) and the S7d tool refuses a file carrying 0013. S6b removes
  the eight audit blobs from every save's serialisation and does NOT meet the
  whole-snapshot-write objective (plan §D.4). Child-status stamping (Q2) and
  the country code (Q1) stay OPEN; the full birth date, D-A/D-B and the
  legacy-minor stop rule are unchanged; A0–A3, S4b and S8 are not started. The
  next free migration identifier is `0014`.
  `trialReports` is not stored: it is derived from
  `trials[].report` in filing order and served read-only on EVERY record,
  whatever shape it was saved with (absent, null or an array; the empty-state
  shape is kept until a report exists); the trial report route writes the
  trial only. A `trialReports` array written WITH a record (snapshot
  replacement, `initialize`, `insert`, `restore`) is a claim and must equal
  the trials entry for entry, else the whole write is refused — never dropped;
  absent or null is no claim. `players.update(id, { medical: null })` /
  `programme: null` is refused while the composite's child rows exist (clear
  them with `setItems(..., [])` first); a file whose row says a composite is
  null over existing rows is refused by the boot, the backup and the rollback
  (`INCONSISTENT_ROWS`). Migration 0007 decodes every S4a row through
  the one mapping, validates every item, reconciles every `trialReports` copy
  with the trials and blocks the whole step with
  `PLAYER_SUBRECORDS_CUTOVER_BLOCKED` (ids, fields, indexes, reasons) on any
  discrepancy; nothing is coerced, deduplicated or dropped. Media ownership is
  judged on `player_media` once 0007 is recorded. The copy-only rollback to the
  S4a build is `scripts/playerSubrecordsRollback.mjs`; the S4a→S3 tool refuses
  a file carrying 0007 (`LATER_SCHEMA`). The cutover validates every record and relationship through
  the reviewed preflight (`repositories/identityPreflight.mjs`) and a legacy
  minor with no guardian link refuses it until resolved by hand (the Founder's
  decision); a first installation initialises once from explicit state
  (`meta.coreIdentityInit`), `attach` never imports an in-memory array, and
  the S1 shadow projection is retired. Every operation that writes a row and
  a blob or a facet (sign-up, child creation, verification, aging-up, the
  signing completion, deletion, a medical record, programme selection,
  Academy+, stats, squad release) runs in one unit of work; deletion queues
  the media removals in `media_deletions` (migration `0006`) inside the same
  transaction and the files go after COMMIT; a backup exports that queue as
  `mediaDeletions` and never copies a queued file, and a restore imports it
  (migration `0006`) and finishes the removal at boot; the queue never deletes
  a file a live player still references (the identity records' `media[].id`
  through the mapping are the authority, never the entry's own `player_id`):
  a conflicting restore or snapshot is refused whole with
  `MEDIA_QUEUE_OWNERSHIP_CONFLICT`, a stored conflicting entry is retained with
  a diagnostic at every sweep, and the backup answers 409 rather than omit the
  clip; player and guardian responses come from the
  allowlists in `views/playerViews.mjs`; the copy-only rollback tool is
  `scripts/coreIdentityRollback.mjs` (refuses a pending initialisation and a
  non-empty media queue). **Registration in source is development work, not
  authorization for a real-data cutover**: the operator procedure in
  `scoutbox-server/OPERATIONS.md` ("Players and guardians") is the gate, and
  a preflight report is never an approval. Never log,
  report or export a plain bearer token. `node:sqlite` with transaction state
  is required (Node 22.16+ on the 22 line, or 24.0+; `runtime.mjs` is the one
  definition, checked before the data directory is touched and refused with
  `NODE_UNSUPPORTED`); there is no JSON or in-memory fallback, and whether a
  table is authoritative
  is decided by its record in `data_migrations`, never by the table existing.
  Snapshot writes check every table-backed collection's shape, then every row,
  and reject the whole save on the first problem; an existing but invalid
  legacy `db.json` is a fatal import error, never "no snapshot". Never put a
  whole-collection
  re-projection in the default save path. An operation that writes a
  table-backed collection and the blob together runs inside
  `store.unitOfWork(() => …)` — and so does a route that changes a column AND
  a facet of the same record, a blob, an audit entry or another domain (a
  repository write followed by an in-place edit left to the delayed save is
  the half-saved operation the review of `9656a4b` reproduced); a provider
  call is made before the unit, never inside it; a failed unit is answered as
  a failure (500), never as success. The store's `unitOfWork`: synchronous work (an `async function` is
  refused before it runs; never schedule asynchronous work inside a unit, the
  store cannot cancel a continuation), one transaction, all-or-nothing with the
  in-memory graph restored on failure; a nested unit joins and its failure
  fails the whole even if caught; side effects (broadcasts, pushes) go through
  `store.afterCommit` — return the promise, never `void` it — so a failed
  operation publishes nothing and a failed delivery is counted, not a crash; a
  repository that cannot roll its memory back (`org_users` today) refuses
  writes inside a unit rather than joining half-way (contract:
  `scoutbox-server/OPERATIONS.md`, "Units of work"). The target schema and the step
  order are `docs/architecture/sqlite-schema.md` and
  `docs/architecture/sqlite-migration-plan.md`; a new table must appear in the
  matching `docs/architecture/sql/*.sql` file as well as in its migration.
  The runtime data directory is `scoutbox-server/data/` and is never a
  source directory.
- No new milestone-named modules (`m30/…`). New server code lives in a
  directory named after its domain (`scoutbox-server/domains/<domain>/`), and
  moving code out of a milestone directory happens with the domain migration.
- One definition per rule. Shared rules (`roles.mjs`, `domain.mjs`,
  `temporal.mjs`) are imported, never copied. If a check is needed in a second
  place, export it from the first.
- Every environment-driven setting is registered in
  `scoutbox-server/m181/capabilities.mjs` (capability state and, where unsafe,
  a production boot refusal) and documented in `OPERATIONS.md`. Secrets have no
  default values.
- Responses are built from explicit allowlists of fields, never by spreading a
  stored record.

### Shared code

- Do not add another copy of an API type or client to an app. The server is
  the source of truth for shapes; a shared types and API-client package is the
  next structural step after the data layer, and new client code should be
  written so it can move there.
- `scoutbox-club` and `scoutbox-grassroots` share their business logic; a fix
  in one is a fix in both until they are merged.

### Tests and CI

- Every server change ships with a test: unit tests in
  `scoutbox-server/scripts/test*.mjs` (run by `npm test`) and, for route
  behaviour, the matching end-to-end script. The existing end-to-end scripts
  are the behavioural specification for the rebuild; a migrated domain must
  pass them unchanged, apart from assertions that exist only to describe the
  old storage.
- CI must be green on `main`. A red step is a defect to fix, not a step to
  skip.

### Milestone gates — documentation housekeeping and unit tests (Founder requirement, 14 October 2026)

These two gates apply **after every milestone for the rest of the project**,
documentation-only milestones included. They override any earlier suggestion
that a documentation change needs no test run. Every handoff and every
next-step prompt restates them and reports their result; they are not a
one-round instruction. This section is the single authoritative statement of
the policy; `AGENTS.md` points here and no other rules document restates it.

**A. Keep the Markdown current; remove what is obsolete.**

- At every milestone, inspect the relevant Markdown files for outdated
  duplicates, abandoned plans, superseded drafts and conflicting guidance.
- Remove files that are genuinely no longer needed. Before removing a
  superseded file, move any still-relevant decision, requirement or
  operational guidance into the current authoritative document and repair
  every link and reference to the removed file.
- Preserve active architecture, schema and migration documents, unresolved
  decision records, required project instructions, current runbooks, and the
  evidence needed to understand or reproduce accepted work. Age alone does not
  make a file obsolete. Do not blanket-delete Markdown, and do not move
  everything into an ever-growing archive instead of cleaning up.
- The milestone handoff lists every deleted or consolidated file with the
  reason; if the review found none, it says so explicitly. The repository must
  end each milestone free of conflicting active instructions.

**B. Run the backend server AND the Player app unit tests.**

- Discover and record the actual commands and working directories from the
  current packages: the backend is `cd scoutbox-server && npm test` (the full
  chain in `scoutbox-server/package.json`); the Player app is
  `cd scoutbox-player && npm test` (Jest with the `jest-expo` preset, tests
  under `scoutbox-player/src/__tests__/`). Do not guess a path or invent a
  passing command. The Agent, Pro and Grassroots apps are not substitutes for
  testing Player.
- Run both suites against the **final** changed tree of the milestone. If code
  or configuration changes after a run, repeat the affected checks and record
  the tested commit or file state accurately.
- If the Player unit-test setup is ever missing or unrunnable, establish the
  smallest suitable setup with the app's existing stack and meaningful tests
  of real behaviour — never an empty suite or tautological tests — and report
  that supporting change separately. If required source or dependencies are
  unavailable, report the precise blocker and mark Player testing **NOT RUN**;
  never "passed" or "complete".
- Fix failures the milestone introduced and rerun. Identify independently
  established pre-existing failures as such; never hide them, silently skip
  tests, or call a failing gate green.
- Record commands, runtime and tool versions, exit codes and totals for both
  gates. Unit tests are required even when browser or API checks also ran; a
  successful build, lint, screenshot or smoke test is not a substitute.
- A milestone is not "fully verified" while either gate is missing or failing.
  Preserve the evidence and report any blocker plainly. Synthetic fixtures
  only; never real user data or live external delivery services.

## Latest approval — Agent, 6 October 2026

The Founder approved the finished ScoutBox Agent UI at `7ee9ecb` on
`design/agent-finance` and requested a GitHub push and an artifact ready for
Claude. Read `AGENT_FINANCE.md` and `HANDOFF_CLAUDE_AGENT.md` before Agent work.
Preserve the actual approved implementation: black/violet business workspace,
lavender gradients, stacked ScoutBox/AGENT identity, brand-green accents,
world maps, viewport-triggered motion, compact utility toolbar, refined agency
directory, credential records, operating profile and client portfolio.

Rebuild with `node e2e/buildDemos.mjs`, check with
`node e2e/demoFreshness.test.mjs`, and use `e2e/dist/scoutbox-agent-demo.html`.
A GitHub push does not replace a separate Claude artifact. Replace or rebuild
that artifact explicitly and verify its displayed build ID. Preserve existing
permissions, safeguarding, provenance and all other approved app designs.
This authorizes the requested Agent branch push; it does not authorize a merge
to the default branch, production deployment or future unrelated pushes.

## Latest approval — Pro, 6 October 2026

The Founder approved ScoutBox Pro at `f87f61d` on `design/pro-executive` and
requested a GitHub push and preservation as the permanent Pro baseline.
Read `PRO_EXECUTIVE.md` before changing Pro. Preserve its actual implementation,
including the football entry screen, shared bright Pro lockup, workspace tools,
player dossiers and correspondence desk. Do not reconstruct older screenshots
or restore rejected generic layouts. New features must fit the approved UI.

Use `e2e/dist/scoutbox-club-demo.html`, built with `node e2e/buildDemos.mjs` and
verified with `node e2e/demoFreshness.test.mjs`, for the Pro artifact. A separate
Claude artifact requires rebuilding or replacing its bundle; a source push alone
does not update it. This approval does not change Player or Grassroots.
The current Pro push is authorized, not a merge, deployment or future push.

## Latest approval — Grassroots, 6 October 2026

The Founder explicitly approved the Grassroots UI at commit `5a3e7b0` on
`design/grassroots-clubhouse` and requested that it be pushed to GitHub and used
for the Grassroots artifact going forward. This is the approved baseline, not
an unfinished redesign. Preserve the actual implementation and subsequent
authorized changes; do not rebuild it from a screenshot or restore older demo
HTML. Read the approval at the top of `GRASSROOTS_CLUBHOUSE.md` before changing
Grassroots. Its final decisions supersede earlier exploratory design directions.

Build the Grassroots artifact from these sources using the canonical demo builder
and freshness check. The GitHub push is authorized for this approval; this is not
standing permission for future pushes, merges, or deployments.

The Founder approved the current Player design and explicitly asked Claude to
preserve it going forward. These are persistent project instructions. A later
explicit Founder request may revise them; do not infer a redesign request
from unrelated feature or bug-fix work.

## Source of truth

- Approved implementation checkpoint: `99de825` on
  `handoff/codex-player-vivid-ui`.
- Read `HANDOFF_CLAUDE_UI.md` and the final approval section of
  `BRAND_RULES.md` before changing Player UI.
- Use `design-system/approved-player-ui/README.md` to identify current
  reference captures. Earlier conflicting design notes are superseded.
- Keep the actual committed components and styles. Do not recreate the app
  from a screenshot, replace it with a simplified mockup, or restore older
  cached artifacts. Preserve subsequent authorized changes as well.

## Preserve these design decisions

- Exact ScoutBox logo and #00e676 brand green; system UI typography, SF Pro
  on Apple, with the existing wordmark typography.
- Player is permanently dark-only, per the Founder’s latest instruction.
  Preserve the approved dark palette, canvas and semantic icons. Do not restore
  light mode, OS-following appearance, theme switches or Appearance settings.
  Gradient controls retain 70% opacity; labels/icons stay opaque. Home hero
  opacity is .49 and its CTA is .56. Saved light preferences must be ignored.
- Location first and bordered position badge second on one row; bordered
  availability pill below. Profile/Football centre the group below the name.
  Home retains its approved placement above/below the name respectively.
- Bright blue verification seal after the name: 20.9px, 6px gap, centred
  alignment with a 1px downward optical offset. Only render it when the
  existing identityVerified data is true.
- Social inbox with search, avatar shortcuts, filters and unboxed preview
  rows opening full conversations. Squared message bubble and overlapping
  unread count. Preserve the approved dark treatment.
- Structured invitations, compact goal actions and author-led reviews.
  Flat record details and clear action areas across agents, representation,
  transitions, exposure, requests, references, transactions and check-ins.
  Do not restore nested grey boxes or stacks of generic explanatory cards.
- Shared connected timeline rails with green points and gentle pulses;
  respect reduced motion. Preserve the approved notification presentation.

## Behaviour and validation

Keep existing authentication, tenant isolation, safeguarding, guardian-managed
minor contact, consent acknowledgements, state transitions and action handlers.
Never expose internal club notes. Offer acceptance is not signing; Box Cam is
not assessment; evidence confidence is not a talent score; Nobody Missed is
evaluation coverage, never a ranking. Do not invent data, presence or
verification. Preserve five-category navigation and no authored emoji. The
self-contained demo bundles make no runtime external requests (fonts and
assets are bundled).

For changes, run relevant checks and inspect affected screens in dark mode
and narrow layouts, including a previously saved light preference. Do not use superseded minimalism tests as a reason to
revert the Founder-approved design. Do not silently remove behavioural tests.

Build the real app without EXPO_PUBLIC_DEMO. For self-contained demo updates,
use `node e2e/buildDemos.mjs` and `node e2e/demoFreshness.test.mjs`; use the new
`e2e/dist/scoutbox-player-demo.html`, served over HTTP(S). Demo sample data is
not a production backend. An external Claude artifact does not update merely
because these files or Git history changed; replace/rebuild it explicitly when
the Founder asks. Never claim an artifact was updated without verifying it.

No push, merge or deployment is authorized by these standing instructions.

The dark-only change does not alter Grassroots. The Founder will start that
project separately. The cloud-only badge fix 9c6249f must be preserved when
merging this branch into Claude’s existing workspace; it was not on GitHub
when the dark-only update was prepared.

## Grassroots Clubhouse — new makeover

The Founder has now started the separate Grassroots redesign, with full creative
control except the logo and brand colours, and an explicit requirement to leave
sign-in/sign-up as they are. Read `GRASSROOTS_CLUBHOUSE.md` before Grassroots UI
work. The current implementation uses an earthy forest workspace, green gradients
and glows, a clubhouse Home and consistent player/club/recruitment screens. This
supersedes earlier Grassroots light/flat/minimalist presentation instructions;
it does not alter the approved Player baseline or protected business rules.
Keep the new styling scoped to authenticated Grassroots. Preserve the existing
authentication pages and exact ScoutBox logo and #00e676 brand green.

The follow-up Grassroots refinement uses `scoutDesk.css` after `clubhouse.css`:
professional scouting registers, compact operational sections, a desktop Film
Room and structured player dossiers. Preserve this direction across every
workspace page; avoid reintroducing repeated rounded cards around paragraphs.
The Clubhouse hero and earthy ScoutBox green identity remain. See the refinement
and validation scope in `GRASSROOTS_CLUBHOUSE.md`.

The 6 October Grassroots refinement adds `ScoutVisuals.tsx` and the scoped
`scoutCharacter.css`: a compact account/club-standing panel, semantic page
mastheads, position coverage on a pitch, count charts with optional bar/ring
views, fixture columns and reduced-motion-aware animation. Preserve truthful
count scopes and distinct loading/empty states; never manufacture scores or
verification. See `GRASSROOTS_CLUBHOUSE.md` for the durable design rules.


The subsequent 6 October studio refinement supersedes the green-edged generic
mastheads, ruled section headings and broad green form strips above. Load
`scoutSuite.css` after `scoutCharacter.css`. Preserve the three-panel Film Room
(clip library, viewer/timeline, player observations), the Scouting Insight
activity/review/evidence views, and the Integrations workbench. Use labelled
creation disclosures, brief dossiers and structured operational records rather
than sentence-packed rows. English interface copy uses sentence case; stored
enums, IDs, translation keys, names and user-authored content stay unchanged.
Film Room timeline markers are explicitly session-only; observation tags use
the existing persistence and anonymity rules. Read the latest section of
`GRASSROOTS_CLUBHOUSE.md` before making further presentation changes.


Preserve the subsequent discovery/toolbar correction in
`GRASSROOTS_CLUBHOUSE.md`: Nobody Missed's brief desk, Player Matching's two-part
criteria workbench, the structured Second Look dossier, and the custom local
search/bell/safety SVG controls. The Founder explicitly rejected the preceding
layouts and toolbar icons.

The Founder then refined the toolbar again: search should look like a traditional
search bar, and notifications like a traditional bell, with restrained ScoutBox
green accents. Preserve the single-line search field and circular bell control;
do not restore the two-line Finder or labelled Updates tiles.

The Founder also rejected dense, dot-separated criteria and record summaries
across Grassroots. Preserve the grouped required/preferred criteria in watchlist
list/detail and matching results, and the labelled facts/separate list entries
provided by local `RecordDetails.tsx`. Do not restore wrapping mixed-data
paragraphs. See the latest readable-record rules in `GRASSROOTS_CLUBHOUSE.md`.

Preserve the compact Grassroots account panel and simple Home banner described
in the latest section of `GRASSROOTS_CLUBHOUSE.md`. The Founder rejected both
pitch illustrations. Home now uses only its headline, subtle forest background,
ScoutBox green and the contextual primary action. Do not restore scenery or the
“Built from the ground up” caption. Keep the smaller account panel.

The latest Home refinement adds a faint turf texture and embossed pitch-line
background at the Founder's request. Keep it subtle behind the existing content;
retain the simple layout and avoid restoring the rejected scenic illustrations.
