# S6 readiness review: safeguarding, audit and one-time codes — what the code does today, what can proceed, what waits for a decision

Written 12 October 2026 on branch `feat/sqlite-schema` at commit `2178c5b` (S5 review-accepted),
from reading the code as it is at that commit. **Documentation and read-only inspection only:**
no source, schema DDL, migration, test, runtime behaviour, deletion behaviour, account data or
user interface was changed by this review, no migration is registered, and nothing was run
against real data. Paths are relative to `scoutbox-server/`; `S:` is `server.mjs`; line numbers
are those of `2178c5b`. The DDL this review reconciles against is
[`sql/03_messaging_safety_audit.sql`](./sql/03_messaging_safety_audit.sql) (proposed, not
accepted) and the plan is [`sqlite-migration-plan.md`](./sqlite-migration-plan.md) §S6, whose
server line numbers predate S4a and S5 and are superseded by the ones here.

> **Update (S6a implemented and independently accepted at `2d7ddeb` within the reviewed backend development scope; not production-approved).** §§1–9 are the review as written at
> `2178c5b` and are kept as the record of the analysis; their line numbers are those of that
> commit. The one-time-code sub-step proposed in §6 has since been implemented on top of
> `7fbce74` as migration `0008_one_time_codes`; **§10 records what was actually built**, where it
> departs from §§5–7 and why, and how it was verified. **The eight audit tables are IMPLEMENTED since
> 19 October 2026 as S6b (migration `0013_safety_audit`, one local commit on top of `1792fc7`) and PENDING
> INDEPENDENT ACCEPTANCE — §11 records what was built, the Founder's decisions Q4, Q4b and Q5 it rests on,
> where it departs from §§2–7 and plan §D.4, and how it was verified.** Not production, security,
> legal-compliance or deployment approval; not acceptance of S4b or S8.

Three kinds of statement are kept apart throughout: **code facts** (what runs today, cited),
**proposed implementation** (a design for the next step; nothing is built), and **unresolved
product choices** (listed in §8 and §9; nothing is decided by implication).

Sections: 1 where S6 stands · 2 the ten domains, one by one · 3 deletion paths and
dependencies · 4 append-only, `RESTRICT` and the current hard delete · 5 the one-time codes ·
6 the smallest safe sub-step · 7 test and rollback design · 8 migration registry · 9 dependency
table · 10 S6a as implemented (independently accepted at `2d7ddeb`; §10.6 and §10.7 are the two
review-correction rounds) · 11 S6b as implemented (19 October 2026; pending independent acceptance).

---

## 1. Where S6 stands

- S4a is review-accepted at `480afdb`; S5 is review-accepted at `2178c5b`; **S4b is not
  implemented** (today's deletion is a hard delete of the player row, §3); **S6 is not started**
  (no repository, no migration, no table of this step exists). The migration registry holds
  `0001`–`0007`; the last is `0007_player_subrecords` (§8).
- O1 is **partially resolved** ([`s4-deletion-decision.md`](./s4-deletion-decision.md) §10): the
  Founder chose the full birth date for the retained record of a deleted player, when that
  deletion design is built; whether the country code may stay, and whether a future safeguarding
  record should carry a write-time child-status stamp, are **open**. Neither open item is read
  as a yes, a no or a permission anywhere below.
- Every S6 collection is still a **blob**: the server keeps it as a plain array on `db`, and a
  save writes the whole array as one JSON value into the `collections` table (`store.mjs:109`,
  one row per collection name). Saves are debounced two seconds (`persist`, S:159–169) or
  immediate (`persistNow`, S:171–178), flushed on SIGINT/SIGTERM (S:180–182), and a route that
  must commit a blob edit together with a table write runs it inside `unit` (S:217–219,
  `store.unitOfWork`), which writes the blobs in the same transaction and restores every record
  from the memento on failure.
- The legacy-minor rule and every accepted S4a/S5 guard are untouched by anything proposed here.

## 2. The ten domains, one by one

For each: the record shape as written today; every reader and writer found (`git grep` over
`server.mjs`, `m*/`, `repositories/`); who is allowed to see it; how actors and subjects are
referenced; what lifecycle exists; the table the DDL proposes; the transaction boundary of each
writer; the tests that touch it; what a rollback of the step would have to preserve.

### 2.1 `blocks` → `blocks`

- **Shape (code).** `{ id: 'blk-*', playerId, orgId, by: 'guardian' | 'player', reason, ts }`.
  Writers: guardian block `POST /guardian/block` (S:1686–1699: push at 1695, then a ledger row
  `org_blocked_by_guardian` at 1696, `broadcast`, no `persist` call — the ledger row and the block
  reach disk at the next save); player block `POST /player/block` (S:3893–3900: push 3896, ledger
  3897); the urgent-report path inside `handleReport` (S:1727–1738: one block per reporter's
  player with `reason: 'suspended_pending_review'`, and every pending request of that pair set to
  `status: 'suspended'` at 1736). Container: migration registry `m182/migrations.mjs:250`;
  contract `storeContract.mjs:57` (guarantee `migration`).
- **Readers.** `isBlocked(playerId, orgId)` (S:667–669, `some()`), called inside every org-facing
  visibility check (profile, notes S:2042, discovery, signing completion gate
  `m29/index.mjs:614`), `m23/journey.mjs:557`, `m23/journeyRoutes.mjs:104`; admin list
  `GET /admin/blocks` (S:4402, every row, newest first); admin count (S:4295).
- **Authority and access.** A block hides the player from the organisation entirely (404, never
  403). No route lists a guardian's or a player's own blocks; only Trust & Safety sees the rows.
- **Lifecycle (code).** `POST /admin/blocks/:id/lift` (S:4404–4411) **splices the row out of the
  array** — a hard delete of a safeguarding record, with `persist()` — and the lifted row is
  returned once in the response and then exists nowhere. No uniqueness: the same (player, org)
  pair can hold several rows (manual plus automatic); a lift removes one.
- **Table (DDL 495).** `blocks(id, player_id REFERENCES players(id) ON DELETE RESTRICT, org_id
  … RESTRICT, by_kind CHECK IN ('guardian','player'), reason, created_at)`; index on
  `(player_id, org_id)`.
- **Transaction boundary.** None of the three writers runs in a unit: each pushes onto the blob
  and relies on the next save; the guardian and player paths also push a ledger row in the same
  tick, so the pair lands together in whichever save comes next (or is lost together on a crash
  inside the debounce window). The automatic path mutates `requests` rows too.
- **Tests.** 36 scripts touch blocks (the visibility rule is exercised throughout the battery);
  the admin lift is exercised by `m23ContactE2E`, `m23TrialE2E` and `testWriterAtomicity`.
- **Rollback implication.** A copy-only rollback would rebuild the `blocks` blob from the rows.
  If the step records lifts instead of deleting rows (§4.2), the rollback must omit lifted rows
  from the blob (the older build has no notion of a lifted block and would enforce it).

### 2.2 `reports` → `reports`

- **Shape (code).** `handleReport` (S:1703–1742): `{ id: 'rep-*', ts, by, byId, byOrgId?,
  targetKind: 'club'|'scout'|'player', targetOrgId, targetScoutName, targetPlayerId, reason,
  urgent, status: 'pending_review', outcome: null, resolvedAt: null }`; callers guardian
  (S:1685), org user (S:2303, with `byOrgId`), player (S:3891). The automatic escalation in
  `moderateOrRefuse` (S:1088–1093) writes `by: 'system', byId: 'moderation'`, `urgent: true`,
  with no `targetPlayerId` key at all. Container `m182/migrations.mjs:251`; contract
  `storeContract.mjs:138` (`migration`).
- **Readers.** The reporter's own list by `(by, byId)` — guardian S:1661, org S:2305, player
  S:3415; admin triage `GET /admin/reports` (S:4310–4313: urgent pending first, then oldest
  pending, then resolved newest); `safeguardingCertified` (S:1032–1035: any urgent pending report
  against the org removes the certification, read on every org view); admin stats (S:4294).
- **Authority and access.** The reporter sees their own reports; Trust & Safety sees all; the
  reported organisation never sees them (it sees the consequence through the block).
- **Lifecycle (code).** `POST /admin/reports/:id/resolve` (S:4328–4345) mutates three fields in
  place — `status` to `'resolved'` (both `dismiss` and every other action, 4334), `resolvedAt`,
  `outcome` (admin free text) — then, for `action === 'suspend_org'`, `orgs.update(org.id,
  { suspended: true })` (4339, a table write) and a notification to the reporter; `persist()`.
  Never deleted. **The resolve route is not a unit**: the org row is written to its table at once
  by the repository, the report's new status waits for the debounced save.
- **Table (DDL 539).** `reports(id, created_at, by_kind, by_id (polymorphic, no FK), by_org_id
  … RESTRICT, target_kind, target_org_id … RESTRICT, target_scout_name, target_player_id
  REFERENCES players(id) ON DELETE RESTRICT, reason, urgent, status, outcome, resolved_at)`.
- **Tests.** `apiE2E` (urgent triage order, resolve, reporter notification), `m13E2E`,
  `m23Persistence`, `preM24SweepE2E`.
- **Rollback implication.** Rows map one-to-one to today's records; a rollback rebuilds the blob
  with every field, including the resolution fields.

### 2.3 `moderationLog` → `moderation_log`

- **Shape (code).** `moderateOrRefuse(res, text, context)` (S:1081–1103): on a hit, push
  `{ id: 'mod-*', ts, context, flags, severity: 'contact'|'grooming', excerpt: text.slice(0,140) }`
  (1084), and on `severity === 'grooming'` the automatic urgent report (1088–1093), then
  `persist()` (1095) and the 400 refusal. `context` is the caller's own object (`kind` plus any
  of `orgId`, `userId`, `channelId`, `playerId`, `requestId`, `trialId`); about seventy call
  sites across `server.mjs` and the modules pass their own. Container `m182/migrations.mjs:252`;
  contract `storeContract.mjs:104` (`migration`).
- **Readers.** Admin only: `GET /admin/moderation` (S:4413, every row newest first); counts
  (S:4296, 4304).
- **Authority and access.** Trust & Safety only. **The excerpt is the blocked text itself** —
  it may hold the very contact details or grooming language that was refused, and may quote a
  child. The retention of that text is an unresolved product choice (§9), not a technical one.
- **Lifecycle (code).** Never edited, never deleted. Append-only holds today.
- **Table (DDL 594).** `moderation_log(id, created_at, context_kind, context_org_id,
  context_user_id, context_channel_id, context_player_id, context_request_id, context_trial_id,
  flags_json, severity, excerpt)`; the context ids are plain TEXT **without foreign keys** by
  design (forensic pointers that must survive their subjects).
- **Transaction boundary.** The hit is written outside any unit, inside a refusal path: the
  refused request writes nothing else, so there is nothing to couple it with; `persist()`
  schedules the save.
- **Tests.** `apiE2E`, `m15E2E`, `m23BootContract`, `m23ContactE2E`, `m23Persistence`,
  `testTrust`.
- **Rollback implication.** One-to-one; the blob is rebuilt from the rows with `context`
  reassembled from the context columns (unknown context keys would need an `extra_json` or are
  lost — the DDL has none; §7 lists it as a preflight check).

### 2.4 `orgNotes` → `org_notes`

- **Shape (code).** `POST /org/players/:id/notes` (S:2038–2049): `{ id: 'note-*', orgId,
  playerId, userId, scoutName, text, ts }`, refused for a player the org may not see or who
  blocked it (2042, 404); **no moderation screen on the text** (only `TEXT_REQUIRED`); push at
  2046, `broadcast`, no `persist` call. Container `m182/migrations.mjs:312`; contract
  `storeContract.mjs:112` (`migration`).
- **Readers.** The org's own notes on the player in the org profile read (S:2032, own `orgId`
  only, newest first).
- **Authority and access.** Org-private: never the player, the guardian, another organisation,
  or Trust & Safety (no admin route reads them).
- **Lifecycle (code).** Never edited, never deleted; survives the player's deletion with its
  text (§3).
- **Table (DDL 631).** `org_notes(id, org_id … RESTRICT, player_id REFERENCES players(id) ON
  DELETE RESTRICT, user_id REFERENCES org_users(id) ON DELETE SET NULL, scout_name, text,
  created_at)`.
- **Transaction boundary.** None (one blob push).
- **Tests.** `m23AgentTransactionE2E`, `m23AgentTransactionPersistence`, `m23BootContract`,
  `m23OfferE2E`, `m23RecruitmentJourneyHardeningE2E`.
- **Rollback implication.** One-to-one.

### 2.5 `ledger` → `ledger`

- **Shape (code).** `ledgerAppend(entry)` (S:658–665) is the only push: `{ id: 'led-*', ts,
  ...entry }` with `entry = { type, playerId, orgId, orgName, userId, scoutName, detail? }`;
  it broadcasts and returns the row. About forty-five call sites (server, `m12`, `m13`, `m15`,
  `m16`, `m29`); `type` is an open set that includes template literals. Container `seed.mjs:480`
  and the migration registry; contract `storeContract.mjs:101` (`migration`).
- **Readers.** Guardian `GET /guardian/log` (S:1672–1674, rows of the guardian's children);
  org `GET /org/ledger` (S:3136–3138, own org); player export (`exportPlayer`, S:4026–4035,
  own rows); `insightsFor` (S:1047–, own rows of seven types, counted by week and month);
  attribution `m29/index.mjs:270` (first qualifying event of the pair); shortlist-derived lists
  (`m13/groups.mjs:128`, `m13/planning.mjs:193`, `m13/imports.mjs:308`,
  `m18/nobodyMissed.mjs:129`); the org audit view (`m182/audit.mjs:206–214`, own org, a filtered
  set of action types, actor and target projected, no detail) and the org audit export
  (`m13/enterprise.mjs:332`, own org, raw rows); admin stats and the boot log line (S:148).
- **Authority and access.** The guardian sees a minor's discovery events; the organisation sees
  its own rows (which carry the player id and, for message rows, the player's or guardian's name
  as `scoutName`, S:949); the player sees their own rows in the export and as counts.
- **Lifecycle (code).** Append-only. **The truncation the plan and the DDL header cite
  (`m29/index.mjs:618`, `db.ledger.length = snapshot.ledgerLen`) no longer exists**: it was
  removed in `9656a4b` when the signing completion became one unit of work. Today the completion
  (`m29/index.mjs:603–665`) writes the ledger row inside the caller's unit (`recordCompletedSigning`,
  264–291: row at 274) and a refusal or a throw anywhere before COMMIT restores the memento
  (655–659), so the never-committed row disappears with the rest of the never-committed state —
  nothing committed is erased. A completed signing cannot be cancelled or voided
  (`m29/signing.mjs:174–175` admit only `DRAFT`/`READY`/`IN_PROGRESS`), so **no path erases or
  reverses a committed ledger row today**. The plan's "reversal row instead of truncation"
  objective is therefore moot for the rollback case; a reversal row would only ever be needed
  for a *future* operation that undoes a committed signing, and none exists.
- **Table (DDL 692).** `ledger(id, occurred_at, type, player_id REFERENCES players(id) ON DELETE
  RESTRICT, org_id … RESTRICT, org_name, actor_kind CHECK IN ('org_user','guardian','player',
  'system') or NULL, actor_id (no FK), actor_name, detail_json)` with four indexes. The DDL
  header's `userId/scoutName → (actor_kind, actor_id, actor_name)` rule must be derived from the
  call sites: `scoutName` is `'guardian'`, `'player'`, `'system'`, `'open day'`, an org user's
  name, or a person's name on message rows — the mapping is not one-to-one and the migration
  must either keep the two source fields verbatim (safest: `actor_id`/`actor_name` as written,
  `actor_kind` NULL where it cannot be derived) or document each derivation per `type`. **A
  migration that guesses an actor kind changes the audit record; the review recommends keeping
  the source fields verbatim and deriving nothing.**
- **Transaction boundary.** A ledger row written by a converted route lands inside that route's
  unit (signing completion, attendance, media tags — `testWriterAtomicity` proves tags + ledger
  and attendance + ledger roll back together); the plain routes (view S:2021, block, request)
  push outside a unit and wait for the next save. With a live table, every `ledgerAppend` call
  outside a unit would become an immediate single-row transaction (as the sessions repository
  writes today) **unless** the caller is converted, which changes the crash window from "lost
  with the blob" to "committed alone": acceptable for an append-only record, but the pairs that
  must commit together (block + ledger row, S:1695–1696 and 3896–3897) need a unit.
- **Tests.** 22 scripts read or count ledger rows; `apiE2E` (funnel from the ledger),
  `testWriterAtomicity` (coupled rows), `m29*` (attribution).
- **Rollback implication.** Rows map back to the blob one-to-one if the source fields are kept
  verbatim (the recommendation above). If the migration derives `actor_kind`, the rollback must
  not need it.

### 2.6 `opsEvents` → `ops_events`

- **Shape (code).** `{ id: 'ops-*', at, kind, detail }`; writers: `staff_bootstrapped`
  (S:1907), `delivery_failed` (`m13/delivery.mjs:118`), `audit_export`
  (`m13/enterprise.mjs:339`), `backup_refused` (`m13/enterprise.mjs:443`, written when the
  media-queue ownership check refuses a backup), `backup_failed` (`:504`), `backup_created`
  (`:508`), `webhook_failed` (`m13/imports.mjs:416`). Container `m13/shared.mjs:35`; contract
  `storeContract.mjs:110` (`module`).
- **Readers.** `GET /admin/metrics` (`m13/enterprise.mjs:555–565`): counts of two kinds and the
  last fifty rows newest first. Admin only.
- **Lifecycle (code).** Append-only, unbounded, never pruned.
- **Table (DDL 726).** `ops_events(id, occurred_at, kind CHECK IN ('staff_bootstrapped',
  'delivery_failed','audit_export','backup_created','webhook_failed'), detail_json)`. **The CHECK
  list is stale: `backup_refused` and `backup_failed` are written today and are not in it.** A
  migration against this DDL would refuse a file holding either row. The DDL needs the two kinds
  added before the step (a DDL correction, recorded here, not made by this review).
- **Transaction boundary.** The backup rows are written around a filesystem operation outside
  any unit; the others are single pushes.
- **Tests.** None reads `opsEvents` by name; the backup rows are produced by
  `testMediaDeletions`/`testCoreIdentityServer` backup paths only incidentally.
- **Rollback implication.** One-to-one.

### 2.7 `sourceChanges` → `source_changes`

- **Shape (code).** `m181/sourceChanges.mjs:27–56`: `recordSourceChange` builds
  `{ id: 'srcc-*', playerId, type, sourceSystem, sourceId, occurredAt, detail }` (35–43), pushes,
  **splices the oldest rows beyond 20,000** (47), and calls `persistNow()` (48). Called from the
  passport module (`m15/passport.mjs`, position changes). Container `:29`; contract
  `storeContract.mjs:169` (`migration`).
- **Readers.** `sourceChangesFor(playerId)` (53–55, oldest first), used by
  `m18/secondLook.mjs:151` (the second-look clock) and the passport module.
- **Authority and access.** Holds no player content (type, source system, source id, time,
  a small `{from, to}` detail); surfaced through the passport and second-look views.
- **Lifecycle (code).** Append-only with a hard cap — the cap is a deletion by design ("a change
  LOG, not history of record"). No deletion hook on player deletion.
- **Table (DDL 756).** `source_changes(id, player_id REFERENCES players(id) ON DELETE RESTRICT,
  type CHECK IN ('position_changed'), source_system CHECK IN ('passport_prefs',
  'position_history'), source_id, occurred_at, detail_json)`.
- **Transaction boundary.** `persistNow()` at every write (an immediate full save).
- **Tests.** `m181E2E` only.
- **Rollback implication.** One-to-one. The cap means the audit repository would carry one
  `DELETE` (oldest beyond 20,000) — the plan's acceptance test "no `UPDATE`/`DELETE` statement
  exists in the audit repository" must either exempt this cap explicitly or the cap is dropped
  with the table (an unbounded table of position changes is small; the choice is technical,
  recorded in §4.2).

### 2.8 `idvQueue` → `idv_queue`

- **Shape (code).** `POST /guardian/verify-id` (S:1361–1381): after the provider answers, one
  unit (1369–1378) writes `guardians.update(id, { idVerified: true, idvReference })` and pushes
  `{ id: 'idv-*', guardianId, guardianName, documentType, documentRef: last4, provider,
  reference, ts, status: 'approved' }` (1373–1377) — the column and the queue entry commit
  together (review of `9656a4b`). Container `m182/migrations.mjs:311`; contract
  `storeContract.mjs:98` (`migration`).
- **Readers.** `GET /admin/guardians` (S:4385–4387, the whole queue beside the guardian
  allowlist). Admin only; the guardian sees only their own `idvReference`.
- **Lifecycle (code).** `POST /admin/guardians/:id/idv` (S:4389–4400): one unit sets
  `guardians.update(g.id, { idVerified: approved })` and flips **the first queue entry for that
  guardian** (`find` by `guardianId`, 4396) to `'approved'` or `'revoked'` — later entries of a
  guardian who verified more than once keep `'approved'` (the DDL header records this). The
  route takes the guardian id, not an entry id; "the IDV admin toggle updates by id" in the plan
  cannot mean the entry id without a request-shape change, which this review does not propose.
- **Table (DDL 838).** `idv_queue(id, guardian_id REFERENCES guardians(id) ON DELETE RESTRICT,
  guardian_name, document_type, document_ref_last4, provider CHECK IN ('onfido',
  'dev-attestation'), reference, created_at, status)`.
- **Transaction boundary.** Both writers are already units; with a live table both become
  two-table transactions, with the status change an `UPDATE` of one column by row id.
- **Tests.** `m23ContactE2E`, `m23TrialE2E`, `testWriterAtomicity` (the verify-id unit with the
  seam `guardian.verify_id.after_row`).
- **Rollback implication.** One-to-one.

### 2.9 `emailChallenges` → `email_challenges` (club domain verification)

- **Shape (code).** `POST /org/verification/email` (S:3098–3117): free-mail domains refused
  (3101); `code = randomCode(6)` (3107; `adapters.mjs:39–42`: six characters from a 31-character
  upper-case alphabet without `I`, `L`, `O`, `0`, `1`, by `crypto.getRandomValues` — about 29.7
  bits); the org's previous challenge is filtered out and the new one pushed **in plain text**
  as `{ orgId, email, code, expiresAt: now + 30 min }` (3108–3109); the code is e-mailed in
  clear (3110–3114, as any one-time code must be); `persist()` (3115). Container S:282 and
  `seed.mjs`; contract `storeContract.mjs:87` (`module`).
- **Confirm.** `POST /org/verification/email/confirm` (S:3119–3133): the org's challenge is
  found by `orgId` (3121); missing or expired → 404 `CHALLENGE_NOT_FOUND` (3122–3123); the input
  is trimmed and upper-cased and compared with the stored code (3125); on success the challenge
  is removed (3128) and `orgs.update(id, { emailDomain, emailDomainVerified: true })` (3129, a
  table write), `persist()`, broadcast.
- **Table (DDL 786).** `email_challenges(org_id PRIMARY KEY REFERENCES orgs(id) ON DELETE
  CASCADE, email, code_hash CHECK length 64, expires_at)`: one row per org, the code stored as
  the sha256 of the upper-cased value.
- **Survey (§5.1)** covers expiry, normalisation, outstanding codes, attempts, rate limits,
  boundaries, single use, concurrency, backups and rollback.
- **Tests.** `apiE2E` (section 9), `preM24SweepE2E`.

### 2.10 `pairingCodes` → `pairing_codes` (child device pairing)

- **Shape (code).** `POST /guardian/children/:id/pairing-code` (S:3905–3914): the child must be
  in the guardian's `childIds` (3907); six characters from the same 31-character alphabet by
  `crypto.getRandomValues` (3909–3910); the child's previous code is filtered out and the new
  one pushed in plain text as `{ code, playerId, expiresAt: now + 15 min }` (3911–3912); the
  code is returned to the guardian (3913). **No `persist()` call**: the code reaches disk only
  with whatever save comes next. Container S:276; contract `storeContract.mjs:116` (`module`).
- **Pair.** `POST /auth/player/pair` (S:3916–3923), unauthenticated: the input is upper-cased
  and looked up by code (3918); missing or expired → 404 `CODE_INVALID`; the entry is removed
  (3920) and a player session is created (`createSession`, S:710 — the sessions table is
  written at once, S2) and returned.
- **Deletion.** `deletePlayerData` removes the child's codes inside the deletion unit
  (S:4172).
- **Table (DDL 809).** `pairing_codes(code_hash PRIMARY KEY CHECK length 64, player_id
  REFERENCES players(id) ON DELETE CASCADE, expires_at)` with `UNIQUE (player_id)`.
- **Survey (§5.2).** **Tests.** `apiE2E` section 2 (random format, wrong code refused, exchange,
  single use).

### 2.11 The guardian e-mail code (not a collection, but the third one-time code)

- **Shape (code).** Created at guardian sign-up as `emailCode: randomCode(6)` on the record
  (S:1275), rides in `guardians.facets_json` since S4a (plain, by the S4a decision:
  `identityMapping.mjs:29–41`, `email_code_hash` present in the table and NULL for every row,
  `identityMapping.mjs:141`); e-mailed in clear (S:1290); stripped from every response
  (S:1292, 1337) except `devEmailCode` on the dev-outbox transport (S:1297).
- **Verify.** `POST /auth/guardian/verify-email` (S:1301–1312): by `guardianId`; already
  verified → `{ emailVerified: true }`; the input is trimmed and upper-cased and compared
  (1306); on success one unit sets `emailVerified` and nulls the facet (1310).
- **No expiry, no attempt counting, no rate limit, no resend route** (no route re-sends or
  re-issues the code; `git grep resend` finds nothing). The only limiter in the sign-in area is
  `login_failure` (S:771–777; policy `m181/rateLimit.mjs:178`: 20 failures per identifier per
  15 minutes), applied to login routes and the agent login (`m25/index.mjs:120`), not to code
  verification. The limiter is **process memory only** (`m181/rateLimit.mjs:234–241`: the
  `memory` provider is the only one; counters reset on restart).

## 3. Deletion paths and dependencies

**Code facts.** `deletePlayerData` (S:4125–4180) is one unit: media file ids are queued
(4138), the player's sessions revoked (4139), **the player row deleted** (`players.remove`,
4140 — the S5 child rows and the guardian links cascade), requests and trials tombstoned
(4147–4148), names nulled on cases, assessments, contact responses and open-day registrations
(4149–4158), the m24–m29 hooks (4161–4169), channels, player notifications and pairing codes
filtered (4170–4172); after COMMIT the files are removed (4178). Routes: `DELETE /player/account`
(S:4184–4188, adults only) and `DELETE /guardian/children/:id` (S:4198–4202, any guardian whose
`childIds` lists the child). No route deletes a guardian or an organisation.

Of the ten S6 collections, deletion touches **only `pairingCodes`** (4172). `blocks`, `reports`,
`moderationLog`, `orgNotes`, `ledger`, `sourceChanges` and `idvQueue` are left as they are
(the comment at 4174 states the ledger rule: rows stay, id-only); `opsEvents` and
`emailChallenges` never name a player. After a deletion, therefore, every `playerId` in those
seven collections **points at a row that no longer exists** — today's documented state, not a
defect introduced by anything proposed here. `moderationLog.context.channelId` dangles the same
way after the channel is filtered (4170).

**What S4b would change** (proposed, unimplemented; [`s4-readiness-review.md`](./s4-readiness-review.md)
§9): `players.erase(id)` keeps the row with `deleted_at`, the retained columns per O1 (the full
birth date, now chosen; `country` undecided), every other personal column nulled, the name
replaced; the audit rows keep pointing at that retained row. S6's `RESTRICT` references are
written for *that* world (§4.1).

**Dependencies, stated once.**

| S6 item | Depends on | Why |
|---|---|---|
| `blocks`, `reports.target_player_id`, `org_notes`, `ledger.player_id`, `source_changes` with `REFERENCES players(id) ON DELETE RESTRICT` | **S4b implemented** (a retained row exists after deletion) | with today's hard delete the reference would make the deletion fail, §4.1 |
| the same tables **without** the player foreign key | nothing | they reproduce today's dangling-id state exactly; the FK is added by the S4b migration through a table rebuild |
| `pairing_codes` (`CASCADE` on players) | nothing | consistent with today's explicit removal at S:4172 and with a future retained row (whose codes are deleted explicitly either way) |
| `email_challenges` (`CASCADE` on orgs) | nothing | no org deletion route exists (O2 deferred); the FK can never fire today |
| `idv_queue` (`RESTRICT` on guardians) | nothing | no guardian deletion route exists; S4b's guardian route, if ever added, is limited to guardians with no undeleted child and would meet this reference deliberately |
| `ops_events` | nothing (after the CHECK-list correction, §2.6) | names no person |
| `moderation_log` | nothing | no foreign keys by design |
| guardian `email_code_hash` | nothing technically; §5.3 records the rollback consequence | the column exists since S4a |
| a write-time child-status stamp on `blocks` / `reports` / `moderation_log` / `org_notes` (D2 in the decision record) | **a product decision** ("Keep both decisions open for now") | not designed, not stubbed, not reserved as a column here |
| applying a country threshold to any retained birth date | **a product decision** (country code retention open) | the readiness review of S4b owns this; S6 does not touch `country` |

## 4. Append-only, `RESTRICT`, and the current hard delete — reconciled

### 4.1 Why a live player foreign key cannot ship before S4b

`store.mjs:104` sets `PRAGMA foreign_keys = ON` on the server's connection, and S5 relies on it
(the twelve `player_*` tables cascade with the row). Suppose `ledger.player_id REFERENCES
players(id) ON DELETE RESTRICT` were live. `players.remove(playerId)` (S:4140) issues `DELETE
FROM players WHERE id = ?`; SQLite checks the restricting references at that statement and
raises `FOREIGN KEY constraint failed`; the error propagates out of `unit`, the memento is
restored, and **the deletion answers 500 with nothing deleted**. Nearly every player has at least
one ledger row (a `view` row is appended on every club profile read, S:2021) and every player
who was ever blocked, reported, noted or whose position changed has a row in one of the other
tables — so with a live `RESTRICT` reference, **today's deletion route would stop working for
practically every account**, including the guardian's deletion of a child. The only ways to keep
the deletion working under a live FK are `ON DELETE CASCADE` (deletes the safeguarding history —
contradicts every lifecycle line in the DDL and the ledger rule at S:4174), `ON DELETE SET NULL`
(erases the id the record is kept for — contradicts "kept id-only"), or a retained row for the
reference to point at — which is S4b. There is no fourth option. The foreign key therefore
**requires the retained identity and is not introduced while S4b is unimplemented.**

**Proposed implementation.** If the audit tables are cut over before S4b, they are created with
`player_id TEXT` (indexed, `NOT NULL` where the source always sets it) and **no** `REFERENCES
players(id)`; the DDL header records "FK added by the S4b migration". SQLite cannot add a foreign
key with `ALTER TABLE`; the S4b migration rebuilds each table (create-copy-drop-rename inside its
transaction, `foreign_keys` checked after) and refuses if any row's `player_id` names no row — a
preflight that reports the dangling ids of today's deletions, which S4b must decide how to treat
(an id-only retained row written for them, or the rows left unreferenced in a table without the
FK). That treatment is an S4b design item, recorded in §9, not decided here. If instead S6's
audit tables wait for S4b, they ship with the FK as drafted and the rebuild never happens; the
cost is sequencing, not design. **Recommendation:** the codes sub-step (§6) proceeds now; the
audit tables are scheduled after S4b unless the Founder wants the audit cutover earlier, in which
case the no-FK shape above is the only safe one.

### 4.2 Which operations actually need append-only history, and which update a status today

| Collection | Writes today | Append-only needed for | Proposed treatment |
|---|---|---|---|
| `blocks` | insert; **hard delete on lift** (S:4407) | the fact that a block existed and who lifted it | add `lifted_at`, `lifted_by` (admin) instead of deleting; `isBlocked` reads `lifted_at IS NULL`; `GET /admin/blocks` keeps returning live blocks (the response shape is unchanged; whether lifted rows are also listed is an admin-UI choice, default: not listed) — so the one `DELETE` in this domain becomes an `UPDATE` of two columns |
| `reports` | insert; `UPDATE` of `status`, `outcome`, `resolved_at` by admin (S:4334–4336) | the submission (never edited) | keep the three-column status `UPDATE`; the resolve route becomes one unit with the `orgs.update` it already performs for `suspend_org` (today the two are not coupled) |
| `moderation_log` | insert only | everything | no `UPDATE`/`DELETE` |
| `org_notes` | insert only | everything | no `UPDATE`/`DELETE` |
| `ledger` | insert only (S:662); no erase path (§2.5) | everything | no `UPDATE`/`DELETE`; the "reversal row" item is withdrawn as a requirement because no committed row is ever reversed; should a future operation undo a committed signing, it appends a `signing_reversed` row and never touches the original — that rule is recorded here so the test in §7 can assert it |
| `ops_events` | insert only | everything | no `UPDATE`/`DELETE` |
| `source_changes` | insert; `splice` beyond 20,000 (`m181/sourceChanges.mjs:47`) | the recent window only (a log by its own definition) | either keep the cap as the one documented `DELETE` (oldest beyond 20,000, exempted by name in the acceptance test) or drop the cap with the table; **recommendation: keep the cap** so the behaviour the second-look clock relies on is unchanged, and name it in the test |
| `idv_queue` | insert; `UPDATE` of `status` by admin (first entry of the guardian, S:4396–4397) | the check record | keep the status `UPDATE`; whether to flip every entry of the guardian or the latest is a behaviour change the review does not propose (today: the first) |
| `email_challenges` | replace (delete + insert), delete on success | nothing — a short-lived credential | `INSERT OR REPLACE` by `org_id`, `DELETE` on success, `DELETE` of expired rows at boot or on request (today expired rows linger until replaced) |
| `pairing_codes` | replace, delete on use, delete on player deletion | nothing — a short-lived credential | the same; `DELETE` on use inside the pairing unit |

So "append-only" holds for six of the ten as a property of the repository's SQL (the plan's
test: no `UPDATE` or `DELETE` statement prepared for those six tables), is a status update for
`reports` and `idv_queue`, becomes a status update for `blocks`, and does not apply to the two
code tables.

### 4.3 What is deliberately not decided here

The retention of identifying text — report reasons, note text, moderation excerpts, ledger
message-row names, the commercial `signings`/`invoices` names — is listed in the decision record
(§8 items 3 and 4) and stays there. **The Founder's birth-date choice is a decision about the
retained player record; it is not evidence about any of those, and nothing in S6 infers one
from the other.**

## 5. The one-time codes, surveyed

### 5.1 Club e-mail challenge (`emailChallenges`)

| Aspect | Code fact | Note for the step |
|---|---|---|
| Entropy, alphabet | 6 of 31 characters, CSPRNG (`adapters.mjs:39–42`), ≈29.7 bits | unchanged |
| Expiry | 30 minutes, checked at confirm only (S:3122); an expired row lingers until the org re-requests or confirms | the table adds an expiry sweep (boot and on request); confirm keeps checking `expires_at` |
| Case normalisation | the code is generated upper-case; the input is trimmed and upper-cased before comparison (S:3125) | the hash is of the upper-cased value (DDL 780), so the comparison is `sha256(upper(trim(input))) = code_hash` |
| Outstanding codes | one per org by filter-then-push (S:3108) | `org_id` primary key |
| Attempt counting | none | add `attempts` (integer) and refuse after N failed confirms with `CODE_INVALID` → a new error or the existing 404 after invalidation — the number N is a technical setting (proposal: 10, then the challenge is invalidated and must be re-requested) |
| Rate limits | none on request or confirm (no `limited(` call in S:3098–3133); the mailer is called on every request | add two `RATE_LIMIT_POLICY` entries (`email_challenge_request` per org, `email_challenge_confirm` per org); the limiter is memory-only, so attempt counting on the row is what survives a restart |
| Account boundary | the org's own challenge only (by `req.org.id`); any org user may request and confirm | unchanged |
| Single use | removed on success (S:3128) | `DELETE` in the confirm unit |
| Concurrency | the request handler awaits the mailer **after** pushing the challenge (3109–3110): two overlapping requests leave the later code live, the earlier mail useless — benign; the confirm handler is synchronous | the confirm becomes one unit: hash check, `DELETE`, `orgs.update`; today the `orgs.update` writes its table at once while the challenge removal waits for the debounced save, so a crash in between leaves a verified org **with its challenge still live** — the unit removes that window |
| Backups | the plain code sits in the `collections` blob and therefore in every backup taken within its 30 minutes | hashed rows are what a backup holds after the step |
| Rollback | a hash cannot become a plain code: a copy-only rollback to the S5 build **drops every outstanding challenge** (at most one per org, at most 30 minutes old); the org re-requests | the tool prints the count dropped; nothing else is lost |

### 5.2 Child pairing code (`pairingCodes`)

| Aspect | Code fact | Note for the step |
|---|---|---|
| Entropy, alphabet | the same 31-character alphabet, CSPRNG (S:3909–3910) | unchanged |
| Expiry | 15 minutes, checked at pair only (S:3919); expired rows linger until replaced, consumed or the child is deleted | expiry sweep as above |
| Case normalisation | upper-case code; input upper-cased (S:3918) | hash of the upper-cased value |
| Outstanding codes | one per child (S:3911) | `UNIQUE (player_id)` |
| Attempt counting | none; the route is unauthenticated | per-code attempts are not meaningful (the attacker does not know which code they attack); a per-source limiter is the control |
| Rate limits | none on `/auth/player/pair` | add `pairing_attempt` keyed by the request's client key (the existing `clientKey`/IP convention), memory-only as every limiter is; the code space (≈9×10⁸) against a 15-minute window makes online guessing impractical under any limiter but not without one |
| Guardian boundary | any guardian whose `childIds` lists the child, co-guardians included (S:3907) — the same boundary as deletion | unchanged (a product question outside S6) |
| Single use | removed on use (S:3920) | `DELETE` in the pairing unit |
| **Persistence gap (code fact)** | the mint does **not** call `persist()` (S:3905–3914): the code exists in memory until some other save runs; a restart before that loses it (the child sees `CODE_INVALID`, the guardian mints again — benign). The pair route removes the entry in memory and `createSession` writes the sessions table **at once**, while the removal waits for the next save: a crash between the two leaves a **committed session and a still-live code in the blob** — after restart the code can be exchanged a second time for a second session. Single use is therefore not crash-safe today | the table closes both: the mint writes its row in its own transaction; the pairing unit deletes the row and inserts the session together |
| Backups | plain codes in every backup taken within 15 minutes | hashed after the step |
| Rollback | outstanding codes dropped by the rollback (at most 15 minutes old); the guardian mints again | count printed |

### 5.3 Guardian e-mail code (`guardians.facets_json.emailCode` → `email_code_hash`)

| Aspect | Code fact | Note for the step |
|---|---|---|
| Entropy | `randomCode(6)`, as above | unchanged |
| Expiry | none: the code stays valid until used | a technical choice for the step: keep no expiry (today's behaviour) or add one — with **no resend route**, an expiry would strand a guardian who waits; the review proposes **no expiry** and records that a resend route is a product addition, not part of S6 |
| Normalisation | upper-cased comparison (S:1306) | hash of the upper-cased value |
| Attempts, rate limit | none; `login_failure` covers sign-in only | add attempt counting per guardian (a column beside the hash, or a facet) and a limiter keyed by guardian id |
| Boundary | by `guardianId` in the body, unauthenticated (S:1302) | unchanged |
| Single use | the facet is nulled on success inside a unit (S:1310) | the hash column is nulled in the same unit |
| Backups | the plain code is in the guardian's facets in every backup until verified | hashed after the step |
| **Rollback (the real cost)** | a rollback to the S5 build restores the facet, but a hash cannot be turned back into the code; the S5 build compares the plain facet, so **every guardian who signed up after the step and had not yet verified could never verify on the older build** — and there is no resend route to issue a new code | the rollback tool must say so and count them; the mitigation is either a resend route (product addition) or keeping the plain code in the facet during a defined overlap — the review proposes **hashing the guardian code in a later sub-step, after a resend route exists**, and leaving it plain in §6's sub-step, exactly as S4a decided for the same reason (`s4-readiness-review.md` §8.2) |

## 6. The smallest technically independent sub-step — proposed, not implemented

**S6a — the two code tables.** `email_challenges` and `pairing_codes` become live tables with
hashed codes, expiry sweeps, attempt counting and rate limits; the guardian e-mail code stays
plain (§5.3). Nothing in it depends on S4b, O1's open parts, the audit tables or any product
decision: both references are consistent with today's hard delete (§3), both collections hold
short-lived credentials with no retention question, and the existing routes keep their request
and response shapes.

**Acceptance criteria** (each a test that fails on `2178c5b` first, where it tests new
behaviour):

1. Migration (next free id, §8): imports every outstanding challenge and code from the blobs
   as hashed rows, drops expired ones with a printed count, deletes the two blob rows, records
   itself — one transaction; a refusal (a malformed entry, a duplicate org or child) rolls the
   whole step back with ids and reasons; re-running is a no-op.
2. `POST /org/verification/email` writes one row per org (`INSERT OR REPLACE`), hashed; the
   plain code appears only in the mail; the response is unchanged.
3. `POST /org/verification/email/confirm` is one unit: hash comparison of the upper-cased trimmed
   input, `DELETE` of the row, `orgs.update(...)` — a COMMIT fault leaves the challenge live and
   the org unverified; the retry succeeds.
4. Confirm attempts are counted on the row; after N failures the challenge is invalidated and
   the org must re-request (error shape documented); the limiter entries exist in
   `RATE_LIMIT_POLICY` and the 429 body follows `rateLimitedBody`.
5. `POST /guardian/children/:id/pairing-code` writes its row in its own transaction (a SIGKILL
   right after the response no longer loses the code); one row per child; the response is
   unchanged.
6. `POST /auth/player/pair` is one unit: `DELETE` of the code row and the session insert commit
   together; a COMMIT fault leaves the code live and no session; after SIGKILL between the two
   there is no state in which the code can be exchanged twice (the crash-safety gap of §5.2 is
   closed and the test demonstrates the gap on `2178c5b` first).
7. Expired rows are removed at boot and on the next request for the same org/child; the pair and
   confirm routes still refuse an expired row that a sweep has not reached.
8. Player deletion deletes the child's code row inside the deletion unit (the explicit removal at
   S:4172 becomes the repository's `DELETE`, or the `CASCADE` fires — the test asserts the row is
   gone after COMMIT and present after a COMMIT fault).
9. Backup (`IDENTITY_SNAPSHOT`-style snapshot read) exports the hashed rows; restore imports
   them; a snapshot that carries a plain `code` field is refused (never silently hashed or
   dropped).
10. Copy-only rollback tool: rebuilds the two blob rows **empty** (the codes cannot be recovered),
    drops the tables and the migration record, prints the counts dropped; the S5 build boots on
    the copy, mints and pairs normally; the S5 rollback tool refuses a file carrying the S6a
    record (`LATER_SCHEMA`), as the S4a tool refuses S5 files.
11. Private views unchanged: no route returns a hash; the admin guardian allowlist and the org
    views carry no code field (asserted by the existing allowlist tests plus one check per table).
12. `npm test` and the battery suites that touch the routes (`apiE2E` sections 2 and 9,
    `preM24SweepE2E`, `testCoreIdentityServer`, `testWriterAtomicity`) pass; the schema-DDL test
    covers the two new tables.

**Commit boundary.** One commit: the migration module, the repository (`repositories/codes.mjs`
or similar), the four route conversions, the limiter policies, the rollback tool and its refusal
in the S5 tool, the tests, the DDL amendments, the operations guide and the plan's status line.
Registration in source is development work, not authorization for a real-data cutover.

**What S6a deliberately leaves out:** the eight audit tables (§4.1 sequencing), the guardian
code hash (§5.3), any status stamp, any retention change, any new route.

## 7. Test and rollback design for the next implementation (S6a, and the audit tables after it)

**Failing-first.** Every behavioural criterion in §6 is written as a test first and shown to fail
on `2178c5b` for the stated reason (the crash-safety gap of §5.2 is the clearest: a SIGKILL
between `createSession` and the next save, then a second exchange of the same code succeeds on
`2178c5b`).

**COMMIT fault injection.** `store.failCommitOfOpenTransaction()` and the development fault layer
(`faults.shouldFail(seam)`) are used as in `testWriterAtomicity`: seams after the first row of
each unit (`email_challenge.confirm.after_row`, `pairing.after_delete`) and at COMMIT; after each
fault the test re-reads through a second connection (no row, no session, blob unchanged), then
retries and succeeds.

**Swallowed nested errors.** A unit that catches an inner throw and continues must still roll
back: the test plants a throwing participant inside the unit and asserts the outer unit refuses
(the S4a participant/poisoning contract; `testUnitOfWork` has the pattern).

**Live-view restoration.** After a failed unit, the in-memory arrays and held references equal
the pre-unit state (memento), including the two code collections while they are still blobs on
the older path and the repository's views after the cutover.

**Restart.** SIGKILL after each committed step; reboot on the same directory; the state is the
committed one and nothing else (the code row exists after a mint; it is gone with a session
present after a pair).

**Private-view exclusions.** No response of the guardian, org, player or admin audience carries
`code`, `code_hash`, `email_code_hash` or `attempts` (one assertion per audience; the existing
allowlist tests are extended, not weakened).

**Migration preflight.** A dry run reports: the number of outstanding and expired entries per
table, duplicates (two challenges for one org, two codes for one child — impossible by the
filter-then-push today but possible in a hand-edited file), malformed entries (missing
`expiresAt`, non-string code), and — for the audit tables later — every `moderationLog.context`
key the context columns cannot hold, every `ledger.type`/`scoutName` combination, every
`opsEvents.kind` outside the CHECK list, every `reports` row without `targetPlayerId`. Any
problem refuses the migration with ids.

**Fresh and empty databases.** A first installation (no snapshot) creates the tables empty and
records the migration; an S5 file with empty code blobs migrates to empty tables; a file with no
blob row for a collection is treated as empty, never as "not cut over".

**Backup and restore.** The admin backup after S6a carries the hashed rows; a restore into a new
directory produces the same rows; a backup taken *before* S6a (plain codes in blobs) restored
onto an S6a build is imported through the same migration path (hashing on import), and the test
asserts a plain code never lands in a table.

**Source-preserving downgrade.** The copy-only tool never modifies the source directory; its
output is verified by booting the real `2178c5b` build on the copy (the old-build proof pattern
of S5, `scratchpad` script, detached worktree) and exercising a mint, a pair, a challenge and a
confirm; the S5 tool's `LATER_SCHEMA` refusal of an S6a file is asserted.

**What the old plan accepts and this review does not.** Plan §S6 says rollback is "pre-S6 backup +
S5 commit (audit rows written after S6 lost on rollback — say so in the release note)". **Stated
plainly: that rollback erases safeguarding history** — every block, report, moderation hit, note
and ledger row written between the cutover and the rollback would be gone, and a block lifted or
a report resolved in that window would revert. This review proposes **a copy-only tool for the
audit tables too** (rows → blobs, one-to-one, which §2 shows is possible for every table when the
ledger source fields are kept verbatim and lifted blocks are omitted from the blob) and
**refuses the backup-restore rollback as the documented path**: if a copy-only tool cannot be
written for a table, that table is not cut over. The only data a copy-only rollback of S6a
loses is the outstanding codes (§5.1–5.2), which is stated and counted.

## 8. Migration registry — facts

| Id | Step | State |
|---|---|---|
| `0001_org_users` | S0 | registered |
| `0002_core_identity_shadow` | S1 | registered |
| `0003_sessions_live` | S2 | registered |
| `0004_orgs_live` | S3 | registered |
| `0005_core_identity_live` | S4a | registered |
| `0006_media_deletions` | S4a | registered |
| `0007_player_subrecords` | S5 | registered (accepted at `2178c5b`) |

No `0008` exists. The plan's `0008_safety_audit` is a placeholder name: the identifiers of S4b
and of each S6 sub-step are **assigned from the actual order in which they are approved and
built** (S6a before S4b would make S6a `0008` and S4b `0009`; the reverse order swaps them).
Nothing is registered by this review. Existing identifiers never change.

## 9. Dependency table

| Category | Item | State |
|---|---|---|
| **Ready technical work** (no decision needed) | S6a — `email_challenges` and `pairing_codes` tables, hashed codes, expiry sweeps, attempt counting, limiter policies, the two crash-safety units, copy-only rollback (§6) | proposed; one commit when authorised |
| | DDL corrections recorded here: `ops_events.kind` CHECK adds `backup_refused`, `backup_failed` (§2.6); `ledger` mapping keeps `userId`/`scoutName` verbatim (§2.5); `moderation_log` needs a place for unknown context keys or a preflight refusal (§2.3); `blocks` gains `lifted_at`/`lifted_by` (§4.2) | documentation-only until the step that uses them |
| | Audit tables **without** a player FK (eight tables as in §4.1), if the Founder wants the audit cutover before S4b | proposed alternative; the review recommends sequencing after S4b instead |
| **Blocked by S4b** (implementation, not product) | Audit tables **with** `REFERENCES players(id) ON DELETE RESTRICT`; the S4b preflight's treatment of today's dangling ids (§4.1) | waits for the retained-record implementation |
| **Blocked by the country-code decision** | Any application of a country threshold to the retained full birth date (S4b's `wasMinorOn`); whether `country` stays on the retained row | open — "Keep both decisions open for now" |
| **Blocked by the child-status stamp decision** | A write-time `subject_minor` (+ rule, basis) column on `blocks`, `reports`, `moderation_log`, `org_notes`; the corresponding write in `handleReport`, the block routes and `moderateOrRefuse` | open — not designed, no column reserved |
| **Other policy questions documented, not for S6** | retention of report reasons, note text, moderation excerpts, ledger message names, commercial names (`s4-deletion-decision.md` §8 items 1, 3, 4); guardian deletion (item 5); who may delete a child (item 8); the unrecorded deletion event (item 9); a guardian code resend route (§5.3); the IDV toggle's "first entry" behaviour (§2.8); whether lifted blocks are listed to admins (§4.2) | recorded |
| **Not S6 at all** | the legacy-minor rule, every S4a/S5 guard, the deletion behaviour, the user interfaces | unchanged |

**Code facts / proposed implementation / unresolved product choices** — kept separate above:
§2, §3 and §5's "code fact" columns are the first; §4.1's no-FK shape, §4.2's treatments, §6 and
§7 are the second; §4.3, the two open O1 parts and the last two rows of this table are the third.

**Update, 19 October 2026 (from the code at `4f954ad`, after all four S7 sub-steps were accepted).** The table
above is kept as the dated record; the current per-table statement is `sqlite-migration-plan.md` §D.2: the
`players(id)` foreign key on five of the eight tables (`blocks`, `reports`, `org_notes`, `ledger`,
`source_changes`) waits for S4b — one SQLite fact; **a second fact, missed by §4.1 and by the first version of
plan §D (corrected 19 October 2026 after the review of `6956f52`): every snapshot-mode save deletes and
reinserts the players and guardians (`repositories/identity.mjs:205–207`), so an immediate `RESTRICT` reference
to either table — `idv_queue.guardian_id` included, with no guardian deletion route at all — makes even an
unchanged valid snapshot fail; a tombstone addresses account deletion and not that** (plan §D.2a, corrected
again after the review of `e7f7692`: the `PRAGMA defer_foreign_keys` deferral covers `RESTRICT` references
only — `SET NULL` and `CASCADE` act at the parent's DELETE whatever the pragma says and a clean final check
restores nothing — so every `SET NULL`/`CASCADE` key needs a parent-preserving or child-reconstructing design;
or an explicitly approved checked reference per table, **strict** for `idv_queue`'s guardian and **tolerant**
for the five historical player references, with the six exact-row checks). The tables themselves wait for the
Founder's approval of the no-FK shape of §4.1 (plan Q4 for the five player references as tolerant historical
references — no parent-existence rule, unresolved ids counted and kept; Q4b for `idv_queue`'s guardian
reference as a strict one — the per-reference contract is plan §D.4) and
for the block-lift behaviour choice (keep today's row delete at `server.mjs:4534`, or §4.2's
`lifted_at`/`lifted_by` rows — plan Q5); only `moderation_log` and `ops_events` wait for nothing but
authorisation. The candidate step (S6b, the eight tables with checked identity references, behaviour preserved,
child-status stamping deferred with Q2 left open, migration `0013`, copy-only rollback) is plan §D.4 Candidate
A — it removes the eight collections' serialisation from every save and does **not** meet the whole-snapshot-write
objective; the "rows → blobs" rollback of §7 stands; the writer line numbers of §2–§4 predate S7 and the current
ones are in plan §D.2's table.

---

## 10. S6a as implemented (independently accepted at `2d7ddeb`; not production-approved)

One local implementation commit (`e020aba`) on `feat/sqlite-schema` on top of `7fbce74`, one
local correction commit for two review findings on top of it (`b2a237e`, §10.6), and one local
correction commit for the independent review's transaction-participation finding on top of that
(`2d7ddeb`, §10.7).

> **Acceptance (14 October 2026).** The independent reviewer (Codex) examined the `2d7ddeb`
> package: the unchanged joined-failure reproduction passes, both earlier reproductions pass, the
> full 19-suite `npm test` chain passes on real Node 24.19.0 (275 reported checks), the eight
> changed files match the stated correction scope, and all 304 packaged source entries match the
> supplied blob manifest. **S6a is accepted within that reviewed backend development scope.** This
> is a bounded code-review conclusion on the packaged server source, not production or deployment
> approval; the reviewer did not inspect a live Git working tree, did not re-run the wider battery,
> browser suites, old-build proof or Node 22 binaries (those results remain producer-supplied,
> §10.5–§10.7), and the Player app was not part of the package — its unit tests were **not run**
> by the reviewer. S4a and S5 remain accepted; S4b and the eight remaining S6 audit tables remain
> unimplemented. Nothing pushed, merged, deployed or
run on real data. S4b stays unimplemented, today's account-deletion behaviour is unchanged apart
from the pairing-code row now going inside the same deletion unit, the eight audit tables are not
started, and the guardian sign-up e-mail code stays plain. The Founder's full-birth-date choice
is untouched by this step; country retention and the child-status stamp stay open.

### 10.1 What was built

| Piece | Where |
|---|---|
| Migration `0008_one_time_codes` — the next unused id in the actual registry (`0007` was the last) | `repositories/migrations/0008_one_time_codes.mjs`, registered in `DATA_MIGRATIONS` |
| Repository: hashing, issue/check/consume, attempts, sweep, hash-free views, snapshot read/replace, blob import, final-state checks | `repositories/oneTimeCodes.mjs` |
| Data-layer wiring: `emailChallenges` / `pairingCodes` table-backed; the views replace `db.*`; stale in-memory arrays dropped and reported, never imported | `repositories/index.mjs` |
| Routes converted (request/response shapes unchanged): challenge request and confirmation, pairing mint and exchange; deletion revokes the code in its unit | `server.mjs` |
| Four rate-limit policies | `m181/rateLimit.mjs` |
| Backup export of the stored rows | `m13/enterprise.mjs` |
| Copy-only rollback tool (to the S5 build) and its CLI | `repositories/oneTimeCodesRollback.mjs`, `scripts/oneTimeCodesRollback.mjs` |
| DDL amended to the implementation (attempts column, expiry indexes, no player FK) | `sql/03_messaging_safety_audit.sql` |
| Tests | `scripts/testOneTimeCodes.mjs` (unit), `scripts/testOneTimeCodesServer.mjs` (real server); existing suites adapted to the registered step and the S6a-first rollback chain |

### 10.2 Concrete parameters (chosen with the existing conventions)

| Item | Value | Convention it follows |
|---|---|---|
| Stored form | sha256 hex of the code trimmed and upper-cased | the sessions repository hashes tokens with sha256; the routes always compared trimmed, upper-cased input |
| Code | 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, CSPRNG | unchanged (`adapters.mjs` `randomCode`, the pairing route's own alphabet) |
| Lifetimes | challenge 30 min, pairing code 15 min | unchanged |
| Expiry | judged on every read (`expires_at > now`); swept at boot and before every issue | — |
| Challenge attempts | counted on the row; the 10th wrong code cancels the challenge | durable across restarts, unlike the process-memory limiter |
| `email_challenge_request` | 5 per organisation per hour | each request sends a mail |
| `email_challenge_confirm` | 20 wrong codes per organisation per 15 min | the `login_failure` pattern: wrong guesses only |
| `pairing_code_mint` | 20 per guardian per hour | — |
| `pairing_attempt` | 20 wrong codes per client address per 15 min | on top of the per-IP `/auth` limiter (40/min) |
| Budget test | refused once `max` wrong codes were judged (`peek(...).remaining === 0`), **before** the code is judged | stricter than `login_failure`, which judges `max + 1` |

Why these are enough for short codes: a pairing guesser must hit one of the live codes
(≈ 9 × 10⁸ values) within 15 minutes at 20 wrong guesses per address per 15 minutes; a challenge
guesser gets 10 attempts per issued challenge and 5 challenges per hour. These are per-process
limits; behind a load balancer each instance counts separately (as for every limiter today,
reported by `/capabilities`).

### 10.3 The specification inconsistencies, resolved before coding

1. **Legacy versus new-format backups.** A snapshot entry is either the legacy shape every earlier
   build wrote (`code`, plain) or the stored shape a post-S6a backup holds (`codeHash`, and
   `attempts` for a challenge). The two are told apart by the presence of exactly one of the two
   fields; each format has its own allowed field list. A legacy entry goes through the validated
   path and is hashed; a malformed stored entry — or one with both fields, neither, an unknown
   field, a bad hash, expiry or attempt count — is refused with its index and reason, and the
   whole write (migration or snapshot save) rolls back. Nothing is reinterpreted or dropped
   silently; the migration's one deliberate drop (entries already expired) is counted and logged.
2. **The pairing-code issuance response is preserved** (`{ code, expiresAt }`, 201). The privacy
   tests treat that response and the challenge mail as the intended delivery and assert that no
   other response — capabilities, the guardian's, the child's, the club's and the admin views, the
   pairing response itself — carries either code or its hash. *(As committed in `e020aba` this
   item also said "the backup carries no plain code"; that was proven only by a search for the
   code as an exact quoted JSON value, and was false: the mail outbox record held the code inside
   its text. Corrected in §10.6.)*
3. **Failure assertions are specific to each operation.** A failed confirmation (seam after the
   consumption, real COMMIT fault) is asserted to keep the challenge row and leave the
   organisation's `email_domain_verified` at 0; a failed pairing is asserted to keep the code row
   and create no session; a failed deletion keeps both the child and the code. Each is read
   through an independent connection, then the retry is shown to land.
4. **The original pairing defects were demonstrated on the original implementation**, not
   inferred: the scratch script `s6a/old-build-proof.mjs` (in the handoff) runs the SAME steps on
   the real `7fbce74` build and on the S6a tree. On `7fbce74` a code minted just before a SIGKILL is
   unknown after the restart (404), and a code exchanged just before a SIGKILL buys a SECOND session
   after the restart (200, two sessions). On S6a the first pairs (200) and the second is refused
   (404, one session). The new-schema acceptance tests are not claimed to run on the old build.

### 10.4 Where the implementation departs from §§5–7, and why

- **`pairing_codes.player_id` has no foreign key** (§3's table proposed `CASCADE`). The identity
  snapshot rewrite (`IDENTITY_SNAPSHOT.replace`) deletes and reinserts every player row, so a
  cascading reference would silently erase every pairing code on a whole-snapshot save that omits
  the collection. Instead: the deletion unit revokes the child's code explicitly, every snapshot
  write checks the final state (`PAIRING_CODE_PLAYER_MISSING`), the migration refuses a live code of
  a player that does not exist, and the exchange route treats an orphan code as dead.
  `email_challenges.org_id` keeps its `CASCADE` (organisations are upserted and pruned, never
  rewritten whole).
- **Two organisations may hold the same e-mail code** (a coincidence the random draw allows): the
  duplicate-code refusal applies to pairing codes only, whose code is the lookup key. A minted
  pairing code equal to another child's live code is **redrawn** (up to eight draws, then the
  issue is refused with nothing written).
- **Expiry sweep** runs at boot and before every issue, not "on the next request for the same
  owner" (§6 criterion 7): simpler and covers every owner.
- **Acceptance criterion 4's error shape**: a wrong confirmation answers `400 CODE_INVALID` with
  `attemptsRemaining`; the tenth says the challenge is cancelled; the next attempt with any code
  answers `404 CHALLENGE_NOT_FOUND`, the existing "request a fresh code" answer.
- **Acceptance criterion 10**: the rollback writes the two blobs **empty**, as proposed, and also
  counts the already-expired rows it drops; the S5 tool's refusal of an S6a file needed no change
  (its known-migration list already refuses any later id).

### 10.5 Verification

All runs on synthetic data in temporary directories; no real database, backup or runtime data
directory was read or written. Commands, versions and logs are in the handoff.

| What | Command | Result |
|---|---|---|
| `npm test`, Node 22.22.2, real 22.15.1 / 22.16.0 probed by the runtime suite | `SCOUTBOX_TEST_NODE_BINS=<22.15.1>:<22.16.0> npm test` | 19 suites pass, exit 0 — runtime 6, trust 23, identity 20, data-layer 16, core-schema 10, sessions 24, organisations 14, unit-of-work 17, mapping 27, identity repositories 16, migration 7, rollback 6, media-deletion 7, player sub-record 17, **one-time-code 15**, schema-DDL 13, core-identity server 14, writer-atomicity 9, **one-time-code server 8** |
| `npm test` on the real Node 22.16.0 binary | `PATH=<22.16.0 bin>:$PATH npm test` | the same 19 suites pass, exit 0 |
| Original defects on the real `7fbce74` build, and the copy-only downgrade | scratch `s6a/old-build-proof.mjs` (detached worktree at `7fbce74`) | 25 of 25 steps: both pairing defects reproduced on `7fbce74` and closed on S6a; the rollback copy boots on `7fbce74`, which mints, pairs, issues and confirms; the S5 tool refuses the S6a file (exit 4); the S6a build re-upgrades the copy |
| Battery (every E2E / persistence / contract suite), once | `battery-s6a.sh` | 46 of 48 green as run. `m182E2E`: the same two client-side baseline failures as every round since `66c095c`. `m23BootContract`: 3 failures — the contract still declared `emailChallenges` / `pairingCodes`, which production code no longer reads through `db.*`; fixed by removing the two entries from `storeContract.mjs` (the `mediaDeletions` precedent) |
| After that fix | `m23BootContract`, `apiE2E`, `preM24SweepE2E`, `m181E2E`, and both `npm test` runs above | all green (57, 130, 40 checks; m181 all passed) |

Not run or not claimed: the browser suites (no client changed); the other 42 battery suites were
not re-run after the store-contract change (it removes two `module`-guarantee entries; the
`migration`-guaranteed list that the migration registry and the integrity report read is
unchanged); no independent review has happened; nothing here is production approval.

### 10.6 Review-and-correction round on `e020aba` (two findings)

A bounded round on two review findings, starting from `e020aba`; one local correction commit.
Status after this round: **S6a implemented, pending independent review; not production-approved**
(the independent review that followed found one further defect, corrected in §10.7).
Addressing these two findings is not an independent review of the whole implementation. S4b
remains unimplemented, the audit tables remain pending, and country retention and the
child-status stamp remain undecided.

**Finding 1 — the challenge code reached the database and every backup.** *Reproduced* on
`e020aba` with the real server in both mail transports (dev outbox; and a live `SENDGRID_API_KEY`
with every request to the provider answered by a local stub): the raw code was in the `outbox`
collection blob of the database file and in the backup's `db.json`. *Cause:* the mailer records
every mail in `db.outbox` with its full text in both transports; the outbox is saved like any
collection and spread into every backup (`...db`). S6a hashed the challenge rows but left this
copy. The `e020aba` test searched the backup for the code only as an exact quoted JSON value
(`"CODE"`), which never matches a code embedded in a sentence, so it passed. *Impact:* every
challenge code issued was readable in plain text from the database file and from every backup
taken afterwards — the exposure the hashed storage was meant to remove, for the 30-minute life
of the code. *Correction (smallest consistent with hashed storage, delivery preserved):*
`mailer.send` takes `secrets`; the persisted outbox record keeps the mail with each secret
replaced by `[code withheld — delivered to the recipient only]` in both transports. The provider
still receives the full text. On the dev transport, where the outbox *is* the delivery, the full
text is kept in the process's memory only (bounded to 500, never saved) and `GET /admin/outbox`
shows it, so the dev flow and `apiE2E` still read the code there. The challenge route passes
`secrets: [code]`, and its `persist()` after the mail (present in `7fbce74`, dropped in
`e020aba`) is restored. *Contract change to note:* in production the admin outbox audit copy no
longer shows the code. In dev the code is no longer visible after a restart. No other mail is
changed, and no mail history is rewritten.

**Finding 2 — stored challenge attempt counts.** Probed on `e020aba`: a stored-format entry
*without* `attempts` was accepted as 0; `attempts` 10 and 15 (at or above the limit) were
accepted; an unexpired row at 10 attempts still checked `ok` and could be consumed with the
correct code. *Not* defective: null, negative, fractional, nonnumeric and unsafe counts were
already refused; nine attempts followed by a tenth wrong code already cancelled the challenge;
legacy entries (no count) were already accepted at 0. *Cause:* the validator treated `attempts` as
optional in the stored format and had no upper bound; the runtime judged only expiry. *Impact:* a
backup or a hand-edited snapshot could reset a challenge's guess budget by omitting the count, or
import an exhausted challenge as redeemable. *Correction:* the stored format requires
`attempts`, a safe integer from 0 to 9 (an exhausted challenge is cancelled, never imported). The
legacy format is unchanged (no count, starts at 0). Every runtime read (check, failed-attempt
note, consumption, including the `DELETE … AND attempts < 10` itself, outstanding counts, the
rollback's invalidated/dropped counts) treats a row at the limit as dead, and the sweep removes it
like an expired row. A refused import rolls back whole: unrelated data and `meta.saveSeq` are
unchanged. Legitimate counts survive backup and restore (2 → 2 in the test). The limit is enforced
in code, not as a DDL `CHECK`.

**Regression tests** (each was shown to fail on `e020aba` for the intended reason; the scratch
log is in the handoff):

| Test | Suite | On `e020aba` |
|---|---|---|
| backup/restore — the whole serialized `db.json` and every table searched for both codes as substrings; the outbox mail kept, code withheld; count 2 survives; refused backups (no count; count 10) | `testOneTimeCodesServer.mjs` | fails: the raw code is in `db.json` |
| club e-mail challenge — the database file carries no raw code after the flow | same | fails: the raw code is stored |
| finding 1 — the challenge mail: delivered with the code (dev outbox view; live provider body through the stub), saved with it withheld, absent from the file in both transports | same | fails: the mail is not saved withheld |
| finding 2 — an exhausted row planted at the limit is not redeemable through the real route | same | fails: 200 and the club verified |
| finding 2 — stored attempts: missing, null, negative, fractional, nonnumeric, unsafe, 10, 15 refused; 9 accepted; legacy accepted at 0; a refused snapshot write leaves other data and `saveSeq` unchanged | `testOneTimeCodes.mjs` | fails: a missing count is accepted |
| finding 2 — runtime: an exhausted row neither checks nor consumes, is not outstanding, is swept; 9 then a tenth wrong code cancels | same | fails: the row checks `ok` |
| finding 1 — the mailer: withheld in the record in both transports, full text to the provider and to the dev view only | same | not runnable on `e020aba` (new export) |

**What is now proven, and what is not.** Proven by test (substring search of every table of the
database file and of the complete backup `db.json`, both transports): a challenge code issued by
this build is in neither. Not claimed: outbox records written *before* this correction (by
`e020aba` or a pre-S6a build) still hold the codes they were written with, and so do backups
holding them, and a pre-S6a backup's own files. Those codes have long expired. Scrubbing that
history would be a retention change, which this round does not make. The guardian sign-up code
and other mails carrying a secret (organisation invitations) are outside S6a and unchanged.

**Verification of the correction (new evidence from this round).** Synthetic data in temporary
directories only. Node 22.22.2 (plus the real 22.15.1 and 22.16.0 binaries). Logs are in the
handoff.

| What | Command | Result |
|---|---|---|
| Reproduction of finding 1, real server, dev and live (stubbed) transports | scratch `repro-finding1-backup-plaintext.mjs <server dir>` | `e020aba`: reproduced in 2 of 2 modes (the code in the `outbox` blob and in the backup `db.json`; the exact-quoted search used by `e020aba` finds nothing). Corrected tree: not reproduced |
| Reproduction of finding 2 (13 probes) | scratch `repro-finding2-attempts.mjs <server dir>` | `e020aba`: 5 defects (missing count accepted; 10 and 15 accepted; an exhausted row checks `ok` and is consumed). Corrected tree: 0 |
| Failing-first: the new and strengthened tests on `e020aba` | scratch worktree at `e020aba`, test files copied in, `TEST_ONLY=…` | every regression fails for its intended reason (the mailer unit test cannot load there: new export) |
| `npm test`, 22.22.2, runtime suite probing real 22.15.1 / 22.16.0 | `SCOUTBOX_TEST_NODE_BINS=<22.15.1>:<22.16.0> npm test` | 19 suites pass, exit 0. One-time-code unit 18 (was 15), one-time-code server 10 (was 8), writer atomicity 9, the rest unchanged |
| `npm test` on the real 22.16.0 binary | `PATH=<22.16.0 bin>:$PATH npm test` | the same 19 suites pass, exit 0 |
| Mail, persistence and backup consumers (the dev outbox as delivery, backups, store contract) | `apiE2E` against a fresh server; `connectedE2E`, `m12E2E`, `m13E2E`, `m141E2E`, `m14E2E`, `m15E2E`, `m23ContactE2E`, `m23DecisionE2E`, `m23P4AClosureE2E`, `m23TrialE2E`, `m23BootContract`, `preM24SweepE2E` | all 13 green (apiE2E 130 checks; it still reads the challenge code from `/admin/outbox`) |

Not run in this round: the other battery suites, the browser suites (no client changed), and the
`7fbce74` old-build proof (no rollback or migration behaviour it exercises changed, apart from
the counts, which the unit suite covers). The results in §10.5 are the previous implementer's
round and were not re-run here, except as part of `npm test`.

### 10.7 Independent review of `b2a237e`: the repository did not take part in the unit of work

The independent review of the `b2a237e` package accepted the two §10.6 corrections and found one
further defect, reproduced by its own script (`review-b2a237e-joined-failure.mjs`, synthetic
temporary database, independent read connection). One local correction commit on top of
`b2a237e`. Status: **S6a implemented, pending independent acceptance; not production-approved.**

**Finding — a caught one-time-code repository failure could commit partial work.** The
repository's transactional helper was `sqlite.isTransaction ? fn() : transaction(sqlite, fn)`,
and `attachDataLayer` constructed it without the store's participant API. Inside an open unit of
work `isTransaction` is true, so an operation simply ran its statements in the unit's
transaction without going through `unit.join`: a failure after a statement had already run did
not poison the unit. *Reproduced* on `b2a237e`: a pairing reissue deletes the child's old row and
then fails at the replacement insert (a temporary `BEFORE INSERT` trigger raising `ABORT`, which
cancels only the failing statement). Standalone, the repository's own transaction rolled back and
the old code survived. Inside `store.unitOfWork`, with the work catching the exception, the unit
reported success: the old code was permanently gone, an unrelated `requests` edit committed, and
`saveSeq` advanced. *Qualification:* this is a repository/unit-of-work contract defect. The HTTP
mint route does not catch this exception inside a unit, so no observed API or phone failure is
claimed, and normal successful redemption was never broken. Four mutations
(`consumeEmailChallenge`, `consumePairingCode`, `revokeEmailChallenge`, `revokePairingCodesFor`)
had no boundary at all (bare statements), and the argument validation of the two issue methods
ran before the boundary.

**Correction.** `createOneTimeCodesRepository` takes `unit` (the store's participant API, or
null for a tool, a test or the migration; a malformed value is refused at construction) and
`attachDataLayer` passes `store.unit`. Every mutation — issue, consumption, the failed-attempt
count, revocation, the sweep — runs through one boundary, `operation`:

| State of the connection | What `operation(fn)` does |
|---|---|
| a store unit of work is open (`unit.active()`) | `unit.join(fn)`: the operation runs inside the unit's transaction through the poisoning boundary; a throw is rethrown unchanged and the unit can no longer commit, even if the caller catches it |
| no unit, but a raw SQLite transaction is open (a tool, a test, the migration) | `fn()` as part of that transaction: no BEGIN of its own; the caller owns the transaction, and it is never taken for a unit |
| nothing open | `transaction(sqlite, fn)`: BEGIN, the statements, COMMIT, or ROLLBACK and rethrow |

No nested BEGIN, no savepoint; the store contract (`store.mjs`) is unchanged. Argument
validation now runs inside the boundary (a refused argument inside a unit poisons it like any
other failure). Expected negative results — no live code, no match, nothing to delete — stay
return values (`null`, `{ status: 'none' }`, `{ attemptsRemaining: 0, invalidated: false }`, a
zero count) and never poison a unit. The routes are unchanged.

**Regression tests** (`scripts/testOneTimeCodes.mjs`, three new checks; each shown to fail on
unchanged `b2a237e` for its intended reason, the log in the handoff):

1. *The reviewer's case*: real store, attached data layer, independent read connection. The
   standalone control still rolls back. With the work catching the error, the enclosing unit now
   throws (`cannot commit … injected pairing insert failure`, `cause` the swallowed error,
   `unitOfWork: 'rolled_back'`), the old code, the `requests` blob and `saveSeq` are unchanged in
   the file, the in-memory edit is restored, no transaction is left open, and an explicit retry
   lands with the revision advanced once.
2. *The e-mail side, a multi-statement operation that already wrote*: at nine attempts the tenth
   wrong code increments the count and then its cancellation fails (temporary `BEFORE DELETE`
   trigger). Standalone the count stays at nine; joined and caught, the whole unit rolls back
   (nine in the file, memory restored, `saveSeq` unchanged); the retry cancels the challenge.
3. *The boundary itself*: joined successes commit with the unit (one revision); an uncaught
   failure rolls back as before; every expected negative inside a unit is a result and the unit
   commits; a caught validation failure poisons the unit; a raw transaction on the store's
   connection outside a unit, and on a bare connection without a store, is honoured without a
   nested BEGIN and undone by the caller's ROLLBACK; a participant API without `join()` is
   refused.

The existing checks that remain in force: the confirmation and pairing units under an injected
failure after the consumption and under a real COMMIT failure (§10.3 item 3), the concurrent
redemption race, the server suite's SIGKILL and COMMIT-fault cases, and `testUnitOfWork.mjs`.

**Verification of this round** (synthetic data in temporary directories; new evidence, not a
re-labelling of earlier rounds; logs in the handoff). The source under test was identical to the
committed source; only documentation was edited after the runs started.

| What | Runtime | Command | Result |
|---|---|---|---|
| The reviewer's script, unchanged, before the correction | 22.22.2 | `node review-b2a237e-joined-failure.mjs <server>` | **exit 1, REPRODUCED** (the standalone control passes; the unit committed the fragment) |
| The three new regressions on unchanged `b2a237e` | 22.22.2 | `TEST_ONLY=… node scripts/testOneTimeCodes.mjs` | each exit 1 for its intended reason |
| The reviewer's script, unchanged, after the correction | 22.22.2 and real 22.16.0 | same | **exit 0, CORRECTED**: SQL and memory preserved after the caught error, retry permitted |
| `scripts/testOneTimeCodes.mjs` | 22.22.2 and real 22.16.0 | `node scripts/testOneTimeCodes.mjs` | 21 checks (18 + 3), exit 0 |
| `scripts/testUnitOfWork.mjs` | 22.22.2 and real 22.16.0 | `node scripts/testUnitOfWork.mjs` | 17 checks, exit 0 |
| `scripts/testOneTimeCodesServer.mjs` | 22.22.2 and real 22.16.0 | `node scripts/testOneTimeCodesServer.mjs` | 10 checks, exit 0 |
| The two §10.6 reproductions, unchanged, SendGrid stubbed locally | 22.22.2 and real 22.16.0 | `node repro-finding1-backup-plaintext.mjs <server>`, `node repro-finding2-attempts.mjs <server>` | both NOT REPRODUCED, exit 0 |
| `npm test` (19 suites; the runtime suite probing the real 22.15.1 and 22.16.0 binaries) | 22.22.2 | `SCOUTBOX_TEST_NODE_BINS=<22.15.1>:<22.16.0> npm test` | 19 suites pass, exit 0 (22.15.1 refused as below the contract, 22.16.0 supported — both real probes, not skipped) |
| `apiE2E` against a fresh server | 22.22.2 | `node server.mjs` + `node scripts/apiE2E.mjs` | 130 checks, exit 0 |

Not run in this round: the full `npm test` chain on the real 22.16.0 binary (the focused checks
above were run there; the chain was run on 22.22.2 with the real binaries probed), the wider E2E
battery and the browser suites (no route, client, mail, backup or migration behaviour changed),
and the `7fbce74` old-build proof. Nothing here is production approval.

---

## 11. S6b as implemented (19 October 2026, one local commit on `feat/sqlite-schema` on top of `1792fc7` — dated history; PENDING INDEPENDENT ACCEPTANCE)

**Status at the time of writing: IMPLEMENTED, PENDING INDEPENDENT ACCEPTANCE.** Not production, security,
legal-compliance or deployment approval; not acceptance of S4b, S8 or the whole SQLite migration; nothing pushed,
merged or deployed; no real data, no real provider. The independent review of `1792fc7`
(`review-1792fc7-summary.txt`, 19 October 2026) accepted the corrected next-stage brief — plan §D.4 Candidate A with
its per-reference contract — as the basis for this bounded storage migration (S7a–S7d stay accepted; the brief's
acceptance is not an S6b acceptance) and handed over an implementation prompt carrying the Founder's three answers.

**The Founder's decisions, recorded verbatim (19 October 2026, received in the review conversation; explicit answers,
not inferences from documents or silence; not to be asked again):**

> Q4: Approve — preserve current behaviour (Recommended).
> Q4b: Approve — move with strict guardian checks (Recommended).
> Q5: Keep today's removal behaviour for this migration (Recommended).

The review's reading of them, which this implementation follows: Q4 — the five historical player-audit references
(`blocks.player_id`, `reports.target_player_id`, `org_notes.player_id`, `ledger.player_id`,
`source_changes.player_id`) stay when the player is absent; unresolved references are **counted and reported, never
refused**, no record deleted, no account invented, and **no new parent-existence rule** for these five. Q4b —
`idv_queue` moves now with **application checks requiring an existing guardian**; the database foreign key is a later
step. Q5 — lifting a block **deletes its row** as today; no retained block history, no `lifted_at`/`lifted_by`.
Nothing else was decided: child-status stamping (Q2) and the country code (Q1) stay OPEN; the full birth date, D-A/D-B
and the legacy-minor stop rule are unchanged; A0/A1/A2/A3, S4b and S8 were not authorised and were not built.

### 11.1 What was built

- **Repository** `repositories/safetyAudit.mjs` — one module for the eight collections (the plan named it
  `audit.mjs`; the name follows the migration's). Each table is `seq INTEGER PRIMARY KEY` (array position at the
  import, insertion order afterwards), `id TEXT NOT NULL UNIQUE`, the writer's literal columns, and three lossless
  columns: `absent_keys_json` (a known key the writer did not pass — restored as absence), `offtype_json` (a known
  key whose value is not the column's type — a numeric or object `targetPlayerId`, an object `orgId`, a numeric
  `reason` — kept as JSON and restored exactly) and `extra_json` (unknown own fields, restored first). The
  `moderationLog.context` object is kept WHOLE in `context_json` (the per-field columns the DDL draft proposed are
  not created, so no context key can be lost — §2.3's open point); `ledger.userId` / `scoutName` are stored verbatim
  as `user_id` / `actor_name` with **no actor kind derived** (§2.5); every `opsEvents.kind` is an ordinary row — no
  vocabulary CHECK anywhere (§2.6's missing kinds cannot recur). The repository runs in the data layer's staged mode
  (a write is queued and lands in the next save — `persist()`/`persistNow()` — or in the enclosing unit of work's
  commit; the graph memento restores the mirror in place on an aborted unit, review §11.10/§11.12 pattern); the
  eight `db.*` names are read-only views in insertion order, so every existing reader (the admin consoles, the
  reporters' lists, the guardian log, the org ledger, `isBlocked`, `insightsFor`, the exports) reads the view
  unchanged. Operations: `append` on every collection (validated like an import), `reports.patch` (status, outcome,
  resolvedAt — the resolve route's three fields, by row id), `idvQueue.patch` (status, by row id) and
  `idvQueue.firstForGuardian` (the toggle's first-entry rule, preserved), `blocks.remove` (Q5),
  `sourceChanges.trimTo` (the m181 cap: the OLDEST rows beyond 20 000 deleted, the array's splice), `exportAll` (the
  admin backup), `counts`, `pending`, `unresolvedPlayerReferences`.
- **Migration** `repositories/migrations/0013_safety_audit.mjs` (REGISTERED after `0012_channels`): creates the eight
  tables, imports the eight blobs through the repository's validation (nothing coerced, narrowed or dropped), counts
  per collection the rows with extra fields, absent keys, off-type values and — Domain P — unresolved player ids,
  refuses the WHOLE step on any shape refusal or any IDV entry naming a missing guardian
  (`SAFETY_AUDIT_IMPORT_BLOCKED`, listing `IDV_GUARDIAN_MISSING` with ids only), retires the blob rows and records
  the counts in `meta.safetyAuditCutover`. A file without the blobs creates the tables and imports nothing.
- **Domain P (tolerant, Q4)** — `unresolvedPlayerReferences()` counts per table the rows whose `player_id` /
  `target_player_id` names no row of `players` and the rows without one; the count is in the cutover record, the
  data-layer report (`GET /capabilities` → `persistence.dataLayer.domains.safetyAudit.unresolvedPlayerReferences`)
  and every snapshot write's log line. It is a count, never provenance, never a refusal. `handleReport` still stores
  a truthy `targetPlayerId` of any type as received (checked by the suites with a numeric and an object value).
- **Domain G (strict, Q4b)** — `idv_queue.guardian_id NOT NULL`, checked in code: `append` refuses a guardian that
  is not in the `guardians` table; the import refuses the whole 0013 step; the snapshot dispatcher runs the
  final-state assertion whenever a save carries `idvQueue` **or** the identity pair (the S7d trigger: an
  identity-only replacement that removes a referenced guardian is refused with ids only, atomically — the omitted-
  queue case the brief named; a coordinated replacement removing the guardian and its entries together passes).
- **Writers converted** (all surveyed call sites; the module context objects pass `safetyAudit`): `ledgerAppend`,
  `moderateOrRefuse` (moderation hit and the automatic grooming report), `handleReport` (the report and the urgent
  suspension blocks), the guardian and player block routes, the org note route, the IDV route (inside the guardian's
  unit, the row and the columns commit together), the staff bootstrap ops event, the admin resolve, IDV toggle and
  lift routes, `m13/delivery.mjs` (`delivery_failed`), `m13/enterprise.mjs` (every ops-event kind and the backup
  export, which now spreads `safetyAudit.exportAll()`), `m13/imports.mjs` (`webhook_failed`),
  `m181/sourceChanges.mjs` (append + cap). The three m13 modules and m181 keep an array push for a bare context
  without the repository (the reviewer feasibility scripts); the server always passes it.
- **Data layer** (`repositories/index.mjs`): the eight names in `TABLE_BACKED`; the snapshot dispatcher reads and
  replaces the eight tables (an omitted collection leaves its table alone, an explicit empty array empties it, a
  malformed collection or a strict refusal rolls the whole write back); at attach the stale in-memory arrays are
  dropped and the names defined as views; the schema report lists the eight tables and `0013`.
- **Rollback (copy-only)** `scripts/safetyAuditRollback.mjs` / `repositories/safetyAuditRollback.mjs`
  (`npm run rollback:safety-audit -- <data-dir> <fresh-empty-dir>`): every row of the eight tables written back into
  its legacy blob in `seq` order in the writer's literal (extras first, absence preserved, off-type values restored),
  the tables dropped, the 0013 record and its meta key removed, `saveSeq` advanced, foreign keys checked, VACUUM,
  revalidation (every other table byte-identical); refusals with no output: a later schema step (exit 4), a file
  that never applied 0013 (exit 5), a non-empty output directory (exit 1), a recorded 0013 whose tables are missing
  (exit 10); an injected failure before COMMIT removes the output. The S7d tool refuses a 0013 file (exit 4); the
  chain to any earlier build runs this tool first.
- **Documentation**: `sql/03_messaging_safety_audit.sql` carries the implemented DDL for the eight tables (the
  earlier draft's NOT NULL, CHECK vocabularies, RESTRICT references and derived actor kind are withdrawn there and
  recorded as OPEN for S4b / the foreign-key step); `scripts/testSchemaDdl.mjs` checks migration and document column
  for column; `OPERATIONS.md` has the cutover, rollback and operator procedure; `storeContract.mjs` names the eight
  as views; `scripts/safetyAuditPersistenceBench.mjs` is the benchmark.

### 11.2 Where it departs from §§2–7 and plan §D.4, and why

| Earlier statement | What was built | Why |
|---|---|---|
| §4.2 / Q5 option: `blocks` gains `lifted_at`/`lifted_by` | the lift deletes the row (`blocks.remove`) | Q5: keep today's removal behaviour |
| §4.1 / DDL draft: `REFERENCES players(id) ON DELETE RESTRICT` on five tables; `REFERENCES guardians(id)` on `idv_queue`; `REFERENCES orgs(id)` / `org_users(id)` | **no foreign key on any of the eight** | Q4 (tolerant player references), Q4b (strict guardian check in code, FK later), and — a shape-compatibility decision stated here, not a design goal — `POST /player/block` and `handleReport` accept an unchecked `orgId` / `targetOrgId` / `byOrgId` today, so an organisation or staff foreign key would turn accepted requests into refusals; those ids are historical pointers until a later step decides otherwise |
| DDL draft: `NOT NULL` literal columns, CHECK vocabularies (`by_kind`, `status`, `kind`, `type`, `severity`, `provider`, the 140-character excerpt) | every literal column nullable; no vocabulary CHECK; `absent_keys_json` / `offtype_json` / `extra_json` | the writers' literals are preserved exactly (absence as absence, off-type values as received — the review's "no hidden coercion/rejection" requirement); vocabularies live in code as for S7a–S7d |
| §2.5 / DDL draft: a derived `actor_kind` / `actor_id` pair | `user_id` and `actor_name` verbatim | §2.5's own recommendation, confirmed by the brief |
| §2.3: per-field `context_*` columns for `moderation_log` | `context_json` whole | no caller's context key can be lost or need a refusal |
| plan §D.4: `repositories/audit.mjs` | `repositories/safetyAudit.mjs` | the migration's name; no other difference |
| plan §D.4 benchmark wording | `scripts/safetyAuditPersistenceBench.mjs` reports blob rows and bytes upserted per save, the eight audit blobs' share, the remaining blob collections by name and the median save time — before and after, same fixture | as specified; no dirty tracking was added and none is claimed |
| §7's "rows → blobs" rollback | built exactly so (`safetyAuditRollback.mjs`) | — |

Unchanged and not decided here: retention of report reasons, note text and moderation excerpts (now rows, as the
blobs were); guardian deletion; the IDV toggle's first-entry rule (preserved, §2.8); the unbounded `ops_events`
growth (§2.6); child-status stamping (Q2 OPEN — no column reserved); the country code (Q1 OPEN).

### 11.3 Verification

Node v22.22.2, npm 10.9.7, SQLite 3.51.2 (the independent reviewer's runtime is Node v24.19.0 / SQLite 3.53.3;
not available here). Every run below is on the final tree after every edit, one attempt unless stated; the logs
are in the handoff package (`logs/`), the counts in `logs/gates-summary.txt`.

- **Failing-first on the unchanged `1792fc7` tree** (the two suites untracked, no source change): `testSafetyAudit.mjs`
  — the [compat] check passed (the legacy representation holds today) and each of the eight [cutover] checks failed
  for its stated reason (no 0013 record; no duplicate-id refusal; no table; no `repositories/safetyAudit.mjs`; the
  blobs loaded in the legacy shape; an identity-only replacement that removed a referenced guardian was NOT refused;
  no rollback module); `testSafetyAuditServer.mjs` — both [compat] tests passed (the real deletion round trip with the
  old-build boot skipped only where the rollback tool does not exist yet, stated in the log) and both [cutover] tests
  failed ("the boot recorded 0013" false; the legacy-shape test undefined at its first table read).
- **The two S6b suites on the final tree:** `testSafetyAudit.mjs` 9 checks passed; `testSafetyAuditServer.mjs` 4 tests
  passed with `SCOUTBOX_PRE_S6B_SERVER` = the actual `4f954ad` checkout (a REAL boot of the rollback copy: the same
  rows in its routes, a block and a report accepted there into its blobs, the copy re-upgraded by this build).
- **Benchmark** (`scripts/safetyAuditPersistenceBench.mjs`, the same file and fixture — 5 000 ledger rows plus 50
  blocks, 100 reports, 100 moderation hits, 250 notes, 50 ops events, 250 source changes, 20 IDV entries, 400
  requests, 60 threads × 25 messages, 500 notifications — 100 message+notification+ledger+save rounds; synthetic
  temporary database; one run each on a shared machine):

  | Tree | blob rows upserted per save | blob bytes serialised per save | of which the eight audit blobs | remaining blob collections | save time median / mean / p95 |
  |---|---|---|---|---|---|
  | `4f954ad` (pre-S6b) | 9 | 1 092 859 | 8 rows, 1 015 048 bytes | the eight audit names + `requests` | 10.03 / 11.53 / 18.12 ms |
  | this tree (S6b) | 1 | 77 811 | 0 rows, 0 bytes | `requests` | 2.01 / 3.83 / 6.23 ms |

  Claimed: the eight audit blobs leave every save's serialisation and UPSERT. Not claimed: that the whole-database
  write is gone — every remaining blob (`requests` in this fixture; every other blob collection on a real file) is
  still serialised and UPSERTed by every save; no dirty tracking exists or was added (plan §D.4).
- **Reviewer scripts, byte-identical to the `1792fc7` bundle, unchanged:** `review-62e9c1a-reproductions.mjs` exit 0
  in both modes (4 CORRECT, 0 reproductions with the `b67bce5` controls); `probe-nested-restore.mjs` exit 0 (0 stale
  values in 8 nested views); the six historical reviewer scripts and the two older design probes exit 0.
  `review-e7f7692-design-checks.mjs` and `review-6956f52-design-checks.mjs` — design-premise probes written against
  the PRE-S6b storage — pass unchanged on the `1792fc7` tree (exit 0) and STOP on the final tree (exit 1): the first
  after its three engine VERIFIED lines and the F1 finding, at its F2 check, which reads the `ledger` BLOB from
  `collections` (that blob no longer exists — the ledger is a table since 0013); the second at its setup, which
  creates its own synthetic `idv_queue` table (the real 0013 migration now creates it). The change between the two
  runs is the storage move the scripts were written to examine; the premises they probed are covered on the real
  routes and tables by the two S6b suites. Stated, not hidden; the scripts were not edited.
- **Focused suites:** `testUnitOfWork` 17, `testWriterAtomicity` 9, `testChannelsServer` 5 (the actual `b67bce5`
  build booting its rollback copy), `testCoreIdentityServer` 14 — all passed.
- **E2E (real server boots):** `apiE2E` 130 (against a freshly seeded server on port 4000 with a temporary
  `DATA_DIR`), `connectedE2E` 62, `m12E2E` 152, `m13E2E` 212, `m15E2E` 190, `m16E2E` 118, `m181E2E` all, `m23E2E` all,
  `m23RecruitmentJourneyE2E` 168, `m23SigningE2E` all, `m23P4AClosureE2E` 337, `preM24SweepE2E` 40 — all passed.
  `m23BootContract` and `m23Persistence` FAIL on this tree and on the unchanged `4f954ad` tree with the identical
  failure set (compared line for line): the `dispatches` store-contract claim versus the running server's module
  initialisation (since S7b) and the m23Persistence fixture's pre-S7d channel without a `requestId`, refused by the
  0012 import — pre-existing, not caused by S6b, not fixed here; recorded as a remaining limit.
- **Backend gate** `cd scoutbox-server && npm test` — 29 suites, 376 checks, exit 0, one attempt on the final tree,
  with the five `SCOUTBOX_PRE_*` variables pointing at the actual `812e13b`, `0641b2c`, `6ca66ba`, `b67bce5` and
  `4f954ad` checkouts (real old-build execution: 1 / 1 / 5 / 1 / 1 boot lines); the real older-Node runtime checks
  SIMULATED (`SCOUTBOX_TEST_NODE_BINS` unset). The interim full-chain runs during development are kept in the
  package (`logs/npm-test-interim*.log`): each failure was an older suite's expectation of the pre-S6b table set,
  migration list, rollback chain or revision count, adapted as the diff shows; no application source was changed to
  make a suite pass.
- **Player gate** `cd scoutbox-player && npm test -- --runInBand` — 4 suites, 41 tests, exit 0, one attempt (no
  Player source changed; the gate is mandatory).
- **Fresh extraction of the handoff ZIP:** `npm ci` in both projects, both gates (the five old-build boots SKIPPED
  there — the old builds are outside the package), the S6b server suite, the benchmark, the reviewer scripts and
  probes — the sidecar record beside the ZIP.
- **Not run:** browser suites, demo rebuild, the remaining E2E suites, real older-Node runtimes, real data, real
  providers.
