# S8b readiness review — recruitment cases, rooms and decisions as tables

**Status: PREPARATION ONLY — NOT IMPLEMENTED.** Written 22 October 2026 on `feat/sqlite-schema` at `7a7efc6`, the
commit at which S8a-core was independently accepted (`sqlite-migration-plan.md` §D.8.11). Nothing of S8b is
implemented, stubbed, registered or reserved: no migration module, no repository, no DDL change, no test. The next free
migration identifier is **`0016`** (the registry `scoutbox-server/repositories/migrations/` ends at
`0015_recruitment.mjs`; `DATA_MIGRATIONS` ends at `0015`) — **reported, not reserved**; it is assigned when S8b is
approved. The drafted DDL in `docs/architecture/sql/02_recruitment.sql` for these tables stays a draft and is amended at
implementation, as S8a's was. Everything marked *proposed* below is a proposal for independent review; S8a-core is
*accepted*; S8b is *not implemented*.

**Corrected on 22 October 2026 after the independent review of `57076a2`**, which accepted the S8a-core acceptance
record and did NOT accept this design for implementation: its F1 (the incoming case links must be released before the
S8a trial departures and the request prune) and F2 (explicitly removed room rows must be pruned before their case)
are corrected in §§5–6 and evidenced by probe 5 beside the reviewer's reproduction script; the strict-option wording
of Q8a in §9 is corrected (a refusal stops the migration; it authorises no deletion). **Corrected again on 23 October
2026 after the independent review of `86342b8`**, which verified F1, F2 and the Q8a wording and found one remaining
P2 mismatch (R1): §3 kept `case_history.case_id … RESTRICT` and called a case removal with history inconsistent,
while §6 F3 assumed every owned child cascades and probe 5 modelled no owned child. Resolved in §3, §6 P/F3 (the
owner/child inventory) and §8, evidenced by probe 6 beside the reviewer's reproduction script: a case's owned lists go
with their owner, as the unchanged `store.save` does today; the RESTRICT key is kept and the departing owner's
history (and the polymorphic key rows of its owned draft/handoff) are removed explicitly before the parent, inside
the same transaction; an omitted independent room collection still blocks. S8b stays PREPARED, NOT IMPLEMENTED,
**awaiting independent acceptance of the corrected design**; Q8a stays unanswered and is not asked here.

What this document is for: the survey the independent review of `7a7efc6` asked for ("establish the exact bounded
collection/table list from current writers and readers"), a concrete migration and write design with its probes, the
rollback, the test checklist, and the genuine open decision — so that the implementation milestone can start from a
reviewed brief, exactly as S8a-core did from plan §D.7.

Standing rules that bind this design: the Founder's recorded decisions Q7a/Q7b/Q7c apply to the S8a tables and are
**not extended** to the S8b tables (§9 asks the one question they do not cover); the S8a mapping as corrected at
`7a7efc6` is the required precedent (own prototype-named fields, absent / null / empty distinct, duplicate list entries,
nested unknown values — all kept); no public route, role, safeguarding or deletion/retention rule changes to make
storage simpler; nothing is dropped, fabricated, repaired or deduplicated by a migration; no player or guardian
database key before the identity rewrite plan (plan §D.2a, Q3) permits one.

---

## 1. The bounded scope — five blob collections, one aggregate and four room collections

The roadmap (plan "S8 — Recruitment", sub-step S8b) names "cases + rooms + decisions". Read against the current writers
and readers, that is exactly these five blobs, no more:

| Blob today | What it holds | Owner module | Writers (verified at `7a7efc6`) |
|---|---|---|---|
| `recruitmentCases` | the M12 case, with the M17 **room facet** (`case.room`, an object or `null`), its assignments, tasks, approvals, history, links, the M12 `decision`, the M23 `decisionDraft`, the M27 `transactionHandoff` and the M13 `budget` | m12 (`storeContract.mjs:157`, "the canonical recruitment object (M12); the lifecycle lives on it") | `m12/scouting.mjs:460` (create), `:484`, `:500`, `:548`, `:565`, `:570`, `:590`, `:606`, `:611`, `:617`; `m17/rooms.mjs:579` and `:936` (create or adopt + room facet `:581`/`:938`), `:101` (`applyStatus`, the ONE writer of `room.status`/`stage`/rev), `:646`, `:652`, `:816`–`:820` (reopen), `:1126` (tasks), `:1300` (assignments), `:1376`, `:1383` (links), `:870` (`ctx.applyLifecycleTransition`); `m23/trialRoutes.mjs:414`, `:843` (links) and `:224` (`advanceCase` → lifecycle); `m23/contactRoutes.mjs:217`; `m23/decisionRoutes.mjs:232`, `:255`–`:264`, `:280`, `:411` (`decisionDraft`); `m27/index.mjs:695`, `:697`, `:734`, `:805` (`transactionHandoff`, history); `m13/planning.mjs:246`–`:259`, `:280`–`:291`, `:300`, `:320` (`budget`); every `audit()` / `activity()` / `histAppend()` caller (`m12/shared.mjs:74`–`:77`, `m17/rooms.mjs:141`, `m13/shared.mjs:211`–`:214`); `server.mjs:4289`–`:4291` (subject removal) |
| `roomComments` | threaded, mentionable, editable, tombstoned comments of a room | m17 (`storeContract.mjs:185`) | `m17/rooms.mjs:1047` (create), `:1073`–`:1075` (edit), `:1088`–`:1089` (tombstone) |
| `roomSnapshots` | append-only evidence-confidence provenance captured at a status move or a decision | m17 (`:188`) | `m17/rooms.mjs:958`–`:985` (`captureSnapshot`; callers `:735`, `:816`, the decision routes through `ctx.captureRoomSnapshot`) |
| `roomDecisions` | the append-only decision chain of a room: M17 recommendations and M23 formal decisions | m17 (`:186`) | `m17/rooms.mjs:1173`–`:1185` (`recordDecision`), `m23/decisionRoutes.mjs:371`–`:392` (the formal row; `:392` a rollback `splice`) |
| `roomEvidenceState` | one review state per (room, evidence), overwritten in place | m17 (`:187`) | `m17/rooms.mjs:1272`–`:1276` |

All five are production-required stores guaranteed by the snapshot migration registry (`m182/migrations.mjs:102`
`m182_002_collections_present`; `m17/index.mjs:22`–`:26` `migrateM17` adds the four room stores and `case.room ??=
null`; `m12/shared.mjs:19`). `m182_003_rev_backfill` (`m182/migrations.mjs:112`) gives every room a `rev`.

**Why these five and not the rest of file 02.** Contacts (`recruitmentContacts`, `m23/contactRoutes.mjs`), offers,
signing packages, signings and follow-ups are S8c/S8d (plan S8 sub-steps); they reference a case by `caseId` (a plain
id, e.g. `m28/index.mjs:132`, `m29/index.mjs:102`) and keep doing so as blobs: a case the S8b table holds is still found
by id by every one of them, since `db.recruitmentCases` stays an array view of the same records. The M18 collections
(`recruitmentBriefs`, `secondLookItems`, `nobodyMissedReviews`), `recruitmentJourneys` (a derived cache read by
`m23/journey.mjs:53`), `outcomeReports` and `agentTransactions` are other stages. `requests` and `trials` are S8a-core
(live); S8b touches them only to convert their `case_id` columns into real keys (§4).

**Readers** (so that no field is dropped as "unused"): `m23/journey.mjs:11`–`:12`, `:130`, `:168`, `:248`, `:351`, `:537`
(the journey projection reads the case, its room, its history and the decision chain); `m23/journeyRoutes.mjs:35`,
`:86`, `:102` (player/guardian journeys read the case's room status through the projection — the player sees
lifecycle stages, never notes, comments, snapshots or decisions); `m20/dashboard.mjs:98`, `:105`, `m20/funnels.mjs:69`,
`:412` (the funnel reads `room_status_changed` / `room_reopened` history entries **whole**, `detail.to` included),
`m20/metrics.mjs:143`–`:259`; `m18/nobodyMissed.mjs:116`, `:120`, `m18/secondLook.mjs:179`–`:184` (the latest decision
and its snapshot by `decision.snapshot.snapshotId`), `:214`, `:383`, `:419`, `:446`, `:526`; `m27/index.mjs:559`
(decision heads), `:753`, `:788`, `:819` (`caseBelongsTo`); `m28/index.mjs:132`, `:237`, `:614`, `:645`, `:757`;
`m29/index.mjs:102`, `:384`; `m13/enterprise.mjs:337` (the audit export carries every case's `history` for the org),
`:421` (support tickets reference cases by id); `m13/groups.mjs:118`, `:138` (grants on a case id); `m13/planning.mjs:192`,
`:215`; `m23/trialRoutes.mjs:255`, `:819`, `:840`, `:859`, `:921`, `:983`; `m23/contactRoutes.mjs:644`; `m12/scouting.mjs:117`,
`:439`–`:441` (`caseView` returns the record whole, history included, `:436`), `:760`; `m23/lifecycle.mjs:172`, `:280`.

**Deletion and tombstones.** A player's removal (`server.mjs:4289`–`:4291`) nulls `playerName` and sets
`subjectRemovedAt` on every case of the player; it does not touch the four room collections (their `playerId` stays;
no name is stored there except `authorName`/`byName`, which are staff). Cases, comments, snapshots, decisions and
evidence states are **never deleted**; a comment is tombstoned (`deletedAt`, `deletedBy`; the body stays stored and is
nulled in views, `m17/rooms.mjs:193` `commentView`); a decision draft is HARD-deleted on discard and on finalize
(`decisionRoutes.mjs:280`, `:411` — its id survives on the formal row's `draftId`); a transaction handoff is
OVERWRITTEN by a re-invite (`m27/index.mjs:695`; file 02's note records this as a known defect kept as is).

**Backup / import / restore.** The admin backup is the whole `db.json` (every blob); after S8b the five collections are
exported through their repositories in the legacy shapes (as S8a exports `requests`/`trials`,
`m13/enterprise.mjs` backup); a restore imports the file's blobs through the S8b migration's validation, never from
memory or the seed (the S8a rule). The legacy JSON import refuses a null collection before any blob exists
(`store.mjs` `LEGACY_IMPORT_FAILED`, proven for S8a).

---

## 2. The aggregate, field by field (exact stored shapes from the writers' literals)

Conventions: *storage* follows the S8a engine (`repositories/recruitment.mjs`: every scalar a column of the writer's
nullability, no vocabulary or length `CHECK` — "a storage step changes no product rule" — every nested object columns
of the same row, every list a child table keyed `(owner…, position)` in list order with a non-object entry kept in
`raw_json`, every absent key in `absent_keys_json`, off-type value in `offtype_json`, unknown own field in `extra_json`,
acts set as own data properties). *Audience*: every row below is **tenant-private club workspace** (`orgRouter` only;
`restricted` cases readable by owner, assignees and leads, `m17/rooms.mjs:125`); the only personal fields are
`playerName` (nulled on subject removal) and the staff snapshots (`ownerName`, `byName`, `authorName`, …).

### 2.1 `recruitmentCases[]` — the case row (`recruitment_cases`)

| Field | Writer and shape | Readers | Proposed column | Notes |
|---|---|---|---|---|
| `id` | `nextId('case')`, `scouting.mjs:451`, `rooms.mjs:573`, `:930` | everywhere | `id TEXT NOT NULL UNIQUE` (+ `seq INTEGER PRIMARY KEY`, insertion order, as S8a) | |
| `orgId` | creation | every reader filters by it | `org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT` | orgs are never deleted (S3; plan "Org deletion policy O2" open, unchanged) |
| `playerId` | creation | every reader | `player_id TEXT NOT NULL`, **no key** (§9, Q8a) | live, retained (S4b-R) or historically missing |
| `playerName` | creation; `null` after subject removal (`server.mjs:4290`) | views | `player_name TEXT` | |
| `vacancyId` | `scouting.mjs:452` (`?? null`), `rooms.mjs:574`, `:931` | `scouting.mjs` | `vacancy_id TEXT` no key (vacancies are S9) | |
| `ownerUserId`, `ownerName` | creation (`req.orgUser`); reassigned `rooms.mjs:656`–`:660` | `caseAccess`, `roomRole` | `owner_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT`, `owner_name TEXT NOT NULL` | staff are never deleted (`removedAt`, `server.mjs:1921`); every producer sets both |
| `stage` | `scouting.mjs:453` (`stagesFor(org)[0]`), `:548`, `:574`, `:591`; `null` on a room until `applyStatus` derives it (`rooms.mjs:103`) | list filter `:440`, planning `:192`, adoption `:567`, `:926` | `stage TEXT` (nullable; no vocabulary CHECK) | derived from `room.status` whenever a room exists; stored because room-less M12 cases have no room |
| `priority` | `scouting.mjs:453` (`high\|medium\|low`, default `medium`), `rooms.mjs:575` | views | `priority TEXT NOT NULL` | distinct from `room.priority` |
| `deadline` | `scouting.mjs:454` raw client value `?? null` | views | `deadline_raw TEXT` / off-type kept | never parsed |
| `restricted` | `!!restricted` | `findRoom:125`, `caseAccess` | `restricted INTEGER NOT NULL` (0/1) | |
| `decision` | `null` at creation; `{outcome, reasons, byUserId, byName, at}` `:570`; `{…appr.decision, byUserId, byName, approvedBy, at}` `:590` | `caseView` | nested-object columns `decision_outcome`, `decision_reasons`, `decision_by_user_id`, `decision_by_name`, `decision_approved_by_name`, `decision_at`; the object's presence/null recorded (S8a `day` precedent) | `approvedBy` is a NAME (snapshot) |
| `links` | `{requestIds: [], trialIds: [], signingId: null}`; ids appended with an `includes()` guard (`scouting.mjs:606`, `:611`, `rooms.mjs:1376`, `:1383`, `trialRoutes.mjs:414`, `:843`); `signingId` set `:617`, `rooms.mjs:1387` | snapshots (`:978`), journey, `trialsFor` | `links.requestIds[]` → `case_request_links (case_id, position, request_id REFERENCES recruitment_requests(id) ON DELETE RESTRICT)`; `links.trialIds[]` → `case_trial_links (…, trial_id REFERENCES trials(id) ON DELETE RESTRICT)`; `links.signingId` → `signing_id TEXT` no key (signings are S8d); the container's presence recorded | position-keyed so a legacy duplicate entry is kept (the drafted `PRIMARY KEY (case_id, request_id)` would dedupe) |
| `createdAt` | creation | ordering `:441` | `created_at INTEGER NOT NULL` | |
| `history[]` | `audit()` / `activity()` / `histAppend()` → `{id: 'aud-n', at, byKind, byId, byName, action, detail}`; m27 writes `{id, at, action, by: {kind, userId, name}, detail}` (`m27/index.mjs:697`, `:734`, `:805`) — two literal shapes in one list | `caseView`, journey, M20 funnels (detail whole), the audit export | `case_history (case_id, position, id, at, by_kind, by_id, by_name, by_kind2…)` — both literals mapped key for key (`by.kind`/`by.userId`/`by.name` as nested-object columns beside `byKind`/`byId`/`byName`), `detail` as JSON (string or object, retained whole — M20 reads it whole) | append-only; `by_id` is a staff id for org actors, a player/guardian id for recipients; **no key** |
| `assignments[]` | `{id: 'asg-n', userId, name, task, dueAt, status: 'open', createdAt}` (`scouting.mjs:483`, `rooms.mjs:1298`) | `roomRole`, readiness | `case_assignments (case_id, position, id, user_id REFERENCES org_users RESTRICT, user_name, task, due_at (off-type kept: the M12 path stores the raw client value), status, created_at)` | `status` is written `'open'` and never changed |
| `tasks[]` | M12 `{id: 'tsk-n', title, dueAt, assigneeUserId, status: 'open', createdAt}` + `completedAt`, `completedBy` (a NAME, `:512`); M17 `{id, title, description, assigneeUserId, assigneeName, status, dueAt, linkedResourceType, linkedResourceId, createdBy: {userId, name}, createdAt, completedAt}` (`rooms.mjs:1117`–`:1125`); PATCH status/assignee | room list views, needs-attention | `case_tasks (case_id, position, …)` with the union of both literals, absent keys recorded per row | `linkedResourceId` polymorphic, no key |
| `approvals[]` | `{id: 'apr-n', decision: {outcome, reasons}, requestedBy: {userId, name}, status, requestedAt, resolvedBy: null \| {userId, name, at}}` (`scouting.mjs:564`, `:588`–`:589`) | the decision routes | `case_approvals (…)` nested objects as columns; `resolved_by_*` NULL with the null recorded | |
| `room` | `null` (M12 case) or the facet below | `isRoom`, everything M17/M23 | columns on the case row (`room_*`), the facet's presence/null recorded | |
| `room.status` | `applyStatus` only (`rooms.mjs:101`–`:111`; callers `:599`, `:735`, `:816`, `:870`) | lifecycle, M20, journey | `room_status TEXT` | the 18 `ROOM_STATUSES` (`m17/shared.mjs:39`); **no vocabulary CHECK** |
| `room.priority`, `room.tags[]`, `room.leadScoutUserId`, `room.sourceContext`, `room.sourceRef`, `room.openedBy {userId, name}`, `room.updatedAt`, `room.archivedAt`, `room.closedAt`, `room.rev`, `room.revAt`, `room.revBy {userId, name}\|null` | `:581`–`:591`, `:938`–`:944`; `tags` replaced wholesale `:646`; `leadScoutUserId` may be set `null` `:652`; `sourceRef` free-form (M18 callers); `bumpRev` (`m181/concurrency.mjs:84`–`:88`) | views, M20, M18 | `room_priority`, `room_lead_scout_user_id` (`REFERENCES org_users RESTRICT`, nullable), `room_source_context`, `room_source_ref_json` (retained JSON), `room_opened_by_user_id`/`_name`, `room_updated_at`, `room_archived_at`, `room_closed_at`, `room_rev`, `room_rev_at`, `room_rev_by_user_id`/`_name`; `room.tags[]` → `case_room_tags (case_id, position, raw_json)` (a list of strings: the engine's non-object entry) | `rev` starts at 0 and is bumped to 1 by `applyStatus` at creation (`:589`, `:599`) |
| `room.reopened` | `{by: {userId, name}, at, from, reasonCodes[], sourceContext, sourceRef}` (`rooms.mjs:818`–`:821`); absent until the first reopen | M20 funnels (`room_reopened` history) | `room_reopened_*` columns, `reason_codes` as a child list or retained JSON, `source_ref_json` retained | presence recorded |
| `decisionDraft` | `null` or `{id: 'rdraft-n', outcome, reasonCodes[], note, evidenceRefs[] {kind, id, meta}, by {userId, name, role}, createdAt, updatedAt, updatedBy, rev, revAt, keys: {create: {key, fp} \| null}}` (`decisionRoutes.mjs:232`–`:236`; PATCH `:255`–`:268`; HARD-deleted `:280`, `:411`) | the decision routes, `decision.mjs` | `case_decision_drafts` — an object child (one row or none, `case_id UNIQUE` — structural: the field is a single object); `reasonCodes[]` and `evidenceRefs[]` child lists in order; `keys.create` → `idempotency_keys` (owner `case_decision_drafts`) when it carries a string key, held on the row otherwise (the S8a rule) | |
| `transactionHandoff` | `{id: 'hof-n', caseId, orgId, playerId, status, invitedAt, invitedBy {kind, userId, name}, acceptedAt, withdrawnAt, transactionId, representedAtInvitation, invitedAgencyOrgId, invitedAgentUserId, keys: {invite: {key}} \| {}, rev, revAt}` (`m27/index.mjs:680`–`:694`; status writes `:734`, `:805`) | `GET /org/agent/handoffs` (`:753`) | `case_transaction_handoffs` — an object child (one row or none); `keys.invite {key}` (no `fp`) → `idempotency_keys` owner `case_transaction_handoffs` (a keyed value act); `{}` kept as an empty map | `invitedAgencyOrgId` → `orgs` no key? — it is an org id; **keep as a plain id** (an agency org may not exist in a legacy file; checked by the route) |
| `budget` | `null` (backfilled by `m13/shared.mjs:42`) or `{scenarios: [...]}`; a scenario `{id: 'scn-n', version, label, currency, termMonths, lines[], fxAssumptions[], approval: null \| {by, byUserId, at, version, superseded}, actuals[], createdBy (name), createdAt, updatedAt}` (`planning.mjs:248`–`:258`; PUT replaces `lines`/`fxAssumptions` `:280`–`:283`; approve `:300`; actuals `:320`) | `GET /cases/:id/budget` (finance-gated) | `case_budget_scenarios (case_id, position, …)` + `case_budget_lines`, `case_budget_fx_assumptions`, `case_budget_actuals` keyed `(case_id, scenario_position, position)`; `rate` kept as the decimal TEXT the route stores | `actuals[].lineId` has no key (a later PUT may renumber lines: known defect kept) |
| `subjectRemovedAt` | `server.mjs:4291` | journey | `subject_removed_at INTEGER` | |

### 2.2 `roomComments[]` → `room_comments` (+ `room_comment_mentions`)

`{id: 'rcmt-n', roomId, orgId, authorId, authorName, body, replyToId, mentions[] (staff ids, deduped, ≤ 20),
createdAt, editedAt, editCount, deletedAt}` (`rooms.mjs:1041`–`:1046`); edit sets `body`, `editedAt`, `editCount`
(`:1073`–`:1075`); tombstone sets `deletedAt`, `deletedBy {userId, name}` (`:1088`–`:1089`). Columns key for key;
`room_id REFERENCES recruitment_cases(id) ON DELETE RESTRICT` (never deleted); `org_id → orgs RESTRICT`;
`author_user_id → org_users RESTRICT`; `reply_to_id TEXT` **no key** (checked at write `:1035`; a legacy comment may
answer a tombstoned one); `mentions[]` → `room_comment_mentions (comment_id, position, user_id)` (a string list);
`deleted_by_*` columns. The body of a deleted comment stays stored (the view nulls it).

### 2.3 `roomSnapshots[]` → `room_snapshots` (+ source-reference lists)

`{id: 'rsnap-n', roomId, orgId, playerId, at, trigger, trust: null | {score, band, policyVersion, componentLevels
{component: level}, hash}, sourceRefs: {passportVersion, passportRevision, evidenceIds[], assessmentIds[],
combineResults[] ('<protocolId>@<version>'), trialIds[]}, note}` (`rooms.mjs:958`–`:985`; `buildRoomSnapshot`
`m17/shared.mjs:750`). Columns for the scalars; `trust` as nested-object columns with `trust_component_levels_json`
retained (a small map read whole); the four id lists as position-keyed child rows (`room_snapshot_source_refs (snapshot_id,
kind, position, ref_id)` keeps the draft's single table); `note` is a constant disclaimer string — **stored as written**
(the engine keeps every field; "derived, not stored" is a draft note that would drop a field). `room_id → recruitment_cases
RESTRICT`; `player_id` no key (§9).

### 2.4 `roomDecisions[]` → `room_decisions` (+ `room_decision_evidence_refs`)

Two literals in one list. M17 (`rooms.mjs:1175`–`:1183`): `{id: 'rdec-n', roomId, orgId, playerId, recommendation,
reasonCodes[], note, by {userId, name, role}, createdAt, trigger, clientKey, supersedes, supersededById, snapshot: null |
{at, trust, sourceRefs, snapshotId}}`. M23 formal (`decisionRoutes.mjs:371`–`:385`): the same plus `kind: 'formal'`,
`state: 'final'`, `outcome`, `finalizedAt`, `supersession`, `rev`, `revAt`, `evidenceRefs[] {kind, id, meta}`,
`assessmentSummary {submitted, withheld, verdicts{…}, assessmentIds[]}`, `keys: {finalize: {key, fp} | null, draft:
{key, fp} | null}`, `draftId`, `lifecycle: null | {action, from, to, applied, reason?, at}`, `policyVersion`. A new row
sets `supersededById` on the previous head (`:1184`, `:391`); `decisionRoutes.mjs:392` **splices the row back out** on a
transport failure (a caller conversion, §5). Storage: columns key for key, absent keys recorded (an M17 row has no
`kind`/`state`/`outcome`…); `reasonCodes[]`, `evidenceRefs[]`, `assessmentSummary.assessmentIds[]` as child lists;
`snapshot` as nested-object columns with `snapshot_trust_*`/`snapshot_source_refs_json` retained (an exact copy of the
snapshot row by design) and `snapshot_id TEXT` **no key** (the copy is the record); `supersedes_id`, `superseded_by_id`,
`supersession_of_id` as plain ids **checked in code** (a self-referential key would force a two-pass insert order and a
`RESTRICT` on rows that are never deleted — the chain is asserted at the end of every write instead, ids only);
`client_key` as a column with **no unique index** (the M17 replay lookup is by `(roomId, clientKey)` in memory;
uniqueness is a code rule; the dry run reports a duplicate); `keys.finalize`/`keys.draft` → `idempotency_keys` owner
`room_decisions` when they carry a string key (the S8a rule), held on the row otherwise.

### 2.5 `roomEvidenceState[]` → `room_evidence_states`

`{id: 'rev-n', roomId, orgId, evidenceId, state, note, byId, byName, at}` (`rooms.mjs:1273`), overwritten in place
(`:1276`). Columns key for key; `room_id → recruitment_cases RESTRICT`; `evidence_id` no key (evidence is S9); the
`(room, evidence)` uniqueness is a code rule (find-then-assign, `:1271`) — **no unique index** (a legacy duplicate would
make the cutover refuse; the dry run reports it; nothing deduplicates).

### 2.6 What stays as it is for later stages

`recruitmentContacts` (S8c), `recruitmentOffers`, `signingPackages`, `signings`, `followUps` (S8d), the M18 and M20
collections, `outcomeReports`, `agentTransactions`: blobs, unchanged, referencing cases by id. `vacancyId`,
`evidenceId`, `assessmentIds`, `transactionId`, `signingId`, `invitedAgencyOrgId`, `linkedResourceId`: plain ids with no
key until their tables exist. `recruitmentJourneys` is a derived cache and is not a migration subject.

---

## 3. Producers against the drafted constraints — what was found

Checked against every writer above and, where a route could reach it, against the real server (probe 4).

| Drafted (file 02) | Finding | Proposed |
|---|---|---|
| vocabulary and length `CHECK`s (`stage`, `priority`, `room_status`, `room_priority`, `room_source_context`, `decision_outcome`, `outcome`, `recommendation`, `state`, `kind`, `status`, `length(...)`) | the S8a rule: a storage step changes no product rule; the vocabularies live in `m17/shared.mjs` and move with the product (M23 added five statuses) | **none** of them; the engine keeps the value |
| `NOT NULL DEFAULT` columns (`priority`, `restricted`, `rev`, `edit_count`, `represented_at_invitation`, `reason_codes_json DEFAULT '[]'`, …) | every producer sets them; a legacy absent key must come back absent (the S8a presence rule) | `NOT NULL` only where every writer sets the key (`id`, `org_id`, `player_id`, `owner_user_id`, `owner_name`, `created_at`, `room_id`, `author_user_id`, `body`, …); no `DEFAULT` anywhere; absence recorded |
| `recruitment_cases_one_open_room` (partial unique on `(org_id, player_id)` over open statuses) | **violated by today's routes**: creation refuses a second open room (`ROOM_EXISTS`, `rooms.mjs:557`), but the status route moves an archived/withdrawn/closed room back to `under_review` (`ROOM_TRANSITIONS`, `m17/shared.mjs:246`–`:248`) without looking for another open room, and so does the Second Look reopen bridge (`ctx.reopenRoom`, `rooms.mjs:789`; caller `m18/secondLook.mjs:532`). Probe 4 does it through the real server: two open rooms for one (org, player); the index cannot be created over that file. Probe 2 shows the index also makes a valid final graph (remove the open case while its pair moves to a new open case) unwritable in any order | **withdrawn** (the D2 precedent); `ROOM_EXISTS` stays a code rule; nothing is deduplicated; a product-wide rule is a separate question not asked here |
| `case_tags PRIMARY KEY (case_id, tag)`, `case_request_links PRIMARY KEY (case_id, request_id)`, `case_trial_links`, `room_comment_mentions PRIMARY KEY (comment_id, user_id)`, `room_decision_evidence_refs PRIMARY KEY (decision_id, kind, ref_id)`, `room_snapshot_source_refs` | these dedupe; the lossless rule keeps duplicate list entries (a legacy file may hold one; the routes guard with `includes()` / `new Set` today) | position-keyed child tables `(owner, position)` in list order (the S8a convention) |
| `room_evidence_states UNIQUE (room_id, evidence_id)`, `room_decisions_room_client_key` unique | code rules today (`rooms.mjs:1271`; the M17 replay lookup) | **no unique index**; the dry run lists a duplicate; refused at the cutover only if a structural key fails |
| `room_decisions.supersedes_id / superseded_by_id / supersession_of_id REFERENCES room_decisions(id)` (self keys) | a forward reference (`supersededById` names a LATER row) needs a two-pass insert; rows are never deleted | plain ids, chain asserted at the end of every write (ids only) |
| `case_history.case_id … ON DELETE RESTRICT` (an OWNED child: `history[]` is a nested list of the case record) | no route deletes a case (the deletion unit tombstones it); a supplied snapshot, a restore or the import may remove a case, and today's `store.save` removes the case **with its nested history** (the reviewer's baseline against the unchanged build, `review-86342b8-case-history.mjs`); the earlier wording "removing a case still holding history is an inconsistency" contradicted that contract and §6 F3's "its children cascade" contradicted the kept key — corrected after the review of `86342b8` (R1) | **kept (RESTRICT)** as a guard: nothing but the owner-prune step F3 may delete a case row, and F3 removes the owner's history rows explicitly, inside the same transaction, BEFORE the parent (probe 6); the nested list goes with its owner, as it does today; it is never an independent "omitted collection" and never blocks |
| `room_snapshots.room_id RESTRICT`, `room_decisions.room_id RESTRICT` (and `room_comments`, `room_evidence_states`: RESTRICT by §2, INDEPENDENT collections) | a retained room row naming a case the supplied cases remove is a true reference | kept (RESTRICT); the preflight names the rows with their table and ids before the key would (§6 P); a SUPPLIED room collection that no longer lists the row removes it at F1, before the case (F2 of the review of `57076a2`) |
| `signing_id REFERENCES signings(id) ON DELETE SET NULL`, `decision_by_user_id`/`room_lead_scout_user_id … SET NULL` | signings are S8d; staff are never deleted; a `SET NULL` key would fire at an identity-style rewrite of `org_users` | `signing_id` no key; staff keys `RESTRICT` (the S8a precedent: `user_id → org_users RESTRICT`, with the staff prune after the case prune) |
| `player_id` columns on `recruitment_cases`, `room_snapshots`, `room_decisions`, `case_transaction_handoffs` | Q7a covers `recruitment_requests.player_id` and `trials.player_id` only | **no key**, tolerant and counted — subject to the Founder's answer to **Q8a** (§9); not inferred |
| `idempotency_keys.owner_table CHECK IN ('recruitment_requests', 'trials')` | S8b's replayable acts (`decisionDraft.keys.create`, `transactionHandoff.keys.invite`, `roomDecisions[].keys.finalize/draft`) need three more owners; a CHECK cannot be altered in place | the table is **rebuilt with the broadened CHECK, every S8a row copied as it is** (probe 3: rows, primary key, index byte-identical; the S8a readers unchanged); nothing else of the S8a definition changes |
| the drafted `room_snapshots.note` "derived, not stored", `snapshot {…} → snapshot_id only`, `trust.componentLevels` only | the engine keeps every field a writer wrote | stored as written (`note` a column; the decision's `snapshot` copy as nested columns + retained JSON) |

Incompatibilities a legacy file may carry and the cutover **refuses with positions and ids only** (the S8a rule; the
dry run on a copy lists them first; nothing is repaired): an entry that is not a record; a case without `id`, `orgId`,
`playerId`, `ownerUserId` or `createdAt`; a duplicate case id; a room component naming a `roomId` that is not a case;
a `request_id`/`trial_id` in `links` that is not in the tables; an `orgId` not in `orgs` or a staff id not in
`org_users` (`owner_user_id`, `author_user_id`, `by_user_id`, …); a `requests`/`trials` `case_id` not in the cases
(Q7b's check becomes the key at this cutover); the pair checks of S8a.

---

## 4. The migration — one step, one transaction (proposed; the number is `0016` when approved, not reserved)

Runs after `0015` with the runner's `foreignKeysOff` (it rebuilds tables other tables reference; `PRAGMA
foreign_key_check` must be empty before COMMIT — the runner's rule, `repositories/database.mjs:36`–`:56`):

1. **Preflight on the file's blobs** (never memory, never the seed): parse the five blobs (a genuinely absent blob
   imports nothing; a present `null`, object, string or number refuses — the F2 rule); validate every entry (ids,
   duplicates, every reference named above against the file's tables and blobs); count (live / retained / missing
   player ids, legacy shapes such as room-less cases, M12-only tasks, M17 recommendation rows without `kind`).
2. **Create the S8b tables** (generated from the writers' shapes, as `RECRUITMENT_DDL` is): `recruitment_cases`,
   `case_room_tags`, `case_assignments`, `case_tasks`, `case_approvals`, `case_history`, `case_request_links`,
   `case_trial_links`, `case_decision_drafts` (+ its `reason_codes`/`evidence_refs` lists), `case_transaction_handoffs`,
   `case_budget_scenarios`, `case_budget_lines`, `case_budget_fx_assumptions`, `case_budget_actuals`, `room_comments`,
   `room_comment_mentions`, `room_snapshots`, `room_snapshot_source_refs`, `room_decisions`,
   `room_decision_evidence_refs` (+ `reason_codes`, `assessment_ids` lists), `room_evidence_states`. The exact list
   and DDL are produced by the implementation's shapes and amended into file 02 then (the S8a practice;
   `scripts/testSchemaDdl.mjs` compares column for column).
3. **Import the cases** (rows and children, insertion order → `seq`), **without their link rows**.
4. **Rebuild `recruitment_requests` and `trials` with the real key** — `case_id TEXT REFERENCES recruitment_cases(id)
   ON DELETE RESTRICT` on both — by create-copy-drop-rename with `seq` copied and every index recreated (**probe 1**:
   every recruitment row, child row, idempotency row, thread, message and attachment byte-identical; the children's
   and `channels`' keys still name the rebuilt tables; `foreign_key_check` empty; a dangling case id names the table
   and rowid and rolls the whole step back; `NULL` passes). The accepted S8a write phases are unchanged: with cases
   written first, the key is satisfied by phase 1.
5. **Import the case links** (after step 4: `request_id`/`trial_id` keys), then the four room collections.
6. **Rebuild `idempotency_keys`** with the broadened `owner_table` CHECK, every S8a row copied as it is (**probe 3**);
   then write the S8b acts (string-keyed value acts and non-empty list acts as rows; everything else held on the owner
   row — the `7a7efc6` rule).
7. Retire the five blob rows; record counts only in `meta.recruitmentCasesCutover`; `foreign_key_check` empty; COMMIT.
   Any refusal aborts the whole step (`RECRUITMENT_CASES_IMPORT_BLOCKED` with the specific refusal, positions and ids);
   the runner rolls back; the next boot refuses the same way; the file is untouched.

Q7b's checks in `repositories/recruitment.mjs` (`RECRUITMENT_CASE_MISSING` against the `recruitmentCases` collection)
become checks against the final case TABLE (ids first, the key second — the S8a form for `org_id`/`user_id`).

---

## 5. Repository, views, save timing and the graph memento (proposed)

- **Views.** `db.recruitmentCases`, `db.roomComments`, `db.roomSnapshots`, `db.roomDecisions`, `db.roomEvidenceState`
  become read-only array views of the mutable records every module edits in place (the S8a `db.requests` contract):
  `push`/`splice`/assignment refused; the records, their nested objects and arrays are the live objects. Every
  in-place writer listed in §1 keeps working unchanged (`kase.room.status = …`, `history.push`, `tasks.push`,
  `kase.decisionDraft = …`, `prev.supersededById = …`, `Object.assign(row, …)`).
- **Write entry points** (the only callers that change): `db.recruitmentCases.push(c)` → `cases.addCase(c)`
  (`scouting.mjs:460`, `rooms.mjs:579`, `:936`); `db.roomComments.push` → `rooms.addComment` (`:1047`);
  `db.roomSnapshots.push` → `rooms.addSnapshot` (`:985`); `db.roomDecisions.push` → `rooms.addDecision` (`:1185`,
  `decisionRoutes.mjs:390`) and the transport-failure rollback `db.roomDecisions.splice(…)` (`:392`) → `rooms.removeDecision(row)`
  (a record added and removed inside one request before any save lands nothing — the staged repository's pending set);
  `db.roomEvidenceState.push` → `rooms.addEvidenceState` (`:1274`); the backup export (`m13/enterprise.mjs`) through
  `exportCases()` etc.; the subject-removal loop (`server.mjs:4289`) stays an in-place edit of the view's records.
- **Save timing.** Unchanged: the routes' `persistNow()` and debounced `persist()` land the dirty records in the same
  save as today; dirty detection by the per-record committed fingerprint (the S8a mechanism; the same cost caveat as
  §D.8.7 — no save-time gain is claimed for S8b either).
- **Participants (corrected after the review of `57076a2`, F1).** The cases repository cannot be one save-hook object:
  the release of incoming link rows (§6 R) must run BEFORE the S8a flush and their reinsert (§6 C) AFTER it, and the
  case prune (§6 F3) AFTER the room prunes — while `recruitment.flush` (`recruitment.mjs:703`–`:719`) runs its phases
  1–3 AND its request prune inside one call (`:713`–`:714`). Registering hooks "in order" therefore provides no
  end-of-save prune phase of its own, and the earlier four-participant list was wrong. Proposed: the cases repository
  registers THREE hook objects around the existing ones, in this order — `cases-core` (A the case rows and non-link
  children; R the release) → `recruitment` (S8a, unchanged: B, and F2 inside its own flush) → `cases-links` (C the
  reinsert; `trialRoutes.mjs:414` creates a request and its link in one save, so the link lands after the request) →
  `rooms` (D the four room collections; F1 their prunes) → `cases-prune` (F3) → `channels` (S7d, unchanged). The
  release needs the S8a departure set (`recruitment.mjs:517`: a trial not in the mirror, or whose `requestId` differs
  from the stored `request_id`) and the pruned-request set (a committed request no longer in the mirror): the
  recruitment repository exposes both through a read-only accessor (`departures()`, computed from its mirrors and the
  table by the same criterion as its flush) — **a future addition to `recruitment.mjs` at implementation, not made
  now**; the alternative, splitting `recruitment.flush` into a write call and a prune call, changes accepted S8a code
  and is not preferred. In staged mode the mirrors ARE the final graph (no collection is omitted), so the preflight of
  §6 P reads them. **Probe 5** proves the order over the real `RECRUITMENT_SNAPSHOT.replace`/`prune`; probe 2's
  "links after requests" control stands.
- **Graph memento.** The unit-of-work memento covers the five collections' records by identity, every nested object
  (`room`, `decisionDraft`, `transactionHandoff`, `budget`, `decision`, `links`) and array (`history`, `tasks`, …), so
  an aborted unit restores a held `kase.room` or `kase.decisionDraft` to its pre-unit value (the S8a `trial.schedule`
  precedent). The two failure contracts stay distinct: a failed ORDINARY save keeps every pending edit in memory and
  lands it once on the next save; an aborted UNIT restores the pre-unit graph in place. Side effects (notifications,
  broadcasts, the ledger) stay at their current durability boundary.

---

## 6. The snapshot write — one algorithm for the import, a restore, a flush and a snapshot (proposed; CORRECTED after the review of `57076a2` — F1, F2; probe 5)

The draft order of `57076a2` (A cases → B the S8a phases → C links → D rooms → prunes of requests, then cases, then
room rows) was wrong. The independent review reproduced four VALID final graphs it refused on a key, each with exact
rollback (`review-57076a2-write-order.mjs`, four reproductions, four controls): **F1a** removing a linked trial while
clearing its link (B deletes the trial while the `case_trial_links` row still names it — `trial_id … RESTRICT`);
**F1b** moving a linked trial to a replacement request (the S8a phases delete and reinsert a trial whose `request_id`
changes, `recruitment.mjs:517`–`:521`, under the same link row); **F1c** removing a linked request together with its
case (the S8a request prune precedes the case deletion that would cascade the `case_request_links` row); **F2**
removing a case together with its comment (`room_comments.room_id … RESTRICT`; the draft pruned cases before room
rows). Probe 2's eight checks moved cases by `caseId` only and never exercised a trial departure or a request prune
against a link row; they stand for what they cover (§11), not for the whole graph. The corrected order, every step
inside the one transaction:

P. **Preflight against the FINAL combined graph** — every supplied collection as supplied, every omitted one as the
   retained table rows — ids only, before any write: (1) every link of every final case names a request/trial of the
   final collections (`CASE_LINK_DANGLING`: a retained case whose trial the supplied trials remove is refused, never
   silently detached — the S8a rule for threads, `CHANNEL_REQUEST_MISSING`); (2) a case the write removes is named by
   no RETAINED row of an omitted INDEPENDENT collection (`CASE_STILL_REFERENCED`, naming the table —
   `recruitment_requests`, `trials`, `room_comments`, `room_snapshots`, `room_decisions`, `room_evidence_states`). The
   case's OWNED children (its `history[]`, `tags`, `assignments`, `tasks`, `approvals`, `links`, `decisionDraft`,
   `transactionHandoff`, `budget` — the nested lists and objects of the record itself) are never blockers: they belong
   to the owner and go with it, as today's `store.save` removes a case with its nested history (corrected after the
   review of `86342b8`, R1; probe 6 check 4: the refusal names the four retained room tables and not the owned rows);
   (3) every final request/trial `caseId` and every final room row's `roomId` names a final case (`CASE_MISSING`);
   (4) the S8a validations, unchanged.
A. **Cases, parent-preserving**: every supplied (or changed) case upserted by id (`seq` kept), its non-link children
   rewritten in list order; no open-room release phase (the one-open index is withdrawn, §3).
R. **Release, transaction-local**: the incoming link rows B or F2 would hit are deleted now — every link row of the
   cases this write supplies (rewritten at C) or prunes (gone at F3), and, MEMORISED verbatim (case, position, target,
   the mapping metadata of the row), the rows of RETAINED cases whose trial is in the S8a departure set (removed, or
   its `request_id` changing) or whose request is pruned (none can exist after P: it would dangle). Nothing is dropped
   or detached: a released row of a retained case comes back at C unchanged; a supplied case's rows come back from its
   final list. The release is a storage step, not a product change — after the save the link lists are what the
   writers left them.
B. **The accepted S8a phases 1–3** for `requests`/`trials` (unchanged; the key to `recruitment_cases` is satisfied
   because A ran first; Q7b's case check reads the final case table).
C. **Links reinserted**: the supplied cases' final lists in list order (duplicates kept, metadata kept; the
   `request_id`/`trial_id` keys are satisfied because B ran first — probe 2's control); the memorised rows of the
   retained cases verbatim.
D. **The supplied room collections**: upsert by id, children in list order; the decision chain written in list order
   with `supersedes_id`/`superseded_by_id` as plain ids.
E. **Channels** (S7d, unchanged).
F. **Prunes against the final graph, dependents before their parents**: **F1** the rows a SUPPLIED room collection no
   longer lists — decisions (and their evidence refs), evidence states, snapshots (and their source refs), comments
   (and their mentions) — BEFORE their case; an OMITTED room collection is retained, and a retained row that names a
   pruned case legitimately blocks F3 — named at P with its table, not discovered on the key; **F2** the S8a request
   prune (phase 5, its own thread/trial pre-checks; the links to a pruned request were released at R, so the
   `case_request_links` key no longer fires there); **F3** the cases no longer listed — **for each departing owner,
   inside the same transaction and BEFORE its parent row: its RESTRICT-owned children removed explicitly (`case_history`
   rows) and the polymorphic `idempotency_keys` rows of its owned draft and handoff (`owner_table` `case_decision_drafts`
   / `case_transaction_handoffs` / `recruitment_cases`; no key of their own — the S8a precedent, `recruitment.mjs:518`),
   then the parent row, whose CASCADE-owned children follow it** (corrected after the review of `86342b8`, R1: the
   earlier "their own children cascade" contradicted the kept `case_history` key and refused a valid final graph in
   both input orders — the reviewer's reproduction; probe 6). The same routine rewrites a SUPPLIED case's owned
   children at A. Every retained INDEPENDENT reference was named at P — the key is the last guard, not the message;
   **F4** the staff and organisation prunes (after every reference to them, the S8a order).

   The owner/child inventory behind F3 (the drafted file 02 definitions, §2's amendments; engineering verification,
   not scope):

   | Owned by `recruitment_cases` | Drafted constraint | At A (rewrite of a supplied case) and F3 (departure) |
   |---|---|---|
   | `case_history` | `ON DELETE RESTRICT` (kept) | rows deleted explicitly before the parent; reinserted from the supplied list at A |
   | `case_tags` (`case_room_tags` in §4), `case_assignments`, `case_tasks`, `case_approvals` | `CASCADE` (their staff references `RESTRICT` → the staff prune is F4) | cascade with the parent at F3; rewritten in list order at A |
   | `case_request_links`, `case_trial_links` | `CASCADE` | released at R, reinserted at C; nothing left to cascade at F3 |
   | `case_decision_drafts` (+ its `reason_codes` / `evidence_refs` lists, cascading from the draft), `case_transaction_handoffs` | `CASCADE`, `UNIQUE (case_id)` | cascade with the parent; **their `idempotency_keys` rows deleted explicitly first** (polymorphic owner, no key) |
   | `case_budget_scenarios` → `case_budget_lines`, `case_budget_fx_assumptions`, `case_budget_actuals` | `CASCADE` from the case, then from the scenario | cascade with the parent |
   | **Not owned** — independent rows naming a case: `recruitment_requests.case_id`, `trials.case_id` (S8a tables, the real key after §4 step 4), `room_comments`, `room_snapshots`, `room_decisions`, `room_evidence_states` (`RESTRICT`, §2) | `RESTRICT` | a retained row blocks the removal, named at P with its table; a supplied collection removes its rows at F1/F2 first |
   | Later-stage tables naming a case in the draft (`recruitment_contacts`, `recruitment_offers`, `signing_packages`, `signings`: `RESTRICT`) | not created by S8b | blobs until S8c/S8d; plain ids, checked in code as today |
G. **Final assertions**, ids only: the S8a pair checks; every `case_id` of a request/trial in the final cases (the key
   makes this redundant, kept for the message); every link target in the tables; the decision chain
   (`DECISION_CHAIN_BROKEN`: every `supersedes`/`supersededById` names a final row of the same room; at most one head
   per room is REPORTED, not enforced — `duplicateFinalHeads` is corruption the code names today); `foreign_key_check`
   empty.

Partial saves and the two failure contracts: an omitted collection is retained and its rows are part of the final
graph P checks against; a partial save equals the full save with the retained collections resent (probe 5 check 6:
cases and the room collections omitted while a retained case's trial is deleted and reinserted — its link rows,
positions, duplicate and metadata byte-identical; probe 5 check 9 and probe 2 check 2: a cases-only save rewrites only
the case tables); the result does not depend on the input order (probe 5: every landing case in both orders; probe 2
check 1); a retained request or trial is never silently deleted or detached by rewriting a case (probe 2 check 3) and
a retained case is never silently detached by rewriting the trials (probe 5 check 7). A refusal at P, or a failure
after R or after B, rolls back to every row and the revision with no transaction open (probe 5 checks 7 and 8). The
ordinary failed save keeps its pending intent in memory; an aborted unit restores the graph through the memento (§5)
— both unchanged. **How the order applies:** a snapshot restore and the import supply every collection (nothing is
retained: R releases every link row and C rewrites them all); a staged ordinary or unit save supplies each
repository's changed records through the hook sequence of §5, with the mirrors as the final graph; a direct
`replace`/`prune` call (the backup restore, the migration) runs the same steps in one function.

What the corrected order does NOT do: disable foreign keys during a save; drop the two `RESTRICT` link keys; rely on
the input being sorted; change a route, a role, safeguarding or retention. Refusing a reference that would dangle in
the final graph is the S8a storage rule, not a retention decision; the retention of comments, snapshots, decisions and
cases stays as the product has it (§10).

---

## 7. Copy-only rollback to the accepted pre-S8b build (`7a7efc6`) — proposed

`scripts/recruitmentCasesRollback.mjs` on a COPY (`VACUUM INTO`; the source opened read-only; the C1 boundary test
reused): refuses a later schema (`LATER_SCHEMA`, exit 4), a file that never applied the S8b step (`NOT_CUT_OVER`, 5), a
recorded step whose tables are missing (`UNEXPECTED_SCHEMA`, 10), a non-empty output (1); writes the five collections
back into their blobs in insertion order in the writers' literals (children nested in list order, keys reassembled,
every absent/null/off-type/unknown field as recorded — **every post-cutover edit preserved**); rebuilds
`recruitment_requests` and `trials` to the S8a definitions (no case key; probe 1 in reverse: rows byte-identical);
rebuilds `idempotency_keys` to the S8a CHECK with the S8b owner rows removed (they are inside the blobs); drops the S8b
tables; removes the record and its meta key; keeps every earlier migration record and every S8a row; advances
`saveSeq`; `foreign_key_check`; VACUUM; revalidates. The chain: the S8a tool (`recruitmentRollback.mjs`) refuses a
file carrying the S8b step and accepts this tool's output. **The old build on a new file**: by analogy with the
measured S8a behaviour (`9b109dc` on a `0015` file exits 1 at boot, `STORE_MISSING requests, trials`), the `7a7efc6`
build's boot-contract check would find the five collections absent and exit 1 before listening — **a prediction to be
MEASURED at implementation on the actual build, not a guarantee**; the rollback tool is the only way back either way.

---

## 8. Implementation checklist (ordered; each item with its acceptance criterion)

1. Checkouts: `7a7efc6` as `SCOUTBOX_PRE_S8B_SERVER` beside the seven existing builds; never over the working branch.
2. Tests first, failing on the unchanged tree: a unit suite (`scripts/testRecruitmentCases.mjs`: the migration and
   counts; the lossless mapping of every literal in §2 including both history literals, both decision literals, a
   room-less M12 case, an M12-only task, a tombstoned comment, a handoff with `keys: {}`, own prototype-named fields,
   duplicate link entries, absent/null/empty acts; the import refusals with ids; the repository in staged mode with
   every in-place writer of §1 landing in the next save; the two failure contracts; the write order of §6 with
   probe 5's and probe 2's cases as suite cases — F1a/F1b/F1c, F2 for each of the four room collections and all
   together, the retained refusals with their tables, the release-and-reinsert of a retained case's links while its
   trial is deleted and reinserted with the cases omitted, both input orders, partial saves equal to full saves, the
   injected failures after R and after B; probe 6's cases — a case removed with its non-empty history, tags, draft
   and the draft's key row together with its room rows, both orders; a retained case's history preserved with the
   cases omitted; a surviving case's history untouched by another's removal and by its own rewrite; the retained
   independent refusals naming the room tables and not the owned rows; the injected failure after the owned
   children were removed and before the parent, with the retry landing once; the staged hook sequence of §5 over the
   real store; the rollback and the chain) and
   a server suite (`scripts/testRecruitmentCasesServer.mjs`: the real routes — room creation/adoption, status moves,
   reopen, comments, tasks, decisions (recommendation and formal with replay/conflict), evidence review, budget,
   handoff; backup/restore; SIGKILL; the `7a7efc6` build booted on the rollback copy; the direct boot of the old build
   on a new file MEASURED). Acceptance: both fail on `7a7efc6` on concrete assertions; both green after.
3. `repositories/recruitmentCases.mjs` (shapes, DDL, mapping, validation, phases A/C/D/F/G, repository, export) and
   `repositories/migrations/0016_*.mjs` (steps 1–7 of §4); `recruitment.mjs` adapted (the case check reads the table;
   `CONSTRAINTS` gains the two keys; the rebuild helper; the read-only `departures()` accessor of §5 — its flush
   unchanged); `index.mjs` (registration, `TABLE_BACKED`, read/write order, the SIX `attachDataLayer` hook objects of
   §5 in their order, `/capabilities`); the caller conversions of §5; `m13/enterprise.mjs` exports.
   Acceptance: `scripts/testSchemaDdl.mjs` compares the S8b tables; probes 1–3 and 5 pass against the real modules.
4. File 02 amended to the implemented definitions (the drafted case/room sections replaced, the superseded notes
   kept as history); `sqlite-schema.md`, `OPERATIONS.md` (cutover, dry run, rollback, the DANGER line), `CLAUDE.md`.
5. Gates: the backend chain (Node 22 and 24) with EIGHT historical builds booted for real; the Player suite; the
   batteries that touch the changed code — `m12E2E`, `m17E2E`, `m17Perf`, `m23E2E`, `m23TrialE2E`, `m23DecisionE2E`,
   `m23DecisionPersistence`, `m23RecruitmentJourneyE2E`/`Hardening`/`Persistence`, `m23ContactE2E`,
   `m23AgentTransactionE2E` (handoffs), `m23OfferE2E`, `m23SigningE2E`, `m23TemporalIntegrityE2E`, `m23P4AClosureE2E`,
   `connectedE2E`, `apiE2E` — each on the final tree and on `7a7efc6`; the bench of §D.8.7 extended with a cases fixture
   (no save-time gain claimed unless measured); the reviewer scripts of S8a unchanged.
6. One commit, push, draft PR #2, handoff ZIP with fresh-extraction gates; stop for independent acceptance.

---

## 9. Decisions — what is the Founder's and what is engineering

**Q8a (the Founder's; genuinely new; the preparation is complete without the answer, the implementation of the
`player_id` columns waits for it).** May the S8b tables (`recruitment_cases.player_id`, `room_snapshots.player_id`,
`room_decisions.player_id`, `case_transaction_handoffs.player_id`) ship like the S8a ones under Q7a — **no player
foreign key; a live id resolves, a retained id (S4b-R) resolves to the retained record, a historically missing id is
preserved and counted, never refused, fabricated or deleted** — or must a case naming a missing player be refused at
the cutover (strict)? *Affected data:* every case, snapshot and decision of a player deleted before S4b-R or imported
before S4a; the deletion unit keeps cases as tombstones today (`playerName` null, `subjectRemovedAt`), so a strict rule
would refuse exactly the files that behaved correctly. *Alternatives:* tolerant-and-counted (the Q7a form) · strict
(refuse at the cutover: the migration STOPS with the ids for resolution and nothing is changed — a refusal authorises
no deletion of retained records; what resolution would mean is a retention question the product has not taken and
this preparation does not take) · a key (not available before plan §D.2a / Q3). *Recommendation:* tolerant and counted, for the Q7a reasons. *Depends on it:*
the `player_id` validation branch of the import and the write, `/capabilities` counts; nothing else.

**Engineering choices recorded here, not put to the Founder** (ordinary design within the accepted S8a pattern, each
with its evidence): the vocabulary/length CHECKs dropped (S8a precedent); the one-open-room index withdrawn (probe 2
and probe 4; the route rule stays); position-keyed children instead of deduplicating primary keys; staff keys
`RESTRICT` and no `SET NULL` key anywhere; the decision chain's self-references and `client_key` checked in code; the
shared `idempotency_keys` rebuilt with the broadened CHECK (probe 3) rather than a second table; `snapshot`, `note` and
the retained JSON fields stored as written. None reopens Q7a/Q7b/Q7c; none changes a route, a role, safeguarding or
deletion/retention behaviour.

---

## 10. Limitations and what remains open

- The slower boot, the larger file and the absence of a save-time gain (§D.8.7) are expected to grow with S8b's
  tables; the whole-snapshot-write objective stays unmet until every blob has moved (S8c, S8d and beyond).
- The old build's behaviour on a new file is predicted, not measured (§7).
- The probes are design models over the real tables and the real S8a module; they are not the implementation's
  tests (§8.2) and they do not model the S8a mapping engine's treatment of the case fields (that engine is the
  precedent; its behaviour on S8a shapes is accepted). **Coverage limits:** probe 2's eight write-order checks cover
  `caseId` moves, a cases-only save, a referenced-case refusal, links-after-requests and the one-open index; they do
  not cover a trial departure or a request prune against a link row, where the review of `57076a2` found the draft
  order wrong (F1, F2) — corrected in §6 and covered by probe 5 (nine checks) and the reviewer's script. Probe 5
  models the link tables and the four room tables with their `RESTRICT` references and plain-id decision chain, and
  **no owned child of the case** — so its owner-removal checks could not establish F3 against the kept
  `case_history` key (the review of `86342b8`, R1). Probe 6 adds the exact drafted `case_history` definition
  (RESTRICT), one CASCADE child (`case_tags`, standing for every CASCADE-owned child of the inventory in §6) and
  `case_decision_drafts` with its row of the real `idempotency_keys` table (rebuilt with the broadened CHECK), and
  proves the corrected F3; the remaining owned children (`assignments`, `tasks`, `approvals`, `transactionHandoff`,
  the budget tables) are bounded by that inventory — every one is `CASCADE` from the case or from a cascading child —
  and are not modelled. Neither probe models the owned children of the room rows, the mentions/refs lists or the
  staff/org prunes (F4). Model evidence is not a substitute for the implementation's suites (§8.2).
- Evidence preserved from the independent review of `57076a2` (its run, Node v24.19.0 / SQLite 3.53.3, application
  source byte-identical to `7a7efc6`): the full backend `npm test` stopped at `testOutboxPushServer`'s 12-second
  push-durability deadline (`elapsedMs` 128341; `pushRowsBefore` 2, `pushRowsNow` 3, `saveSeq` 5 → 7, no pending
  writes or effects — the row had reached storage); the cause of the elapsed time is not established; one targeted
  rerun of that suite and the four previously unrun suites exited 0 (28 checks), so all 33 suites / 404 checks
  completed across the original run and the recovery, which is NOT an uninterrupted exit-0 run. Recorded as it is: not
  a new S8b regression (nothing of S8b runs in that build), not an explained infrastructure fault, not erased by any
  later green run; kept separate from the two intermittent S6b failures ("not reproduced; cause unresolved"). This
  session's own full runs on `57076a2` and on the corrected tree are in the handoff logs with their actual results.
- Evidence preserved from the independent review of `86342b8` (its run, Node v24.19.0 / SQLite 3.53.3, application
  source still byte-identical to `7a7efc6`): the full backend `npm test` exited 0 on its first attempt (33 suites /
  404 checks) and the Player gate exited 0 (4 suites / 41 tests); the supplied live-room probe's first attempt exited
  1 at its 30-second boot timeout before any assertion (cause unestablished), and one unchanged rerun after the
  backend gate exited 0 (5 checks). Recorded as it is beside the earlier timing failure: neither erased by a later
  green run, neither explained, both separate from the two intermittent S6b failures.
- Org deletion policy (plan O2) stays open and unchanged; retention of tombstoned comments and of cases stays as the
  product has it; the `transactionHandoff` re-invite overwrite and the budget `actuals[].lineId` dangling reference are
  known defects kept as they are (a storage step changes no product rule).

## 11. Evidence in the handoff

| Probe (`node <probe> <project-root>`) | Checks | What it proves |
|---|---|---|
| `probe-s8b-rebuild-case-key.mjs` | 8 | the create-copy-drop-rename of both parents with the real case key on a real `0015` file: rows, children, idempotency rows, threads byte-identical; indexes recreated; the only key change is the new one; `foreign_key_check` empty; a dangling case id refuses with table and rowid and rolls back exactly; `RESTRICT` holds; the tombstoned and legacy pairs travel unchanged |
| `probe-s8b-write-order.mjs` | 8 | the DRAFT order of `57076a2` against the real S8a phases: both input orders equal; cases-only equals full; a referenced case cannot be removed (ids only, exact rollback); a pair moves between cases by `caseId`; links after requests (and the failing control); the one-open index needs a release phase and still cannot order a valid graph — withdrawn. **Does not cover** a trial departure or a request prune against a link row (§10); kept unchanged as the record of what it proved |
| `review-57076a2-write-order.mjs` (the reviewer's, unchanged; `node <script> <project-root> <probe-dir>`) | 4 reproductions + 4 controls, **exit 1 intended** | over probe 2's model and the real S8a writer: F1a, F1b, F1c and F2 refuse under the draft order with exact rollback; the controls that release the incoming link rows first (or prune the room row first) land the same final graphs. A design-model baseline, not a deployed defect and not a post-correction acceptance test — it still exits 1 on this tree because the draft order it models is the control of §6 |
| `probe-s8b-write-order-corrected.mjs` | 9 | the CORRECTED order of §6 (P A R B C D F1 F2 F3 G) against the real S8a phases, with the draft order kept as the failing control: F1a, F1b (positions, the duplicate and the metadata of the links intact, the back-reference set), F1c, F2 for each of the four room collections (the three omitted ones refuse with their tables) and all four together; a retained case's links released and reinserted byte-identical while its trial is deleted and reinserted with the cases and rooms omitted; partial equals full; every landing case in both input orders; true retained references refuse with ids only (a retained case naming a removed trial, a removed case named by retained requests/trials/room rows — every table named, an unknown case, a broken decision chain); an injected failure after R and after B restores every row and the revision with no transaction open; probe 2's earlier graphs still land |
| `review-86342b8-case-history.mjs` (the reviewer's, unchanged; `node <script> <project-root> <probe-dir>`) | 1 baseline + 2 reproductions + 2 controls, **exit 1 intended** | the unchanged build's `store.save` removes an unreferenced case with its nested history (the contract to preserve); probe 5's model extended with the exact drafted `case_history` table refuses the same removal under the `86342b8` F3 in both input orders with full rollback; a transaction-local control that removes the departing owner's history before its parent commits the same final graph — an ordering witness, not a patch. It still exits 1 on this tree because the F3 it models is the control of §6 |
| `probe-s8b-write-order-owned-children.mjs` | 6 | the corrected F3 over probe 5's model extended with the exact drafted `case_history` (RESTRICT), `case_tags` (CASCADE) and `case_decision_drafts` (CASCADE) whose `keys.create` is a row of the real `idempotency_keys` table (rebuilt with the broadened CHECK): an owner removed with four history rows, two tags, its draft and key, and its comment, snapshot, decision and evidence state — the `86342b8` F3 fails on the kept key with exact rollback, the corrected F3 lands the identical graph in both input orders with the surviving case's owned rows untouched; cases omitted while a trial is deleted and reinserted — every retained case's history, tags, draft and key byte-identical, the links released and reinserted, partial equals full; a resupplied case keeps its history content and gains an entry in list order, another case's history untouched; the retained INDEPENDENT refusals name the four room tables (not the owned rows), the retained request/trial, the dangling link — before any write; a failure injected after the owned children were removed and before the parent (and after R, and after B) restores every row, key and the revision with no open transaction, the retry lands the intended graph once and a repeat is a no-op; F1a/F1b/F1c still land with history present |
| `probe-s8b-idempotency-rebuild.mjs` | 4 | the broadened `owner_table` CHECK by rebuild: the S8a definition refuses a new owner; the rebuild keeps rows, key and index; a failure before COMMIT leaves the S8a definition; the S8a readers unchanged |
| `probe-s8b-one-open-room-live.mjs` | 5 | the real server: `ROOM_EXISTS` at creation, an archived room returned to `under_review` beside an open room — the drafted index cannot be created over the file this build writes |

Probes 1–4 run on 22 October 2026 on the `7a7efc6` tree and on `57076a2`; the reviewer's write-order script and
probe 5 on the `57076a2` tree; the reviewer's case-history script and probe 6 on the `86342b8` tree on 23 October
2026 (application source byte-identical to `7a7efc6` throughout) — Node 22 and Node 24; logs in the handoff. The
probes and the reviewer's scripts live outside the repository (the handoff ZIP), not in `scoutbox-server/scripts`.
