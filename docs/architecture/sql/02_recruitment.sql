-- 02_recruitment.sql — ScoutBox target SQLite schema: the recruitment pipeline.
--
-- Scope: requests, trials (schedule / attendance / day / report), recruitment
-- cases with their Room facet, room comments / snapshots / decisions / evidence
-- state, contacts, offers, signing packages, completed signings, post-signing
-- follow-ups, and the ONE shared idempotency_keys table.
--
-- Executes after 01_identity.sql (orgs, org_users, guardians, players,
-- player_media). Tables that live in LATER files are referenced by comment only,
-- never by FOREIGN KEY:
--   03: channels, ledger           04: evidence, assessments, vacancies
--   05: ver_evidence               06: agent_transactions, representation_agreements
--   07: box_sessions
--
-- Cross-cutting decisions
-- * player_id columns in this file carry NO foreign key. server.mjs
--   deletePlayerData (3978-4023) hard-deletes the players row and leaves every
--   row below behind as a tombstone (subject_removed_at / nulled name) that must
--   KEEP the id. A FK with SET NULL would erase the id the tombstone is for.
-- * org_id -> orgs(id) ON DELETE RESTRICT: no org deletion route exists.
-- * org user ids -> org_users(id) ON DELETE RESTRICT: removed staff keep their
--   row (removedAt) so attribution survives.
-- * Actor tuples {kind, userId|id, name} become <x>_kind / <x>_id / <x>_name.
-- * Optimistic-concurrency tuples rev / revAt / revBy{userId,name}|null
--   (m181/concurrency.mjs:84 bumpRev) become rev / rev_at / rev_by_user_id /
--   rev_by_name. A missing rev reads as 1 today; the migration writes 1.
-- * history[] arrays become <table>_history in the convention shape. Two
--   writer shapes exist and both map onto by_kind/by_id/by_name:
--     m12/shared.mjs:70 audit():   {id aud-*, at, byKind, byId, byName, action, detail}
--     m23/m27/m28/m29 record()/hist(): {id aud-*, at, action, by:{kind,userId|id,name}, detail}
-- * Every `keys` object / list / map becomes rows in idempotency_keys (below).
-- * Closed-vocabulary code arrays (reasonCodes <= 6 from the M17 taxonomy) stay
--   as *_json: only ever read whole (Second Look `some(code in REVISITABLE)`),
--   never queried per code. Deferred normalisation: a (owner_id, code) table.

-- =============================================================================
-- idempotency_keys
-- =============================================================================
-- source: every `keys` object/list/map on db.recruitmentContacts, db.trials,
--         db.requests, db.roomDecisions, recruitmentCases[].decisionDraft,
--         recruitmentCases[].transactionHandoff, db.recruitmentOffers,
--         db.signingPackages (created at each owner's writer, see mapping)
-- owner/writer: m23 contactRoutes/trialRoutes/decisionRoutes, m27/index.mjs,
--         m28/index.mjs, m29/index.mjs   lifecycle: append-only; trials cap each
--         act list at 50 and shift the oldest (trialRoutes.mjs:101) — a retention
--         rule the migration keeps as data, not as a constraint
-- mapping (source shape -> (owner_table, owner_id, act, key, fp, at, ref_id, actor_id)):
--   recruitmentContacts.keys.create {key,fp}   (contactRoutes.mjs:332) -> ('recruitment_contacts', id, 'create', key, fp, NULL, NULL, NULL)
--   recruitmentContacts.keys.send   {key|null,fp} (contactRoutes.mjs:453) -> (..., 'send', key, fp, NULL, NULL, NULL); a NULL key is never replayable and is not stored
--   recruitmentContacts.keys.record {key,fp}   (contactRoutes.mjs:608) -> (..., 'record', ...)
--   requests.keys.invite {key,fp}              (trialRoutes.mjs:412)   -> ('recruitment_requests', id, 'invite', key, fp, NULL, NULL, NULL)
--   trials.keys.accept {key:null, fp}          (server.mjs:2196)       -> NOT migrated: key is always null -- dead field; fp = {requestId, day} is derivable
--   trials.keys.schedule|cancel|attendance|complete|link [{key,fp,at}] (trialRoutes.mjs:100) -> ('trials', id, act, key, fp, at, NULL, NULL)
--   roomDecisions.keys.finalize {key,fp}       (decisionRoutes.mjs:381) -> ('room_decisions', id, 'finalize', key, fp, NULL, NULL, NULL)
--   roomDecisions.keys.draft {key,fp} (copy of the finalized draft's create key) -> ('room_decisions', id, 'draft', key, fp, NULL, draft_id, NULL)
--   decisionDraft.keys.create {key,fp}         (decisionRoutes.mjs:235) -> ('case_decision_drafts', id, 'create', key, fp, NULL, NULL, NULL)
--   transactionHandoff.keys.invite {key}       (m27/index.mjs:692)     -> ('case_transaction_handoffs', id, 'invite', key, NULL, NULL, NULL, NULL)
--   recruitmentOffers.keys.create {key,fp}     (m28/index.mjs:338)     -> ('recruitment_offers', id, 'create', key, fp, NULL, NULL, NULL)
--   recruitmentOffers.keys.issue|withdraw|revise [{key,revisionId}] (m28/index.mjs:474/523/580) -> (..., act, key, NULL, NULL, revisionId, NULL)
--   signingPackages.keys.start {key,fp}        (m29/index.mjs:407)     -> ('signing_packages', id, 'start', key, fp, NULL, NULL, NULL)
--   signingPackages.keys.ready|supersede [{key,fp,revisionId,at}]      -> (..., act, key, fp, at, revisionId, NULL)
--   signingPackages.keys.party [{key,fp,actorId,revisionId,at}] (m29/index.mjs:541) -> (..., 'party', key, fp, at, revisionId, actorId)
--   signingPackages.keys.cancel|void [{key,fp,at}]                     -> (..., act, key, fp, at, NULL, NULL)
--   signingPackages.keys.complete [{key,fp,signingId,at}]              -> (..., 'complete', key, fp, at, signingId, NULL)
-- notes: replay rule is "same (owner, act, key) with the same fp -> replay, a
--   different fp -> conflict", except offers compare ref_id (revisionId) instead
--   of fp, and signing 'party' also compares actor_id and demands ref_id = the
--   package's CURRENT revision. Key SEARCH scope is wider than the owner row for
--   contact create/send/record (all contacts of the case, contactRoutes.mjs:302/417/588),
--   offer create (all offers of the case), signing start (all packages of the
--   offer) and decision draft/finalize (all rows of the case): readers join
--   through the owner table. `at` is NULL where the source shape carries none.
--   actor_id is an extra column beyond the agreed seven, needed only by 'party'.
CREATE TABLE idempotency_keys (
  owner_table TEXT NOT NULL CHECK (owner_table IN ('recruitment_contacts','recruitment_requests','trials','room_decisions','case_decision_drafts','case_transaction_handoffs','recruitment_offers','signing_packages')),
  owner_id TEXT NOT NULL,
  act TEXT NOT NULL CHECK (act IN ('create','send','record','invite','schedule','cancel','attendance','complete','link','finalize','draft','issue','withdraw','revise','start','ready','party','void','supersede')),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 80),
  fp TEXT,
  at INTEGER,
  ref_id TEXT,
  actor_id TEXT,
  PRIMARY KEY (owner_table, owner_id, act, key)
) STRICT;
CREATE INDEX idempotency_keys_owner ON idempotency_keys(owner_table, owner_id);

-- =============================================================================
-- recruitment_cases  (M12 case + M17 Room facet + M23 additions)
-- =============================================================================
-- source: db.recruitmentCases  created at m12/scouting.mjs:450 (plain case),
--         m17/rooms.mjs:571 and :928 (case created with a Room facet);
--         `room` facet attached at m17/rooms.mjs:581 / :938
-- owner/writer: m12/scouting.mjs (stage, decision, approvals, links), m17/rooms.mjs
--         (applyStatus is the ONE writer of room.status / stage / rev), m23
--         lifecycle via ctx.applyLifecycleTransition, m13/planning.mjs (budget),
--         m23/decisionRoutes.mjs (decisionDraft), m27/index.mjs (transactionHandoff)
--         lifecycle: room.status in 18 ROOM_STATUSES (m17/shared.mjs:39), terminal =
--         signed|withdrawn|archived|closed, reopenable; never deleted; subject
--         removal nulls player_name and sets subject_removed_at (server.mjs:3994)
-- mapping:
--   id -> id (case-<n>)               orgId -> org_id              playerId -> player_id
--   playerName -> player_name (snapshot; NULL after subject removal)
--   vacancyId -> vacancy_id (vacancies(id), file 04, no FK)
--   ownerUserId -> owner_user_id      ownerName -> owner_name (snapshot)
--   stage -> stage (PRO_STAGES ∪ GRASSROOTS_STAGES; NULL between room creation and applyStatus;
--            DERIVED from room_status by stageForRoomStatus whenever room_status is set — stored
--            because plain M12 cases have no room and the derivation needs orgs.level)
--   priority -> priority (M12 case priority high|medium|low; distinct from room_priority)
--   deadline -> deadline_raw (unvalidated client value, scouting.mjs:454 / rooms.mjs:669; never parsed)
--   restricted -> restricted
--   assignments[] -> case_assignments        tasks[] -> case_tasks        approvals[] -> case_approvals
--   decision {outcome, reasons, byUserId, byName, approvedBy?, at} -> decision_outcome, decision_reasons,
--            decision_by_user_id, decision_by_name, decision_approved_by_name, decision_at
--   links.requestIds[] -> case_request_links   links.trialIds[] -> case_trial_links   links.signingId -> signing_id
--   createdAt -> created_at            history[] -> case_history
--   budget.scenarios[] -> case_budget_scenarios (+ lines, fx assumptions, actuals)
--   decisionDraft -> case_decision_drafts (one row or none)
--   transactionHandoff -> case_transaction_handoffs (one row or none)
--   subjectRemovedAt -> subject_removed_at
--   room.status -> room_status         room.priority -> room_priority    room.tags[] -> case_tags
--   room.leadScoutUserId -> room_lead_scout_user_id (PATCH may set NULL, rooms.mjs:652)
--   room.sourceContext -> room_source_context
--   room.sourceRef -> room_source_ref_json (free-form by design: supplied by M18 Nobody Missed /
--            Second Look callers of ctx.createRoomForPlayer / ctx.reopenRoom; shape not fixed here)
--   room.openedBy {userId,name} -> room_opened_by_user_id, room_opened_by_name
--   room.updatedAt -> room_updated_at  room.archivedAt -> room_archived_at  room.closedAt -> room_closed_at
--   room.rev/revAt/revBy -> room_rev, room_rev_at, room_rev_by_user_id, room_rev_by_name
--   room.reopened {by{userId,name}, at, from, reasonCodes[], sourceContext?, sourceRef?} ->
--            room_reopened_by_user_id, room_reopened_by_name, room_reopened_at, room_reopened_from,
--            room_reopened_reason_codes_json, room_reopened_source_context, room_reopened_source_ref_json
-- notes: one OPEN room per (org, player) is enforced by code (ROOM_EXISTS,
--   rooms.mjs:557) and audited by integrity code ROOM_OPEN_DUPLICATE — the partial
--   unique index below is NEW and must be checked against existing data first.
--   Room-less cases: room_status IS NULL and every room_* column is NULL.
--   Privacy: tenant-private club workspace; player_name is the only personal
--   field and goes on subject removal. `restricted` gates reads to owner,
--   assignees and leads.
CREATE TABLE recruitment_cases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  player_name TEXT,                                  -- snapshot
  vacancy_id TEXT,
  owner_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  owner_name TEXT NOT NULL,                          -- snapshot
  stage TEXT CHECK (stage IN ('identified','review','observation','trial','decision','closed','invited','awaiting_response')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  deadline_raw TEXT,
  restricted INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0,1)),
  decision_outcome TEXT CHECK (decision_outcome IN ('sign','pass','monitor')),
  decision_reasons TEXT,
  decision_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  decision_by_name TEXT,                             -- snapshot
  decision_approved_by_name TEXT,                    -- snapshot
  decision_at INTEGER,
  signing_id TEXT REFERENCES signings(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  subject_removed_at INTEGER,
  room_status TEXT CHECK (room_status IN ('watching','under_review','contact_planned','contacted','shortlisted','priority','trial_requested','trial_scheduled','trial_completed','offer_consideration','offer_made','offer_accepted','offer_declined','signed','on_hold','withdrawn','archived','closed')),
  room_priority TEXT CHECK (room_priority IN ('low','normal','high','urgent')),
  room_lead_scout_user_id TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  room_source_context TEXT CHECK (room_source_context IN ('search','watchlist','shortlist','opportunity','recommendation','campaign','passport','nobody_missed','second_look','matching','dynamic_watchlist','direct')),
  room_source_ref_json TEXT CHECK (room_source_ref_json IS NULL OR json_valid(room_source_ref_json)),
  room_opened_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  room_opened_by_name TEXT,                          -- snapshot
  room_updated_at INTEGER,
  room_archived_at INTEGER,
  room_closed_at INTEGER,
  room_rev INTEGER,
  room_rev_at INTEGER,
  room_rev_by_user_id TEXT,
  room_rev_by_name TEXT,                             -- snapshot
  room_reopened_by_user_id TEXT,
  room_reopened_by_name TEXT,                        -- snapshot
  room_reopened_at INTEGER,
  room_reopened_from TEXT CHECK (room_reopened_from IS NULL OR room_reopened_from IN ('withdrawn','archived','closed')),
  room_reopened_reason_codes_json TEXT CHECK (room_reopened_reason_codes_json IS NULL OR json_valid(room_reopened_reason_codes_json)),
  room_reopened_source_context TEXT,
  room_reopened_source_ref_json TEXT CHECK (room_reopened_source_ref_json IS NULL OR json_valid(room_reopened_source_ref_json)),
  CHECK ((room_status IS NULL) = (room_rev IS NULL))
) STRICT;
CREATE INDEX recruitment_cases_org_created ON recruitment_cases(org_id, created_at);
CREATE INDEX recruitment_cases_org_player ON recruitment_cases(org_id, player_id);
CREATE INDEX recruitment_cases_org_room_status_updated ON recruitment_cases(org_id, room_status, room_updated_at);
CREATE INDEX recruitment_cases_org_stage ON recruitment_cases(org_id, stage);
CREATE INDEX recruitment_cases_player ON recruitment_cases(player_id);
CREATE UNIQUE INDEX recruitment_cases_one_open_room ON recruitment_cases(org_id, player_id)
  WHERE room_status IS NOT NULL AND room_status NOT IN ('signed','withdrawn','archived','closed');

-- source: db.recruitmentCases[].room.tags[]  written at m17/rooms.mjs:646 (whole list replaced)
-- owner/writer: m17/rooms.mjs PATCH /rooms/:id   lifecycle: replaced wholesale, <= 20 per room
-- mapping: tag -> tag (<= 40 chars, validateTag refuses protected-trait words)
-- notes: read by list filter `?tag=` and the `q` search (rooms.mjs:471/480).
CREATE TABLE case_tags (
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 40),
  PRIMARY KEY (case_id, tag)
) STRICT;
CREATE INDEX case_tags_tag ON case_tags(tag);

-- source: db.recruitmentCases[].assignments[]  created at m12/scouting.mjs:483 and m17/rooms.mjs:1298
-- owner/writer: m12/scouting.mjs POST /cases/:id/assign, m17/rooms.mjs POST /rooms/:id/assessment-assignments
--         lifecycle: status is written 'open' and NEVER changed by any route
-- mapping: id -> id (asg-<n>)   userId -> user_id   name -> user_name (snapshot)   task -> task (<= 200)
--   dueAt -> due_date | due_at (M17 path stores a YYYY-MM-DD day or integer ms via parseDateOrInstant;
--            the M12 path stores the raw client value unvalidated — the migration parses it with the
--            same helper and logs anything unparseable as a defect)
--   status -> status   createdAt -> created_at
-- notes: read by caseAccess/roomRole (assignee list) and readiness (`/assess/i.test(task)`).
CREATE TABLE case_assignments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  user_name TEXT NOT NULL,                           -- snapshot
  task TEXT NOT NULL,
  due_date TEXT CHECK (due_date IS NULL OR length(due_date) = 10),
  due_at INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open')),
  created_at INTEGER NOT NULL,
  CHECK (due_date IS NULL OR due_at IS NULL)
) STRICT;
CREATE INDEX case_assignments_case ON case_assignments(case_id);
CREATE INDEX case_assignments_user ON case_assignments(user_id);

-- source: db.recruitmentCases[].tasks[]  created at m12/scouting.mjs:498 (legacy shape) and m17/rooms.mjs:1117 (Room shape)
-- owner/writer: m12/scouting.mjs (create, complete), m17/rooms.mjs (create, PATCH status/assignee)
--         lifecycle: TASK_STATES open|in_progress|done|cancelled with TASK_TRANSITIONS; <= 200 per room
-- mapping: id -> id (tsk-<n>)   title -> title (<= 160 Room, <= 200 legacy)   description -> description (<= 1000, Room only)
--   assigneeUserId -> assignee_user_id   assigneeName -> assignee_name (snapshot; absent on legacy rows)
--   status -> status   dueAt -> due_date | due_at (same rule as case_assignments)
--   linkedResourceType -> linked_resource_type   linkedResourceId -> linked_resource_id (polymorphic, no FK:
--            evidence(04) | assessments(04) | combine_requests | trials | box_assignments | evidence_suggestions | room_comments)
--   createdBy {userId,name} -> created_by_user_id, created_by_name (absent on legacy rows)
--   createdAt -> created_at   completedAt -> completed_at
--   completedBy (legacy M12 complete route writes the user's NAME, scouting.mjs:512) -> completed_by_name
-- notes: read by the room list `view=assigned` / `?assignee=` and needs-attention (overdue = due < now).
CREATE TABLE case_tasks (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR length(description) <= 1000),
  assignee_user_id TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  assignee_name TEXT,                                -- snapshot
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  due_date TEXT CHECK (due_date IS NULL OR length(due_date) = 10),
  due_at INTEGER,
  linked_resource_kind TEXT CHECK (linked_resource_kind IS NULL OR linked_resource_kind IN ('evidence','assessment','combine_request','trial','box_cam_assignment','evidence_request','comment')),
  linked_resource_id TEXT,
  created_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name TEXT,                              -- snapshot
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  completed_by_name TEXT,                            -- snapshot
  CHECK (due_date IS NULL OR due_at IS NULL)
) STRICT;
CREATE INDEX case_tasks_case_status ON case_tasks(case_id, status);
CREATE INDEX case_tasks_assignee_status ON case_tasks(assignee_user_id, status);

-- source: db.recruitmentCases[].approvals[]  created at m12/scouting.mjs:564
-- owner/writer: m12/scouting.mjs POST /cases/:id/decision (request), POST /cases/:id/approvals/:aid (resolve)
--         lifecycle: pending -> approved | rejected
-- mapping: id -> id (apr-<n>)   decision.outcome -> outcome   decision.reasons -> reasons (<= 500)
--   requestedBy {userId,name} -> requested_by_user_id, requested_by_name   status -> status   requestedAt -> requested_at
--   resolvedBy {userId,name,at}|null -> resolved_by_user_id, resolved_by_name, resolved_at
-- notes: decision.outcome is always 'sign' today (only a non-lead 'sign' needs approval) but the enum is kept whole.
CREATE TABLE case_approvals (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('sign','pass','monitor')),
  reasons TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  requested_by_name TEXT NOT NULL,                   -- snapshot
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_at INTEGER NOT NULL,
  resolved_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  resolved_by_name TEXT,                             -- snapshot
  resolved_at INTEGER
) STRICT;
CREATE INDEX case_approvals_case_status ON case_approvals(case_id, status);

-- source: db.recruitmentCases[].history[]  written by m12/shared.mjs:70 audit() (m12, m17, m23 trial/decision/offer/signing
--         hooks) and directly by m27/index.mjs:697/734/805 (shape {by:{kind,userId,name}})
-- owner/writer: every module that touches a case   lifecycle: append-only, never pruned
-- mapping: id -> id (aud-<n>)   at -> at   byKind | by.kind -> by_kind   byId | by.userId -> by_id   byName | by.name -> by_name
--   action -> action (ROOM_EVENT_TYPES, lifecycle `room_status_changed`, M12 verbs, m23/m27/m28/m29 verbs)
--   detail -> detail_json (M12 writes STRINGS here — the stage word, "name: task", JSON text of links —
--            and every later writer writes an object; both are valid JSON values. Retained JSON by design:
--            `room_status_changed` detail carries {from,to,reasonCodes,trigger,lifecycleAction,clientKey,policyVersion,<fk ids>}
--            which M20's funnel reads whole; normalising it is the lifecycle-event table step)
-- notes: ordering is at then numeric id part (roomActivity). by_id is a user id for org actors,
--   a player/guardian id for recipient actors, a reviewer id for 'admin'.
CREATE TABLE case_history (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  at INTEGER NOT NULL,
  by_kind TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','org_user','player','guardian','admin','system')),
  by_id TEXT,
  by_name TEXT,                                      -- snapshot
  action TEXT NOT NULL,
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;
CREATE INDEX case_history_case_at ON case_history(case_id, at);
CREATE INDEX case_history_action_at ON case_history(action, at);

-- source: db.recruitmentCases[].links.requestIds[]  written at m12/scouting.mjs:606, m17/rooms.mjs:1383, m23/trialRoutes.mjs:414
-- owner/writer: as above   lifecycle: append-only set (includes() guard)
-- mapping: requestId -> request_id
-- notes: the request must belong to the same org and player (checked at write).
CREATE TABLE case_request_links (
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES recruitment_requests(id) ON DELETE RESTRICT,
  PRIMARY KEY (case_id, request_id)
) STRICT;
CREATE INDEX case_request_links_request ON case_request_links(request_id);

-- source: db.recruitmentCases[].links.trialIds[]  written at m12/scouting.mjs:611, m17/rooms.mjs:1376, m23/trialRoutes.mjs:843
-- owner/writer: as above   lifecycle: append-only set
-- mapping: trialId -> trial_id
-- notes: read by roomSnapshots.sourceRefs.trialIds and trialsFor(linked flag).
CREATE TABLE case_trial_links (
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE RESTRICT,
  PRIMARY KEY (case_id, trial_id)
) STRICT;
CREATE INDEX case_trial_links_trial ON case_trial_links(trial_id);

-- source: db.recruitmentCases[].decisionDraft  created at m23/decisionRoutes.mjs:232
-- owner/writer: m23/decisionRoutes.mjs (create, PATCH, DELETE, cleared on finalize)
--         lifecycle: at most one per case; HARD-deleted on discard and on finalize (its id survives on room_decisions.draft_id)
-- mapping: id -> id (rdraft-<n>)   outcome -> outcome   reasonCodes[] -> reason_codes_json   note -> note (<= 2000)
--   evidenceRefs[] {kind,id,meta} -> evidence_refs_json (retained JSON: a transient copy that is discarded and
--            RE-RESOLVED against the case at finalize, decisionRoutes.mjs:325; the durable form is room_decision_evidence_refs)
--   by {userId,name,role} -> by_user_id, by_name, by_role   createdAt -> created_at   updatedAt -> updated_at
--   updatedBy {userId,name,role} -> updated_by_user_id, updated_by_name, updated_by_role   rev -> rev   revAt -> rev_at
--   keys.create -> idempotency_keys
-- notes: UNIQUE(case_id) — one draft per case, enforced by code (DECISION_INVALID_STATE).
CREATE TABLE case_decision_drafts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL UNIQUE REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('progress','hold','reject')),
  reason_codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reason_codes_json)),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  evidence_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_refs_json)),
  by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  by_name TEXT,                                      -- snapshot
  by_role TEXT,                                      -- snapshot
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  updated_by_name TEXT,                              -- snapshot
  updated_by_role TEXT,                              -- snapshot
  rev INTEGER NOT NULL DEFAULT 1,
  rev_at INTEGER
) STRICT;

-- source: db.recruitmentCases[].transactionHandoff  created at m27/index.mjs:680
-- owner/writer: m27/index.mjs (invite, withdraw, bindHandoff accept)
--         lifecycle: invited -> accepted | withdrawn; 'expired' is DERIVED (invitedAt + 30 d, effectiveHandoffStatus)
--         and never stored; a withdrawn/expired one may be re-invited, which OVERWRITES the object
-- mapping: id -> id (hof-<n>)   caseId -> case_id   orgId -> org_id   playerId -> player_id   status -> status
--   invitedAt -> invited_at   invitedBy {kind:'org',userId,name} -> invited_by_user_id, invited_by_name
--   acceptedAt -> accepted_at   withdrawnAt -> withdrawn_at
--   transactionId -> transaction_id (agent_transactions(id), file 06, no FK)
--   representedAtInvitation -> represented_at_invitation
--   invitedAgencyOrgId -> invited_agency_org_id   invitedAgentUserId -> invited_agent_user_id
--   keys.invite {key} -> idempotency_keys   rev -> rev   revAt -> rev_at
-- notes: UNIQUE(case_id) mirrors today's one-object-per-case; a re-invite today DROPS the previous
--   handoff record (only case_history keeps it) — known defect, kept as-is for a faithful migration.
--   Read by GET /org/agent/handoffs: scan on (invited_agent_user_id, status).
CREATE TABLE case_transaction_handoffs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL UNIQUE REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('invited','accepted','withdrawn')),
  invited_at INTEGER NOT NULL,
  invited_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  invited_by_name TEXT,                              -- snapshot
  accepted_at INTEGER,
  withdrawn_at INTEGER,
  transaction_id TEXT,
  represented_at_invitation INTEGER NOT NULL DEFAULT 0 CHECK (represented_at_invitation IN (0,1)),
  invited_agency_org_id TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
  invited_agent_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  rev INTEGER NOT NULL DEFAULT 1,
  rev_at INTEGER
) STRICT;
CREATE INDEX case_transaction_handoffs_agent_status ON case_transaction_handoffs(invited_agent_user_id, status);

-- source: db.recruitmentCases[].budget.scenarios[]  created at m13/planning.mjs:248
-- owner/writer: m13/planning.mjs (create, PUT, approve, actuals)   lifecycle: <= 8 per case; never deleted;
--         version bumps on every PUT; approval is version-specific and reads `superseded` after a later edit
-- mapping: id -> id (scn-<n>)   version -> version   label -> label (<= 80)   currency -> currency   termMonths -> term_months (1-72)
--   lines[] -> case_budget_lines   fxAssumptions[] -> case_budget_fx_assumptions   actuals[] -> case_budget_actuals
--   approval {by (name), byUserId, at, version, superseded} -> approved_by_name, approved_by_user_id, approved_at,
--            approved_version, approval_superseded (all NULL when approval is null)
--   createdBy (name) -> created_by_name   createdAt -> created_at   updatedAt -> updated_at
-- notes: totals (computeScenarioTotals) are derived, not stored. Finance-role gated (canViewFinance).
CREATE TABLE case_budget_scenarios (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  label TEXT NOT NULL CHECK (length(label) <= 80),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  term_months INTEGER NOT NULL CHECK (term_months BETWEEN 1 AND 72),
  approved_by_name TEXT,                             -- snapshot
  approved_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  approved_at INTEGER,
  approved_version INTEGER,
  approval_superseded INTEGER CHECK (approval_superseded IS NULL OR approval_superseded IN (0,1)),
  created_by_name TEXT NOT NULL,                     -- snapshot
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((approved_at IS NULL) = (approved_version IS NULL))
) STRICT;
CREATE INDEX case_budget_scenarios_case ON case_budget_scenarios(case_id);

-- source: db.recruitmentCases[].budget.scenarios[].lines[]  written at m13/planning.mjs:252 (create) and :280 (PUT replaces the whole list)
-- owner/writer: m13/planning.mjs   lifecycle: replaced wholesale on PUT; <= 30 per scenario
-- mapping: id -> line_id (`ln-<i>` minted per scenario, OR a client-supplied id kept on PUT — scoped to the scenario, not global)
--   kind -> kind   label -> label (<= 80)   amountMinor -> amount_minor   currency -> currency   schedule -> schedule
--   confirmed -> confirmed   conditional {assumption}|null -> conditional_assumption (<= 200; NULL = unconditional)
-- notes: ordinal `seq` keeps the client's order (occurrence math is order-independent).
CREATE TABLE case_budget_lines (
  scenario_id TEXT NOT NULL REFERENCES case_budget_scenarios(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wage','fee','bonus','expense')),
  label TEXT NOT NULL CHECK (length(label) <= 80),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  schedule TEXT NOT NULL CHECK (schedule IN ('one_off','weekly','monthly','annual')),
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0,1)),
  conditional_assumption TEXT CHECK (conditional_assumption IS NULL OR length(conditional_assumption) <= 200),
  PRIMARY KEY (scenario_id, line_id)
) STRICT;

-- source: db.recruitmentCases[].budget.scenarios[].fxAssumptions[]  written at m13/planning.mjs:253 and :282
-- owner/writer: m13/planning.mjs   lifecycle: replaced wholesale on PUT; <= 6 per scenario
-- mapping: from -> from_currency   to -> to_currency   rate (decimal TEXT, up to 6 dp — kept as text, never a float)
--   -> rate   source -> source (<= 80)   date -> rate_date (YYYY-MM-DD, defaulted to today)   manual (always true) -> manual
-- notes: no uniqueness on (from,to) today; `seq` is the list position.
CREATE TABLE case_budget_fx_assumptions (
  scenario_id TEXT NOT NULL REFERENCES case_budget_scenarios(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  from_currency TEXT NOT NULL CHECK (length(from_currency) = 3),
  to_currency TEXT NOT NULL CHECK (length(to_currency) = 3),
  rate TEXT NOT NULL,
  source TEXT NOT NULL CHECK (length(source) <= 80),
  rate_date TEXT NOT NULL CHECK (length(rate_date) = 10),
  manual INTEGER NOT NULL DEFAULT 1 CHECK (manual IN (0,1)),
  PRIMARY KEY (scenario_id, seq)
) STRICT;

-- source: db.recruitmentCases[].budget.scenarios[].actuals[]  created at m13/planning.mjs:314
-- owner/writer: m13/planning.mjs POST .../actuals   lifecycle: append-only
-- mapping: id -> id (act-<n>)   lineId -> line_id   amountMinor -> amount_minor   at -> at   recordedBy (name) -> recorded_by_name
-- notes: line_id has NO FK to case_budget_lines — a later PUT may renumber or drop the line the
--   actual was recorded against (known defect: dangling lineId), so the reference is kept loosely.
CREATE TABLE case_budget_actuals (
  id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL REFERENCES case_budget_scenarios(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  at INTEGER NOT NULL,
  recorded_by_name TEXT NOT NULL                     -- snapshot
) STRICT;
CREATE INDEX case_budget_actuals_scenario ON case_budget_actuals(scenario_id);

-- =============================================================================
-- recruitment_requests  (the recipient's Inbox row: contact or trial invitation)
-- =============================================================================
-- source: db.requests  created at server.mjs:2095 (issueRecruitmentRequest, the ONE writer for
--         legacy requests, Contact sends and P4B invitations) and server.mjs:2730 (open-day
--         follow-up invitation, a second literal writer of the same shape without caseId/recipient/keys)
-- owner/writer: server.mjs (create, respond routes 1440/3237, suspension 1674, tombstone 3955),
--         m23/trialRoutes.mjs:409-412 (caseId, trialId, recipient, keys on a P4B invitation),
--         m23/trialRoutes.mjs:839 (trialId after acceptance)
--         lifecycle: pending -> accepted | declined | suspended (urgent report, server.mjs:1674);
--         subject removal rewrites the row as a tombstone (server.mjs:3955) that drops message,
--         notes, guardianId, contactChannel, recipient, keys and private trial details
-- mapping:
--   id -> id (req-<n>)   playerId -> player_id   playerName -> player_name (snapshot; NULL on tombstone)
--   orgId -> org_id   orgName -> org_name   orgType -> org_type   orgVerified -> org_verified
--   orgSafeguardingCertified -> org_safeguarding_certified   trustedPartner -> org_trusted_partner   (all five: snapshot of the org at send time)
--   userId -> user_id   scoutName -> scout_name (snapshot)   scoutRole -> scout_role (snapshot; 'Scout'/'Manager' default)
--   type -> type   message -> message (<= 2000; NULL on tombstone)   subject -> subject (contact only, <= 120)
--   contactId -> contact_id (recruitment_contacts.id; 1:1 with recruitment_contacts.request_id)
--   trialDetails -> NULL object = every trial_* column NULL (contact requests)
--   trialDetails.proposedDate -> trial_proposed_date   trialDetails.altSlots[] -> trial_alt_slots_json (retained JSON:
--            legacy list of YYYY-MM-DD strings chosen by chooseTrialSlot; on P4B rows it is DERIVED from slots[1..])
--   trialDetails.venue -> trial_venue   trialDetails.notes -> trial_notes ('' on tombstone)
--   trialDetails.slots[] -> request_trial_slots
--   trialDetails.private.venueAddress -> trial_private_venue_address   trialDetails.private.instructions -> trial_private_instructions
--            (both stripped from every recipient view and from the tombstone; D-23)
--   trialDetails.instructions (stray key the tombstone writes, server.mjs:3967) -> dead field, not migrated
--   status -> status   createdAt -> created_at   respondedAt -> responded_at   respondedBy -> responded_by
--   routedTo -> routed_to   guardianId -> guardian_id (NULL on tombstone)
--   contactChannel -> contact_channel_id (channels(id), file 03, no FK; NULL until accepted, NULL on tombstone)
--   caseId -> case_id   trialId -> trial_id (the trial the acceptance created; 1:1)
--   recipient {type, playerId, guardianId, minor} -> recipient_type, recipient_guardian_id, recipient_minor
--            (recipient.playerId == player_id: derived, not stored; the whole object is dropped by the tombstone)
--   keys.invite -> idempotency_keys   subjectRemovedAt -> subject_removed_at
-- notes: one PENDING request per (org, player, type) is enforced by code at server.mjs:2068 but
--   BYPASSED by the open-day path (server.mjs:2730) — the partial unique index below is NEW and
--   must be checked against existing data. Minors: routed_to='guardian' and guardian_id set.
--   Reads: by org (list), by player (Inbox/export), by (routed_to, guardian_id) for the guardian Inbox,
--   by (case_id, type, created_at) for the latest invitation, by contact_id and trial_id.
CREATE TABLE recruitment_requests (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  player_name TEXT,                                  -- snapshot
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name TEXT NOT NULL,                            -- snapshot
  org_type TEXT NOT NULL CHECK (org_type IN ('club','agency')),  -- snapshot
  org_verified INTEGER NOT NULL DEFAULT 0 CHECK (org_verified IN (0,1)),  -- snapshot
  org_safeguarding_certified INTEGER NOT NULL DEFAULT 0 CHECK (org_safeguarding_certified IN (0,1)),  -- snapshot
  org_trusted_partner INTEGER NOT NULL DEFAULT 0 CHECK (org_trusted_partner IN (0,1)),  -- snapshot
  user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  scout_name TEXT NOT NULL,                          -- snapshot
  scout_role TEXT NOT NULL,                          -- snapshot
  type TEXT NOT NULL CHECK (type IN ('contact','trial')),
  message TEXT,
  subject TEXT CHECK (subject IS NULL OR length(subject) <= 120),
  contact_id TEXT,
  trial_proposed_date TEXT CHECK (trial_proposed_date IS NULL OR length(trial_proposed_date) = 10),
  trial_alt_slots_json TEXT CHECK (trial_alt_slots_json IS NULL OR json_valid(trial_alt_slots_json)),
  trial_venue TEXT,
  trial_notes TEXT,
  trial_private_venue_address TEXT CHECK (trial_private_venue_address IS NULL OR length(trial_private_venue_address) <= 200),
  trial_private_instructions TEXT CHECK (trial_private_instructions IS NULL OR length(trial_private_instructions) <= 500),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','suspended')),
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  responded_by TEXT CHECK (responded_by IS NULL OR responded_by IN ('player','guardian')),
  routed_to TEXT CHECK (routed_to IS NULL OR routed_to IN ('player','guardian')),
  guardian_id TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  contact_channel_id TEXT,
  case_id TEXT REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  trial_id TEXT REFERENCES trials(id) ON DELETE SET NULL,
  recipient_type TEXT CHECK (recipient_type IS NULL OR recipient_type IN ('player','guardian')),
  recipient_guardian_id TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  recipient_minor INTEGER CHECK (recipient_minor IS NULL OR recipient_minor IN (0,1)),
  subject_removed_at INTEGER,
  CHECK (type = 'trial' OR (trial_proposed_date IS NULL AND trial_alt_slots_json IS NULL AND trial_venue IS NULL AND trial_notes IS NULL))
) STRICT;
CREATE INDEX recruitment_requests_org_player_type_status ON recruitment_requests(org_id, player_id, type, status);
CREATE INDEX recruitment_requests_player ON recruitment_requests(player_id, created_at);
CREATE INDEX recruitment_requests_routed_guardian ON recruitment_requests(routed_to, guardian_id);
CREATE INDEX recruitment_requests_case_type_created ON recruitment_requests(case_id, type, created_at);
CREATE INDEX recruitment_requests_contact ON recruitment_requests(contact_id);
CREATE INDEX recruitment_requests_trial ON recruitment_requests(trial_id);
CREATE UNIQUE INDEX recruitment_requests_one_pending ON recruitment_requests(org_id, player_id, type)
  WHERE status = 'pending' AND subject_removed_at IS NULL;

-- source: db.requests[].trialDetails.slots[]  created at m23/trialRoutes.mjs:325 (validateInvitation)
-- owner/writer: m23/trialRoutes.mjs POST /rooms/:id/trials   lifecycle: immutable; 1-3 per invitation;
--         tombstone keeps times and venue name/town and nulls the address (always NULL here anyway)
-- mapping: id -> id (tslot-<n>)   day -> day (YYYY-MM-DD in the organiser zone; the value chooseTrialSlot matches)
--   kind -> kind   startsAt -> starts_at   endsAt -> ends_at (UTC ms)   timezone -> timezone (IANA)
--   venue.name -> venue_name   venue.town -> venue_town   (venue.address never exists on a slot; the address is request.trial_private_venue_address)
-- notes: each slot of one invitation falls on a distinct day (enforced at write; UNIQUE(request_id, day)).
CREATE TABLE request_trial_slots (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES recruitment_requests(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (length(day) = 10),
  kind TEXT NOT NULL DEFAULT 'training' CHECK (kind IN ('onboarding','training','drill','small_sided','match','other')),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  timezone TEXT NOT NULL,
  venue_name TEXT NOT NULL CHECK (length(venue_name) <= 120),
  venue_town TEXT CHECK (venue_town IS NULL OR length(venue_town) <= 80),
  UNIQUE (request_id, day)
) STRICT;

-- =============================================================================
-- trials  (AN ACCEPTED TRIAL: report obligation + P4B operational workflow + P2 trial day)
-- =============================================================================
-- source: db.trials  created at server.mjs:2172 (issueAcceptedTrial, the ONE writer); `day` lazily
--         attached at m12/journeys.mjs:533/714/775; `report` at server.mjs:2550; tombstone at server.mjs:3902
-- owner/writer: server.mjs (accept, report, reminderSent), m23/trialRoutes.mjs (schedule, cancel,
--         attendance, complete, evidence links, recipient confirm/decline/cancel), m12/journeys.mjs
--         (day.*, check-in attendance), m12/operations.mjs (feedbackEscalatedAt, reminders)
--         lifecycle: status awaiting_report -> reported (the report gate, never a schedule);
--         workflow_state legacy_accepted|accepted|scheduled|completed|cancelled (stored and
--         integrity-checked against deriveWorkflowState, trial.mjs:297); subject removal rewrites the
--         row as a tombstone that keeps ids/states/times/filed numbers and drops every person-shaped field
-- mapping:
--   id -> id (trial-<n>)   requestId -> request_id (1:1)   caseId -> case_id (NULL = legacy, no case)
--   playerId -> player_id   playerName -> player_name (snapshot; NULL on tombstone)
--   orgId -> org_id   orgName -> org_name (snapshot)   scoutName -> scout_name (snapshot of the inviting scout)
--   acceptedAt -> accepted_at   acceptedBy -> accepted_by   guardianApproved -> guardian_approved
--   proposedDate -> proposed_date (YYYY-MM-DD or NULL = date to be confirmed; postponement rewrites it)
--   venue -> venue (legacy free text)   notes -> notes ('' on tombstone)
--   reportDueAt -> report_due_at (NULL = unknown; never NaN after P4A-D1)
--   status -> status   reminderSent -> reminder_sent   feedbackEscalatedAt -> feedback_escalated_at
--   report -> trial_reports (one row or none)
--   workflowState -> workflow_state (rows written before P4B have NO value: the migration writes 'legacy_accepted', which is how isLegacyTrial reads them)
--   schedule (NULL = no schedule: every schedule_* column NULL, schedule_revision NULL)
--   schedule.timezone -> schedule_timezone   schedule.revision -> schedule_revision
--   schedule.proposedAt -> schedule_proposed_at   schedule.proposedBy {kind,userId,name} -> schedule_proposed_by_kind/_user_id/_name
--   schedule.confirmedAt -> schedule_confirmed_at   schedule.confirmedBy {kind,id,name} -> schedule_confirmed_by_kind/_id/_name
--   schedule.declinedAt -> schedule_declined_at   schedule.declinedBy {kind,id,name} -> schedule_declined_by_kind/_id/_name
--   schedule.sessions[] -> trial_schedule_sessions (the CURRENT revision's sessions)
--   schedule.revisions[] -> trial_schedule_revisions
--   attendance[] -> trial_attendance   completion {state, at, by{kind,userId|id,name}, reason, phase, cancelledBy}
--            -> completion_state, completion_at, completion_by_kind, completion_by_id, completion_by_name,
--               completion_reason (<= 300; NULL on tombstone), completion_phase, completion_cancelled_by
--   recipient {type, playerId, guardianId, minor, at} -> recipient_type, recipient_guardian_id (NULL on tombstone),
--            recipient_minor, recipient_at (recipient.playerId == player_id: derived, not stored)
--   keys -> idempotency_keys (keys.accept is dead, see that table)   history[] -> trial_history
--   reminders {marker: ms} -> trial_reminders
--   lifecycle {applied, from, to, at} | {applied:false, reason, at} (the LAST lifecycle effect, overwritten by
--            accept/confirm/complete) -> lifecycle_applied, lifecycle_from, lifecycle_to, lifecycle_reason, lifecycle_at
--   rev/revAt/revBy -> rev, rev_at, rev_by_user_id, rev_by_name
--   day.staff[] -> trial_day_staff   day.consents[] -> trial_day_consents   day.checkins[] -> trial_day_checkins
--   day.statusEvents[] -> trial_day_status_events
--   day.arrival {time, address, notes} -> day_arrival_time (<= 40), day_arrival_address (<= 200), day_arrival_notes (<= 300)
--   day.collection {policy} -> day_collection_policy (<= 300)
--   day.emergency {name, phone, setBy, at} -> day_emergency_name, day_emergency_phone, day_emergency_set_by, day_emergency_at
--   (presence of the `day` object itself is derived — it is lazily created on read and has no effect except on the tombstone shape)
--   blockedBy -> dead field, not migrated (read at trial.mjs:517 / server.mjs:3945, never written)
--   subjectRemovedAt -> subject_removed_at
-- notes: UNIQUE(request_id). One open trial per case and one pending invitation per case are
--   enforced by code (trialRoutes.mjs:366-369); the partial unique index on (case_id) WHERE open
--   is NEW. Privacy: day_emergency_* is the family's restricted contact (org trial-day view only,
--   withheld while blocked, nulled on tombstone); recipient_guardian_id identifies a minor's guardian.
--   Reads: (org_id, status) report gating; (org_id, player_id, case_id) case listing; player_id
--   family/agent lists; (status, report_due_at) overdue sweeps; (workflow_state, schedule_confirmed_at) reminder sweep.
CREATE TABLE trials (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES recruitment_requests(id) ON DELETE RESTRICT,
  case_id TEXT REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  player_name TEXT,                                  -- snapshot
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name TEXT NOT NULL,                            -- snapshot
  scout_name TEXT,                                   -- snapshot
  accepted_at INTEGER NOT NULL,
  accepted_by TEXT CHECK (accepted_by IS NULL OR accepted_by IN ('player','guardian')),
  guardian_approved INTEGER CHECK (guardian_approved IS NULL OR guardian_approved IN (0,1)),
  proposed_date TEXT CHECK (proposed_date IS NULL OR length(proposed_date) = 10),
  venue TEXT,
  notes TEXT NOT NULL DEFAULT '',
  report_due_at INTEGER,
  status TEXT NOT NULL DEFAULT 'awaiting_report' CHECK (status IN ('awaiting_report','reported')),
  reminder_sent INTEGER NOT NULL DEFAULT 0 CHECK (reminder_sent IN (0,1)),
  feedback_escalated_at INTEGER,
  workflow_state TEXT NOT NULL CHECK (workflow_state IN ('legacy_accepted','accepted','scheduled','completed','cancelled')),
  schedule_timezone TEXT,
  schedule_revision INTEGER CHECK (schedule_revision IS NULL OR schedule_revision >= 1),
  schedule_proposed_at INTEGER,
  schedule_proposed_by_kind TEXT,
  schedule_proposed_by_user_id TEXT,
  schedule_proposed_by_name TEXT,                    -- snapshot
  schedule_confirmed_at INTEGER,
  schedule_confirmed_by_kind TEXT CHECK (schedule_confirmed_by_kind IS NULL OR schedule_confirmed_by_kind IN ('player','guardian')),
  schedule_confirmed_by_id TEXT,
  schedule_confirmed_by_name TEXT,                   -- snapshot
  schedule_declined_at INTEGER,
  schedule_declined_by_kind TEXT CHECK (schedule_declined_by_kind IS NULL OR schedule_declined_by_kind IN ('player','guardian')),
  schedule_declined_by_id TEXT,
  schedule_declined_by_name TEXT,                    -- snapshot
  completion_state TEXT CHECK (completion_state IS NULL OR completion_state IN ('completed','cancelled')),
  completion_at INTEGER,
  completion_by_kind TEXT CHECK (completion_by_kind IS NULL OR completion_by_kind IN ('org','player','guardian','system')),
  completion_by_id TEXT,
  completion_by_name TEXT,                           -- snapshot
  completion_reason TEXT CHECK (completion_reason IS NULL OR length(completion_reason) <= 300),
  completion_phase TEXT CHECK (completion_phase IS NULL OR completion_phase IN ('legacy_accepted','accepted','scheduled')),
  completion_cancelled_by TEXT CHECK (completion_cancelled_by IS NULL OR completion_cancelled_by IN ('club','player','guardian','system')),
  recipient_type TEXT CHECK (recipient_type IS NULL OR recipient_type IN ('player','guardian')),
  recipient_guardian_id TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  recipient_minor INTEGER CHECK (recipient_minor IS NULL OR recipient_minor IN (0,1)),
  recipient_at INTEGER,
  lifecycle_applied INTEGER CHECK (lifecycle_applied IS NULL OR lifecycle_applied IN (0,1)),
  lifecycle_from TEXT,
  lifecycle_to TEXT,
  lifecycle_reason TEXT,
  lifecycle_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  rev_at INTEGER,
  rev_by_user_id TEXT,
  rev_by_name TEXT,                                  -- snapshot
  day_arrival_time TEXT CHECK (day_arrival_time IS NULL OR length(day_arrival_time) <= 40),
  day_arrival_address TEXT CHECK (day_arrival_address IS NULL OR length(day_arrival_address) <= 200),
  day_arrival_notes TEXT CHECK (day_arrival_notes IS NULL OR length(day_arrival_notes) <= 300),
  day_collection_policy TEXT CHECK (day_collection_policy IS NULL OR length(day_collection_policy) <= 300),
  day_emergency_name TEXT CHECK (day_emergency_name IS NULL OR length(day_emergency_name) <= 80),     -- personal data (restricted)
  day_emergency_phone TEXT CHECK (day_emergency_phone IS NULL OR length(day_emergency_phone) <= 30),  -- personal data (restricted)
  day_emergency_set_by TEXT CHECK (day_emergency_set_by IS NULL OR day_emergency_set_by IN ('player','guardian')),
  day_emergency_at INTEGER,
  subject_removed_at INTEGER,
  CHECK ((schedule_timezone IS NULL) = (schedule_revision IS NULL)),
  CHECK ((completion_state IS NULL) = (completion_at IS NULL))
) STRICT;
CREATE INDEX trials_org_status ON trials(org_id, status);
CREATE INDEX trials_org_player_case ON trials(org_id, player_id, case_id);
CREATE INDEX trials_player ON trials(player_id);
CREATE INDEX trials_case ON trials(case_id);
CREATE INDEX trials_status_report_due ON trials(status, report_due_at);
CREATE INDEX trials_workflow_confirmed ON trials(workflow_state, schedule_confirmed_at);
CREATE UNIQUE INDEX trials_one_open_per_case ON trials(case_id)
  WHERE case_id IS NOT NULL AND workflow_state NOT IN ('completed','cancelled');

-- source: db.trials[].schedule.sessions[]  created at server.mjs:2159 (acceptance of a concrete slot) and
--         m23/trialRoutes.mjs:490 (schedule/reschedule; ids minted `tses-<n>` by validateScheduleInput)
-- owner/writer: m23/trialRoutes.mjs   lifecycle: the CURRENT revision's list; a revision may drop a session
--         that has not ended and has no attendance (it survives only inside trial_schedule_revisions.sessions_json);
--         1-20 per trial, no overlaps, each 15 min - 12 h
-- mapping: id -> id (tses-<n>)   kind -> kind   startsAt -> starts_at   endsAt -> ends_at (UTC ms)
--   venue {name, town, address} -> venue_name, venue_town, venue_address (address NULL on tombstone; NULL venue = all three NULL)
--   instructions -> instructions (<= 500; NULL on tombstone)   evidence[] -> trial_session_evidence
-- notes: display order is (starts_at, numeric id part) — derived, not stored.
CREATE TABLE trial_schedule_sessions (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'training' CHECK (kind IN ('onboarding','training','drill','small_sided','match','other')),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  venue_name TEXT CHECK (venue_name IS NULL OR length(venue_name) <= 120),
  venue_town TEXT CHECK (venue_town IS NULL OR length(venue_town) <= 80),
  venue_address TEXT CHECK (venue_address IS NULL OR length(venue_address) <= 200),
  instructions TEXT CHECK (instructions IS NULL OR length(instructions) <= 500)
) STRICT;
CREATE INDEX trial_schedule_sessions_trial_starts ON trial_schedule_sessions(trial_id, starts_at);

-- source: db.trials[].schedule.sessions[].evidence[]  created at m23/trialRoutes.mjs:707
-- owner/writer: m23/trialRoutes.mjs (link, unlink = tombstone)   lifecycle: removed_at set on unlink, never erased;
--         <= 20 active per session; the tombstone of the trial drops every link (server.mjs:3921)
-- mapping: id -> id (tev-<n>)   kind ('box_cam_session') -> kind   sessionId -> box_session_id (box_sessions(id), file 07, no FK)
--   linkedAt -> linked_at   linkedBy {kind,userId,name} -> linked_by_kind, linked_by_user_id, linked_by_name
--   removedAt -> removed_at   removedBy -> removed_by_kind, removed_by_user_id, removed_by_name
-- notes: one ACTIVE link per (session, box session) is enforced by code (D-12) — partial unique index.
--   CASCADE from the session mirrors today's loss of links on a dropped session (known defect).
CREATE TABLE trial_session_evidence (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES trial_schedule_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'box_cam_session' CHECK (kind IN ('box_cam_session')),
  box_session_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  linked_by_kind TEXT NOT NULL DEFAULT 'org',
  linked_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  linked_by_name TEXT,                               -- snapshot
  removed_at INTEGER,
  removed_by_kind TEXT,
  removed_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  removed_by_name TEXT                               -- snapshot
) STRICT;
CREATE INDEX trial_session_evidence_box_session ON trial_session_evidence(box_session_id);
CREATE UNIQUE INDEX trial_session_evidence_one_active ON trial_session_evidence(session_id, box_session_id)
  WHERE removed_at IS NULL;

-- source: db.trials[].schedule.revisions[]  created at server.mjs:2170 (revision 1 on acceptance) and m23/trialRoutes.mjs:499
-- owner/writer: m23/trialRoutes.mjs (append; confirmation stamped at :915 and :513; previous rows get supersededAt)
--         lifecycle: append-only, <= 30 per trial; the tombstone drops reason and proposer/confirmer names
-- mapping: revision -> revision   timezone -> timezone
--   sessions[] (a copy of the session rows without evidence) -> sessions_json (retained JSON by design: an immutable
--            snapshot of <= 20 {id,kind,startsAt,endsAt,venue,instructions} read only as `sessionCount` and by the
--            tombstone; normalising it would duplicate trial_schedule_sessions per revision — deferred, step: a
--            trial_schedule_revision_sessions table keyed (trial_id, revision, session_id))
--   proposedAt -> proposed_at   proposedBy {kind,userId,name} -> proposed_by_kind, proposed_by_user_id, proposed_by_name
--   confirmedAt -> confirmed_at   confirmedBy {kind,id,name} -> confirmed_by_kind, confirmed_by_id, confirmed_by_name
--   supersededAt -> superseded_at   reason -> reason (<= 300; 'invitation' on revision 1)   material -> material (NULL on revision 1)
-- notes: the current revision (trials.schedule_revision) always has a row here.
CREATE TABLE trial_schedule_revisions (
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  timezone TEXT NOT NULL,
  sessions_json TEXT NOT NULL CHECK (json_valid(sessions_json)),
  proposed_at INTEGER,
  proposed_by_kind TEXT,
  proposed_by_user_id TEXT,
  proposed_by_name TEXT,                             -- snapshot
  confirmed_at INTEGER,
  confirmed_by_kind TEXT,
  confirmed_by_id TEXT,
  confirmed_by_name TEXT,                            -- snapshot
  superseded_at INTEGER,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 300),
  material INTEGER CHECK (material IS NULL OR material IN (0,1)),
  PRIMARY KEY (trial_id, revision)
) STRICT;

-- source: db.trials[].attendance[]  created at m23/trialRoutes.mjs:597 (manual) and m12/journeys.mjs:691 (check-in)
-- owner/writer: m23/trialRoutes.mjs, m12/journeys.mjs   lifecycle: append-only; the latest row per session is current
--         (currentAttendance); `not_recorded` is derived, never stored; tombstone nulls note
-- mapping: (no id today) -> id minted `tatt-<n>` from the global counter   sessionId -> session_id
--   state -> state   source -> source   recordedBy {kind,userId,name} -> recorded_by_kind, recorded_by_user_id, recorded_by_name
--   recordedAt -> recorded_at   note -> note (<= 300)
-- notes: read in insertion order to find the latest per session — (trial_id, session_id, recorded_at).
CREATE TABLE trial_attendance (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES trial_schedule_sessions(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('attended','partial','no_show','club_cancelled','player_withdrew')),
  source TEXT NOT NULL CHECK (source IN ('manual','checkin')),
  recorded_by_kind TEXT NOT NULL DEFAULT 'org',
  recorded_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  recorded_by_name TEXT,                             -- snapshot
  recorded_at INTEGER NOT NULL,
  note TEXT CHECK (note IS NULL OR length(note) <= 300)
) STRICT;
CREATE INDEX trial_attendance_trial_session_at ON trial_attendance(trial_id, session_id, recorded_at);

-- source: db.trials[].reminders  (map) written at m12/operations.mjs:355/364/376
-- owner/writer: m12/operations.mjs sweep   lifecycle: write-once markers, never cleared
-- mapping: key `t48:<sessionId>:<revision>` | 'completionPending' | 'assessmentPending' -> marker;  value (ms) -> sent_at
-- notes: the marker is the natural key; old-revision markers outlive their sessions (no FK).
CREATE TABLE trial_reminders (
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  marker TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (trial_id, marker)
) STRICT;

-- source: db.trials[].day.staff[]  created at m12/journeys.mjs:605; check reviewed at m12/journeys.mjs:810 (admin)
-- owner/writer: m12/journeys.mjs (org adds staff; T&S admin route sets check status/expiry)
--         lifecycle: check.status pending -> reviewed | rejected; 'expired' is DERIVED (checkState) from expires;
--         staff rows survive the tombstone verbatim (the club's own named staff)
-- mapping: id -> id (stf-<n>)   name -> name (<= 80)   role -> role (<= 60)
--   check (NULL = no check filed: every check_* column NULL)   check.kind -> check_kind (<= 60)   check.ref -> check_ref (<= 60)
--   check.status -> check_status   check.expiresAt -> check_expires_raw (a YYYY-MM-DD day OR an ISO instant string as written by
--            checkExpiryOrRefuse; parsed on read by readCheckExpiry — kept verbatim rather than split, flagged)
--   check.reviewedBy ('Trust & Safety' literal) -> check_reviewed_by_name   check.reviewedAt -> check_reviewed_at
--   addedBy (name) -> added_by_name   addedAt -> added_at
-- notes: personal data of club staff (name, check reference); never shown to families beyond name/role/state.
CREATE TABLE trial_day_staff (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) <= 80),     -- personal data
  role TEXT NOT NULL CHECK (length(role) <= 60),
  check_kind TEXT CHECK (check_kind IS NULL OR length(check_kind) <= 60),
  check_ref TEXT CHECK (check_ref IS NULL OR length(check_ref) <= 60),  -- personal data
  check_status TEXT CHECK (check_status IS NULL OR check_status IN ('pending','reviewed','rejected')),
  check_expires_raw TEXT,
  check_reviewed_by_name TEXT,                       -- snapshot
  check_reviewed_at INTEGER,
  added_by_name TEXT NOT NULL,                       -- snapshot
  added_at INTEGER NOT NULL,
  CHECK ((check_kind IS NULL) = (check_status IS NULL))
) STRICT;
CREATE INDEX trial_day_staff_trial ON trial_day_staff(trial_id);

-- source: db.trials[].day.consents[]  created at m12/journeys.mjs:720
-- owner/writer: m12/journeys.mjs (player/guardian consent routes)   lifecycle: append-only; the tombstone keeps
--         id, scope, at and by.kind only (drops by.id and by.name)
-- mapping: id -> id (cns-<n>)   by {kind,id,name} -> by_kind, by_id (NULL on tombstone), by_name (NULL on tombstone)
--   scope -> scope   at -> at
-- notes: one consent per (trial, scope, by.id) enforced by code (ALREADY_CONSENTED) — partial unique index.
CREATE TABLE trial_day_consents (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  by_kind TEXT NOT NULL CHECK (by_kind IN ('player','guardian')),
  by_id TEXT,
  by_name TEXT,                                      -- snapshot
  scope TEXT NOT NULL CHECK (scope IN ('player_event_consent','guardian_event_consent')),
  at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX trial_day_consents_one_per_actor ON trial_day_consents(trial_id, scope, by_id)
  WHERE by_id IS NOT NULL;

-- source: db.trials[].day.checkins[]  created at m12/journeys.mjs:681
-- owner/writer: m12/journeys.mjs POST /trials/:id/checkin   lifecycle: at most one per (trial, player); survives the tombstone
-- mapping: playerId -> player_id   at -> at   byUserId -> by_user_id   byName -> by_name
-- notes: player_id always equals trials.player_id today; natural PRIMARY KEY (trial_id, player_id) is what the code enforces.
CREATE TABLE trial_day_checkins (
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  by_name TEXT NOT NULL,                             -- snapshot
  PRIMARY KEY (trial_id, player_id)
) STRICT;

-- source: db.trials[].day.statusEvents[]  created at m12/journeys.mjs:651
-- owner/writer: m12/journeys.mjs (legacy cancel/postpone)   lifecycle: append-only; survives the tombstone verbatim
-- mapping: (no id today) -> id minted `tdse-<n>` from the global counter   kind -> kind   at -> at
--   by (name) -> by_name   reason -> reason (<= 200)   newDate -> new_date (YYYY-MM-DD, postponed only)
-- notes: a 'cancelled' event is the legacy cancellation flag (read at journeys.mjs:670); the P4B
--   cancellation lives in trials.completion_* and the two are NOT synchronised (known gap).
CREATE TABLE trial_day_status_events (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cancelled','postponed')),
  at INTEGER NOT NULL,
  by_name TEXT NOT NULL,                             -- snapshot
  reason TEXT NOT NULL CHECK (length(reason) <= 200),
  new_date TEXT CHECK (new_date IS NULL OR length(new_date) = 10)
) STRICT;
CREATE INDEX trial_day_status_events_trial_at ON trial_day_status_events(trial_id, at);

-- source: db.trials[].report  created at server.mjs:2550 (the embedded Trial Performance Report)
-- owner/writer: server.mjs POST /org/trials/:trialId/report   lifecycle: written once (ALREADY_REPORTED);
--         the tombstone keeps every number and nulls notes/strengthNote/focusNote
-- mapping: id -> id (rep-<n>; prefix shared with db.reports and rep-mig2305 ids — kept, globally unique in practice)
--   trialId -> trial_id (1:1)   playerId -> player_id   orgId -> org_id   orgName -> org_name (snapshot)
--   userId -> user_id   scoutName -> scout_name (snapshot)   filedAt -> filed_at
--   acceleration -> acceleration (0-10)   sprintSpeedKmh -> sprint_speed_kmh   distanceKm -> distance_km
--   passCompletionPct -> pass_completion_pct   duelSuccessPct -> duel_success_pct   coachRating -> coach_rating (1-10)
--   notes -> notes ('' default)   strengthNote -> strength_note   focusNote -> focus_note
-- notes: the SAME object is pushed onto players[].trialReports (server.mjs:2570) and read from there by
--   the profile, trust score and channel attachments — 01_identity.sql must NOT carry a second copy;
--   readers join trial_reports by player_id. Ranges are documented, not validated (validateTrialReport
--   only checks "is a number"), so no range CHECKs here.
CREATE TABLE trial_reports (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL UNIQUE REFERENCES trials(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name TEXT NOT NULL,                            -- snapshot
  user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  scout_name TEXT NOT NULL,                          -- snapshot
  filed_at INTEGER NOT NULL,
  acceleration REAL NOT NULL,
  sprint_speed_kmh REAL NOT NULL,
  distance_km REAL NOT NULL,
  pass_completion_pct REAL NOT NULL,
  duel_success_pct REAL NOT NULL,
  coach_rating REAL NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  strength_note TEXT,
  focus_note TEXT
) STRICT;
CREATE INDEX trial_reports_player ON trial_reports(player_id);
CREATE INDEX trial_reports_org ON trial_reports(org_id, filed_at);

-- source: db.trials[].history[]  created at server.mjs:2197, m23/trialRoutes.mjs:83 record(), m12/journeys.mjs:693
-- owner/writer: as above   lifecycle: append-only; the tombstone keeps id/at/action/by.kind and drops
--         detail string values longer than 40 chars (server.mjs:3947)
-- mapping: id -> id (aud-<n>)   at -> at   by {kind, userId|id, name} -> by_kind, by_id, by_name   action -> action   detail -> detail_json
-- notes: paged at 100 (TRIAL_LIMITS.historyPage), ordered by at then numeric id part.
CREATE TABLE trial_history (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE RESTRICT,
  at INTEGER NOT NULL,
  by_kind TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','guardian','system')),
  by_id TEXT,
  by_name TEXT,                                      -- snapshot
  action TEXT NOT NULL,
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;
CREATE INDEX trial_history_trial_at ON trial_history(trial_id, at);

-- =============================================================================
-- Room components: comments, snapshots, decisions, evidence review state
-- =============================================================================
-- source: db.roomComments  created at m17/rooms.mjs:1041
-- owner/writer: m17/rooms.mjs (create, author edit, delete = tombstone)   lifecycle: deleted_at set, never erased;
--         20 per room per minute (rate limit, not schema)
-- mapping: id -> id (rcmt-<n>)   roomId -> room_id (= recruitment_cases.id)   orgId -> org_id
--   authorId -> author_user_id   authorName -> author_name (snapshot)   body -> body (<= 4000, inert text; NULL in views once deleted but kept stored)
--   replyToId -> reply_to_id (same room, checked at write)   mentions[] -> room_comment_mentions
--   createdAt -> created_at   editedAt -> edited_at   editCount -> edit_count
--   deletedAt -> deleted_at   deletedBy {userId,name} -> deleted_by_user_id, deleted_by_name
-- notes: tenant-private; never visible to players. Read newest-first by room with an id cursor.
CREATE TABLE room_comments (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  author_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  author_name TEXT NOT NULL,                         -- snapshot
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  reply_to_id TEXT REFERENCES room_comments(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  edit_count INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  deleted_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  deleted_by_name TEXT                               -- snapshot
) STRICT;
CREATE INDEX room_comments_room_created ON room_comments(room_id, created_at);

-- source: db.roomComments[].mentions[]  written at m17/rooms.mjs:1037 (user ids in this org, <= 20, deduped)
-- owner/writer: m17/rooms.mjs   lifecycle: immutable with the comment
-- mapping: userId -> user_id
-- notes: a departed colleague renders as 'Former colleague' (name is resolved live, never stored).
CREATE TABLE room_comment_mentions (
  comment_id TEXT NOT NULL REFERENCES room_comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  PRIMARY KEY (comment_id, user_id)
) STRICT;

-- source: db.roomSnapshots  created at m17/rooms.mjs:963 (captureSnapshot; triggers status:<to>, decision, decision:finalize)
-- owner/writer: m17/rooms.mjs   lifecycle: append-only, never deleted
-- mapping: id -> id (rsnap-<n>)   roomId -> room_id   orgId -> org_id   playerId -> player_id   at -> at   trigger -> trigger
--   trust (NULL = none: all trust_* NULL)   trust.score -> trust_score   trust.band -> trust_band
--   trust.policyVersion -> trust_policy_version   trust.componentLevels {component: level} -> trust_component_levels_json
--            (retained JSON: a small map of component -> level word, read whole for display; keys are the M16.2 component registry)
--   trust.hash -> trust_hash
--   sourceRefs.passportVersion -> passport_version   sourceRefs.passportRevision -> passport_revision
--   sourceRefs.evidenceIds[] / assessmentIds[] / combineResults[] / trialIds[] -> room_snapshot_source_refs
--   note (constant disclaimer string) -> derived, not stored
-- notes: copied by reference onto room_decisions.snapshot_id (the decision's `snapshot` object is an exact copy of this row).
CREATE TABLE room_snapshots (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  trust_score REAL,
  trust_band TEXT,
  trust_policy_version INTEGER,
  trust_component_levels_json TEXT CHECK (trust_component_levels_json IS NULL OR json_valid(trust_component_levels_json)),
  trust_hash TEXT,
  passport_version INTEGER,
  passport_revision INTEGER
) STRICT;
CREATE INDEX room_snapshots_room_at ON room_snapshots(room_id, at);

-- source: db.roomSnapshots[].sourceRefs.{evidenceIds,assessmentIds,combineResults,trialIds}[]  m17/rooms.mjs:969-981
-- owner/writer: m17/rooms.mjs   lifecycle: immutable with the snapshot; capped 40/20/20/10
-- mapping: evidenceIds[i] -> ('evidence', id: evidence(04))   assessmentIds[i] -> ('assessment', id: assessments(04))
--   combineResults[i] (`<protocolId>@<version>` strings) -> ('combine_result', text)   trialIds[i] -> ('trial', trials.id)
-- notes: polymorphic (kind, ref_id), no FK; `seq` preserves list order.
CREATE TABLE room_snapshot_source_refs (
  snapshot_id TEXT NOT NULL REFERENCES room_snapshots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('evidence','assessment','combine_result','trial')),
  seq INTEGER NOT NULL,
  ref_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, kind, seq)
) STRICT;

-- source: db.roomDecisions  created at m17/rooms.mjs:1175 (advisory recommendation, recordDecision) and
--         m23/decisionRoutes.mjs:371 (formal decision)
-- owner/writer: m17/rooms.mjs, m23/decisionRoutes.mjs   lifecycle: append-only chain per room; a new row sets
--         supersededById on the previous head; the head is the row with no successor; formal rows bump their
--         own rev when superseded; never deleted
-- mapping: id -> id (rdec-<n>)   roomId -> room_id   orgId -> org_id   playerId -> player_id
--   kind ('formal' | absent) -> kind (absent rows migrate as 'recommendation', which is how decisionKind reads them)
--   state ('final' | absent) -> state ('final' always; DECISION_STATES also names 'draft' but no stored row is a draft)
--   outcome -> outcome (formal only)   recommendation -> recommendation
--   reasonCodes[] -> reason_codes_json   note -> note (<= 2000, club-private)
--   by {userId,name,role} -> by_user_id, by_name, by_role   createdAt -> created_at   finalizedAt -> finalized_at (formal)
--   trigger -> trigger ('decision' | 'status:<to>' | 'decision:finalize')
--   clientKey -> client_key (the M17 per-room replay key, searched by (roomId, clientKey); also the formal row's key.key)
--   supersedes -> supersedes_id   supersededById -> superseded_by_id
--   supersession {of, reason} -> supersession_of_id, supersession_reason (<= 500)
--   rev -> rev   revAt -> rev_at (formal only; legacy rows read rev 1)
--   evidenceRefs[] -> room_decision_evidence_refs
--   assessmentSummary {submitted, withheld, verdicts{sign,monitor,pass,none}, assessmentIds[] <= 20} ->
--            assessment_submitted, assessment_withheld, assessment_verdict_sign/_monitor/_pass/_none,
--            assessment_ids_json (retained JSON: immutable list of cited assessment ids read whole; deferred junction)
--   snapshot {at, trust, sourceRefs, snapshotId} -> snapshot_id (the rest is derived, not stored: exact copy of room_snapshots)
--   keys.finalize / keys.draft -> idempotency_keys   draftId -> draft_id (the draft row is deleted on finalize; no FK)
--   lifecycle {action, from, to, applied, reason?, at} -> lifecycle_action, lifecycle_from, lifecycle_to, lifecycle_applied,
--            lifecycle_reason, lifecycle_at
--   policyVersion -> policy_version
-- notes: more than one formal head per room is corruption (duplicateFinalHeads), not a constraint.
--   UNIQUE (room_id, client_key) is what the M17 replay lookup assumes — enforced by code today.
--   Read by room (chain order createdAt, id) and by the Second Look / handoff readers (head only).
CREATE TABLE room_decisions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'recommendation' CHECK (kind IN ('recommendation','formal')),
  state TEXT NOT NULL DEFAULT 'final' CHECK (state IN ('final')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('progress','hold','reject')),
  recommendation TEXT NOT NULL CHECK (recommendation IN ('no_decision','continue_watching','shortlist','priority','trial','offer','archive')),
  reason_codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reason_codes_json)),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  by_name TEXT,                                      -- snapshot
  by_role TEXT,                                      -- snapshot
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  trigger TEXT NOT NULL,
  client_key TEXT CHECK (client_key IS NULL OR length(client_key) <= 64),
  supersedes_id TEXT REFERENCES room_decisions(id) ON DELETE RESTRICT,
  superseded_by_id TEXT REFERENCES room_decisions(id) ON DELETE RESTRICT,
  supersession_of_id TEXT REFERENCES room_decisions(id) ON DELETE RESTRICT,
  supersession_reason TEXT CHECK (supersession_reason IS NULL OR length(supersession_reason) <= 500),
  rev INTEGER NOT NULL DEFAULT 1,
  rev_at INTEGER,
  assessment_submitted INTEGER,
  assessment_withheld INTEGER,
  assessment_verdict_sign INTEGER,
  assessment_verdict_monitor INTEGER,
  assessment_verdict_pass INTEGER,
  assessment_verdict_none INTEGER,
  assessment_ids_json TEXT CHECK (assessment_ids_json IS NULL OR json_valid(assessment_ids_json)),
  snapshot_id TEXT REFERENCES room_snapshots(id) ON DELETE RESTRICT,
  draft_id TEXT,
  lifecycle_action TEXT,
  lifecycle_from TEXT,
  lifecycle_to TEXT,
  lifecycle_applied INTEGER CHECK (lifecycle_applied IS NULL OR lifecycle_applied IN (0,1)),
  lifecycle_reason TEXT,
  lifecycle_at INTEGER,
  policy_version INTEGER,
  CHECK (kind = 'formal' OR outcome IS NULL)
) STRICT;
CREATE INDEX room_decisions_room_created ON room_decisions(room_id, created_at);
CREATE INDEX room_decisions_room_head ON room_decisions(room_id, superseded_by_id);
CREATE UNIQUE INDEX room_decisions_room_client_key ON room_decisions(room_id, client_key)
  WHERE client_key IS NOT NULL;

-- source: db.roomDecisions[].evidenceRefs[]  created at m23/decisionRoutes.mjs:378 (resolveEvidenceRefs output)
-- owner/writer: m23/decisionRoutes.mjs   lifecycle: immutable with the row; <= 50; deduped by (kind, id)
-- mapping: kind -> kind   id -> ref_id (polymorphic: assessments(04) | trials | box_sessions(07) | evidence(04); no FK)
--   meta -> meta_json (retained JSON by design: per-kind immutable metadata captured at decision time — assessment
--            {scoutName, submittedAt, verdict, trialId}, trial {workflowState, completedAt}, box_cam_session
--            {trialId, trialSessionId, verificationState, simulated}, passport_evidence {claimType, provenance};
--            <= 4 scalar keys, never queried)
-- notes: evidence of this case only (resolved against the case at finalize).
CREATE TABLE room_decision_evidence_refs (
  decision_id TEXT NOT NULL REFERENCES room_decisions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('assessment','trial','box_cam_session','passport_evidence')),
  ref_id TEXT NOT NULL,
  meta_json TEXT CHECK (meta_json IS NULL OR json_valid(meta_json)),
  PRIMARY KEY (decision_id, kind, ref_id)
) STRICT;

-- source: db.roomEvidenceState  created at m17/rooms.mjs:1273
-- owner/writer: m17/rooms.mjs POST /rooms/:id/evidence/:eid/review   lifecycle: one row per (room, evidence), overwritten in place
-- mapping: id -> id (`rev-<n>` — prefix collides with the `rev` field name, kept as-is)   roomId -> room_id   orgId -> org_id
--   evidenceId -> evidence_id (evidence(id), file 04, no FK)   state -> state   note -> note (<= 1000; an edit without a note keeps the old one)
--   byId -> by_user_id   byName -> by_name (snapshot)   at -> at
-- notes: UNIQUE (room_id, evidence_id) enforced by code today (find-then-assign).
CREATE TABLE room_evidence_states (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  evidence_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('not_reviewed','reviewing','reviewed','needs_follow_up')),
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  by_name TEXT NOT NULL,                             -- snapshot
  at INTEGER NOT NULL,
  UNIQUE (room_id, evidence_id)
) STRICT;

-- =============================================================================
-- recruitment_contacts  (the club's internal record of one communication process)
-- =============================================================================
-- source: db.recruitmentContacts  created at m23/contactRoutes.mjs:319 (draft) and :598 (attested external record)
-- owner/writer: m23/contactRoutes.mjs (draft, edit, cancel, send, external record, ctx.onRequestResponded),
--         server.mjs:3998 (subject removal nulls response.message)
--         lifecycle: CONTACT_TRANSITIONS draft -> delivered|failed|cancelled; failed -> delivered|failed|cancelled;
--         delivered -> responded; recorded/responded/cancelled are final; never deleted
-- mapping:
--   id -> id (rct-<n>)   orgId -> org_id   caseId -> case_id   playerId -> player_id   status -> status   channel -> channel
--   recipient {type, playerId, guardianId, minor}|null -> recipient_type, recipient_guardian_id, recipient_minor
--            (set on send / external record; recipient.playerId == player_id: derived, not stored)
--   contactMode -> contact_mode (rows written before P5.6E have none and read as 'player_only')
--   routingSnapshot {at, mode, player, guardian, agent{agentUserId, agreementId}|null, honest}|null ->
--            routing_at, routing_mode, routing_player, routing_guardian, routing_agent_user_id,
--            routing_agent_agreement_id (representation_agreements(id), file 06, no FK); `honest` is a constant sentence — derived, not stored
--   subject -> subject (<= 120)   body -> body (<= 2000, the words the recipient read)   summary -> summary (<= 500, external only)
--   createdBy {kind,userId,name} -> created_by_user_id, created_by_name   createdAt -> created_at   updatedAt -> updated_at
--   sentBy -> sent_by_user_id, sent_by_name   sentAt -> sent_at   deliveredAt -> delivered_at   failedAt -> failed_at
--   failureCode -> failure_code ('TRANSPORT_REFUSED')   attempts[] -> contact_attempts
--   requestId -> request_id (recruitment_requests.id, 1:1)
--   emailCopy {state, to:'guardian', outboxId, at}|null -> email_copy_state, email_copy_outbox_id (outbox(id), file 03, no FK), email_copy_at
--   lifecycle {applied:true, from, to, at} | {applied:false, reason, at} | null -> lifecycle_applied, lifecycle_from, lifecycle_to, lifecycle_reason, lifecycle_at
--   occurredAt -> occurred_at   recordedBy -> recorded_by_user_id, recorded_by_name   recordedAt -> recorded_at
--   respondedAt -> responded_at   response {kind, message, by, at} -> response_kind, response_message (<= 500; NULL after
--            subject removal), response_by, response_at
--   cancelledAt -> cancelled_at   cancelledBy -> cancelled_by_user_id, cancelled_by_name
--   keys {create, send, record} -> idempotency_keys   history[] -> contact_history
--   rev/revAt/revBy -> rev, rev_at, rev_by_user_id, rev_by_name   policyVersion -> policy_version
-- notes: cooldown = one DELIVERED in_app contact per (org, player) per 72 h unless answered —
--   index (org_id, player_id, channel, status, delivered_at). Reads by (case_id, org_id) and by
--   routing_agent_user_id (the agent's own list). Tenant-private; body/summary are club words.
CREATE TABLE recruitment_contacts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','delivered','failed','responded','recorded','cancelled')),
  channel TEXT NOT NULL CHECK (channel IN ('in_app','phone','in_person','email_external','agent','other')),
  recipient_type TEXT CHECK (recipient_type IS NULL OR recipient_type IN ('player','guardian')),
  recipient_guardian_id TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  recipient_minor INTEGER CHECK (recipient_minor IS NULL OR recipient_minor IN (0,1)),
  contact_mode TEXT NOT NULL DEFAULT 'player_only' CHECK (contact_mode IN ('player_only','both')),
  routing_at INTEGER,
  routing_mode TEXT CHECK (routing_mode IS NULL OR routing_mode IN ('player_only','both')),
  routing_player INTEGER CHECK (routing_player IS NULL OR routing_player IN (0,1)),
  routing_guardian INTEGER CHECK (routing_guardian IS NULL OR routing_guardian IN (0,1)),
  routing_agent_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  routing_agent_agreement_id TEXT,
  subject TEXT CHECK (subject IS NULL OR length(subject) <= 120),
  body TEXT CHECK (body IS NULL OR length(body) <= 2000),
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 500),
  created_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name TEXT,                              -- snapshot
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  sent_by_name TEXT,                                 -- snapshot
  sent_at INTEGER,
  delivered_at INTEGER,
  failed_at INTEGER,
  failure_code TEXT,
  request_id TEXT REFERENCES recruitment_requests(id) ON DELETE RESTRICT,
  email_copy_state TEXT CHECK (email_copy_state IS NULL OR email_copy_state IN ('queued','not_available','local_outbox','accepted_by_provider','failed')),
  email_copy_outbox_id TEXT,
  email_copy_at INTEGER,
  lifecycle_applied INTEGER CHECK (lifecycle_applied IS NULL OR lifecycle_applied IN (0,1)),
  lifecycle_from TEXT,
  lifecycle_to TEXT,
  lifecycle_reason TEXT,
  lifecycle_at INTEGER,
  occurred_at INTEGER,
  recorded_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  recorded_by_name TEXT,                             -- snapshot
  recorded_at INTEGER,
  responded_at INTEGER,
  response_kind TEXT CHECK (response_kind IS NULL OR response_kind IN ('accepted','declined')),
  response_message TEXT CHECK (response_message IS NULL OR length(response_message) <= 500),
  response_by TEXT CHECK (response_by IS NULL OR response_by IN ('player','guardian')),
  response_at INTEGER,
  cancelled_at INTEGER,
  cancelled_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  cancelled_by_name TEXT,                            -- snapshot
  rev INTEGER NOT NULL DEFAULT 1,
  rev_at INTEGER,
  rev_by_user_id TEXT,
  rev_by_name TEXT,                                  -- snapshot
  policy_version INTEGER NOT NULL DEFAULT 1,
  CHECK (channel = 'in_app' OR status = 'recorded')
) STRICT;
CREATE INDEX recruitment_contacts_case_org_created ON recruitment_contacts(case_id, org_id, created_at);
CREATE INDEX recruitment_contacts_cooldown ON recruitment_contacts(org_id, player_id, channel, status, delivered_at);
CREATE INDEX recruitment_contacts_agent ON recruitment_contacts(routing_agent_user_id, player_id);
CREATE UNIQUE INDEX recruitment_contacts_request ON recruitment_contacts(request_id) WHERE request_id IS NOT NULL;

-- source: db.recruitmentContacts[].attempts[]  created at m23/contactRoutes.mjs:465 (failed) and :489 (ok)
-- owner/writer: m23/contactRoutes.mjs send   lifecycle: append-only
-- mapping: (list position, 1-based) -> seq   at -> at   ok -> ok   code -> code ('TRANSPORT_REFUSED' | NULL)
-- notes: `attempts.length` is what views and history detail read.
CREATE TABLE contact_attempts (
  contact_id TEXT NOT NULL REFERENCES recruitment_contacts(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0,1)),
  code TEXT,
  PRIMARY KEY (contact_id, seq)
) STRICT;

-- source: db.recruitmentContacts[].history[]  created at m23/contactRoutes.mjs:61 record()
-- owner/writer: m23/contactRoutes.mjs   lifecycle: append-only; paged at 100
-- mapping: id -> id (aud-<n>)   at -> at   by {kind,userId,name} | {kind,name} (response) -> by_kind, by_id, by_name   action -> action   detail -> detail_json
-- notes: the response entry carries no id and a literal name ('Guardian'/'Player').
CREATE TABLE contact_history (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES recruitment_contacts(id) ON DELETE RESTRICT,
  at INTEGER NOT NULL,
  by_kind TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','guardian','system')),
  by_id TEXT,
  by_name TEXT,                                      -- snapshot
  action TEXT NOT NULL,
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;
CREATE INDEX contact_history_contact_at ON contact_history(contact_id, at);

-- =============================================================================
-- recruitment_offers  (M23 P6 canonical Offer: container + exact revisions + responses)
-- =============================================================================
-- source: db.recruitmentOffers  created at m28/index.mjs:334 (store created by the module at boot, no migration)
-- owner/writer: m28/index.mjs (draft, edit, issue, withdraw, revise, recipient accept/decline, share-agent, read receipts,
--         onPlayerDeleted)   lifecycle: `status` mirrors the CURRENT revision's STORED status (DRAFT|ISSUED|ACCEPTED|
--         DECLINED|WITHDRAWN); EXPIRED is derived at read (effectiveRevisionStatus); never deleted; subject removal nulls
--         player-authored names/reasons and sets subject_removed_at
-- mapping:
--   id -> id (rof-<n>)   orgId -> org_id   caseId -> case_id   playerId -> player_id   type -> type
--   decisionId -> decision_id (room_decisions.id of the finalized progress decision the evidence provider named; NULL if none)
--   transactionId -> transaction_id (agent_transactions(id), file 06, no FK)
--   status -> status   currentRevisionId -> current_revision_id
--   revisions[] -> offer_revisions   responses[] -> offer_responses   readReceipts[] -> offer_read_receipts
--   agentShare {agentUserId, agreementId, at, by{kind:'player', id}}|null -> agent_share_user_id, agent_share_agreement_id
--            (representation_agreements(id), file 06, no FK), agent_share_at, agent_share_by_id (by.kind is always 'player': derived, not stored)
--   keys {create, issue[], withdraw[], revise[]} -> idempotency_keys
--   lifecycle (the LAST advanceCase effect: {applied, action, from, to, at} or {applied:false, action, reason, message?, allowed?, from, to, at})
--            -> lifecycle_applied, lifecycle_action, lifecycle_from, lifecycle_to, lifecycle_reason, lifecycle_message,
--               lifecycle_allowed_json (retained JSON: the validator's edge list echoed on a refused withdraw; display only)
--   history[] -> offer_history   createdAt -> created_at   createdBy {kind,id,name,role} -> created_by_user_id, created_by_name, created_by_role
--   updatedAt -> updated_at   rev/revAt/revBy -> rev, rev_at, rev_by_user_id, rev_by_name   policyVersion -> policy_version
--   subjectRemovedAt -> subject_removed_at
-- notes: one LIVE (DRAFT|ISSUED) offer per case is enforced by code (liveOfferOf) — partial unique index is NEW.
--   Reads: by (case_id, org_id); by player_id for the recipient (filtered by the live revision's recipient snapshot);
--   by (player_id, agent_share_user_id) for the agent. Recipient view never carries internal_note or decision_id.
CREATE TABLE recruitment_offers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'direct_recruitment' CHECK (type IN ('direct_recruitment')),
  decision_id TEXT REFERENCES room_decisions(id) ON DELETE SET NULL,
  transaction_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','ISSUED','ACCEPTED','DECLINED','WITHDRAWN')),
  current_revision_id TEXT NOT NULL REFERENCES offer_revisions(id) ON DELETE RESTRICT,
  agent_share_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  agent_share_agreement_id TEXT,
  agent_share_at INTEGER,
  agent_share_by_id TEXT,
  lifecycle_applied INTEGER CHECK (lifecycle_applied IS NULL OR lifecycle_applied IN (0,1)),
  lifecycle_action TEXT,
  lifecycle_from TEXT,
  lifecycle_to TEXT,
  lifecycle_reason TEXT,
  lifecycle_message TEXT,
  lifecycle_allowed_json TEXT CHECK (lifecycle_allowed_json IS NULL OR json_valid(lifecycle_allowed_json)),
  lifecycle_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name TEXT,                              -- snapshot
  created_by_role TEXT,                              -- snapshot
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  rev_at INTEGER,
  rev_by_user_id TEXT,
  rev_by_name TEXT,                                  -- snapshot
  policy_version INTEGER NOT NULL DEFAULT 1,
  subject_removed_at INTEGER,
  CHECK ((agent_share_user_id IS NULL) = (agent_share_at IS NULL))
) STRICT;
CREATE INDEX recruitment_offers_case_org_created ON recruitment_offers(case_id, org_id, created_at);
CREATE INDEX recruitment_offers_player_updated ON recruitment_offers(player_id, updated_at);
CREATE INDEX recruitment_offers_agent_share ON recruitment_offers(agent_share_user_id, player_id);
CREATE UNIQUE INDEX recruitment_offers_one_live_per_case ON recruitment_offers(case_id)
  WHERE status IN ('DRAFT','ISSUED');

-- source: db.recruitmentOffers[].revisions[]  created at m28/index.mjs:326 (revision 1) and :569 (revise)
-- owner/writer: m28/index.mjs   lifecycle: DRAFT editable under its own rev; ISSUE freezes it; later statuses are
--         terminal for the revision (ACCEPTED, DECLINED, WITHDRAWN, SUPERSEDED); EXPIRED is DERIVED and never stored;
--         <= 20 per offer; never deleted
-- mapping: id -> id (rofr-<n>)   revisionNumber -> revision_number   status -> status
--   terms {offerType, role, squad, startDate, endDate, conditions} -> term_offer_type, term_role (<= 80), term_squad (<= 80),
--            term_start_date, term_end_date, term_conditions (<= 1000)   (NO fee / compensation field exists)
--   recipientMessage -> recipient_message (<= 2000)   internalNote -> internal_note (<= 2000, club-private)
--   documents[] -> offer_revision_documents   expiresAt -> expires_at
--   createdAt -> created_at   createdBy -> created_by_user_id, created_by_name, created_by_role   updatedAt -> updated_at
--   updatedBy -> updated_by_user_id, updated_by_name, updated_by_role
--   issuedAt -> issued_at   issuedBy -> issued_by_user_id, issued_by_name, issued_by_role
--   withdrawnAt -> withdrawn_at   withdrawnBy (NULL when discarded by a response) -> withdrawn_by_user_id, withdrawn_by_name, withdrawn_by_role
--   withdrawReason -> withdraw_reason (<= 400)   respondedAt -> responded_at   response {id} -> response_id
--   supersedesRevisionId -> supersedes_revision_id   supersededByRevisionId -> superseded_by_revision_id   supersededAt -> superseded_at
--   discardedByResponseId -> discarded_by_response_id   recipientSnapshot {type, playerId, guardianId, minor, at} ->
--            recipient_type, recipient_guardian_id, recipient_minor, recipient_at (playerId == offer.player_id: derived)
--   readinessSnapshot {transactionId, evaluatedAt, status, blockers[]}|null -> readiness_transaction_id, readiness_evaluated_at,
--            readiness_status, readiness_blockers_json (always [] today; retained JSON)
--   rev/revAt/revBy -> rev, rev_at, rev_by_user_id, rev_by_name
-- notes: UNIQUE (offer_id, revision_number). Integrity rules (issued_at/expires_at on issued-like rows,
--   temporal order) are checked by offerIntegrity on read, not by CHECKs.
CREATE TABLE offer_revisions (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','ISSUED','ACCEPTED','DECLINED','WITHDRAWN','SUPERSEDED')),
  term_offer_type TEXT NOT NULL DEFAULT 'direct_recruitment' CHECK (term_offer_type IN ('direct_recruitment')),
  term_role TEXT CHECK (term_role IS NULL OR length(term_role) <= 80),
  term_squad TEXT CHECK (term_squad IS NULL OR length(term_squad) <= 80),
  term_start_date TEXT CHECK (term_start_date IS NULL OR length(term_start_date) = 10),
  term_end_date TEXT CHECK (term_end_date IS NULL OR length(term_end_date) = 10),
  term_conditions TEXT CHECK (term_conditions IS NULL OR length(term_conditions) <= 1000),
  recipient_message TEXT CHECK (recipient_message IS NULL OR length(recipient_message) <= 2000),
  internal_note TEXT CHECK (internal_note IS NULL OR length(internal_note) <= 2000),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name TEXT,                              -- snapshot
  created_by_role TEXT,                              -- snapshot
  updated_at INTEGER,
  updated_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  updated_by_name TEXT,                              -- snapshot
  updated_by_role TEXT,                              -- snapshot
  issued_at INTEGER,
  issued_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  issued_by_name TEXT,                               -- snapshot
  issued_by_role TEXT,                               -- snapshot
  withdrawn_at INTEGER,
  withdrawn_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  withdrawn_by_name TEXT,                            -- snapshot
  withdrawn_by_role TEXT,                            -- snapshot
  withdraw_reason TEXT CHECK (withdraw_reason IS NULL OR length(withdraw_reason) <= 400),
  responded_at INTEGER,
  response_id TEXT REFERENCES offer_responses(id) ON DELETE RESTRICT,
  supersedes_revision_id TEXT REFERENCES offer_revisions(id) ON DELETE RESTRICT,
  superseded_by_revision_id TEXT REFERENCES offer_revisions(id) ON DELETE RESTRICT,
  superseded_at INTEGER,
  discarded_by_response_id TEXT REFERENCES offer_responses(id) ON DELETE RESTRICT,
  recipient_type TEXT CHECK (recipient_type IS NULL OR recipient_type IN ('player','guardian')),
  recipient_guardian_id TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  recipient_minor INTEGER CHECK (recipient_minor IS NULL OR recipient_minor IN (0,1)),
  recipient_at INTEGER,
  readiness_transaction_id TEXT,
  readiness_evaluated_at INTEGER,
  readiness_status TEXT,
  readiness_blockers_json TEXT CHECK (readiness_blockers_json IS NULL OR json_valid(readiness_blockers_json)),
  rev INTEGER NOT NULL DEFAULT 1,
  rev_at INTEGER,
  rev_by_user_id TEXT,
  rev_by_name TEXT,                                  -- snapshot
  UNIQUE (offer_id, revision_number),
  CHECK (term_start_date IS NULL OR term_end_date IS NULL OR term_start_date < term_end_date)
) STRICT;
CREATE INDEX offer_revisions_offer_status ON offer_revisions(offer_id, status);

-- source: db.recruitmentOffers[].revisions[].documents[]  created at m28/index.mjs:179 (resolveDocuments) and :565 (copied on revise with NEW ids)
-- owner/writer: m28/index.mjs   lifecycle: replaced wholesale when a draft's documents are edited; immutable once issued; <= 10
-- mapping: id -> id (rofd-<n>)   evidenceId -> evidence_id (ver_evidence(id), file 05, no FK; must be the club's own vault row)
--   label -> label (<= 120)   mime -> mime (snapshot of the vault row)   bytes -> bytes (snapshot)
-- notes: no bytes are stored here; the recipient document route re-reads the vault and checks orgId.
CREATE TABLE offer_revision_documents (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES offer_revisions(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL,
  label TEXT CHECK (label IS NULL OR length(label) <= 120),
  mime TEXT,
  bytes INTEGER,
  UNIQUE (revision_id, evidence_id)
) STRICT;

-- source: db.recruitmentOffers[].responses[]  created at m28/index.mjs:742
-- owner/writer: m28/index.mjs respondHandler   lifecycle: append-only; one per revision; subject removal nulls
--         actorName and reason on player-authored rows
-- mapping: id -> id (rofa-<n>)   revisionId -> revision_id (UNIQUE)   responseType -> response_type   actorType -> actor_type
--   actorId -> actor_id (players(id) or guardians(id) by actor_type; no FK)   actorName -> actor_name (snapshot)
--   forPlayerId -> for_player_id   occurredAt -> occurred_at   reason -> reason (<= 400, declined only)
--   clientKey -> client_key (the recipient's replay key, searched per offer: `responses.find(x => x.clientKey === key)`)
-- notes: responderMatches re-checks the actor against the revision's recipient snapshot on every read.
CREATE TABLE offer_responses (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL UNIQUE REFERENCES offer_revisions(id) ON DELETE RESTRICT,
  response_type TEXT NOT NULL CHECK (response_type IN ('accepted','declined')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('player','guardian')),
  actor_id TEXT NOT NULL,
  actor_name TEXT,                                   -- snapshot
  for_player_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 400),
  client_key TEXT CHECK (client_key IS NULL OR length(client_key) <= 64)
) STRICT;
CREATE UNIQUE INDEX offer_responses_offer_client_key ON offer_responses(offer_id, client_key)
  WHERE client_key IS NOT NULL;

-- source: db.recruitmentOffers[].readReceipts[]  created at m28/index.mjs:654 (markViewed)
-- owner/writer: m28/index.mjs recipient list/read   lifecycle: write-once per (revision, viewer); a fact about delivery, never a status
-- mapping: revisionId -> revision_id   viewerKind -> viewer_kind   viewerId -> viewer_id   firstViewedAt -> first_viewed_at
-- notes: the club view reads only MIN(first_viewed_at) per offer.
CREATE TABLE offer_read_receipts (
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES offer_revisions(id) ON DELETE CASCADE,
  viewer_kind TEXT NOT NULL CHECK (viewer_kind IN ('player','guardian')),
  viewer_id TEXT NOT NULL,
  first_viewed_at INTEGER NOT NULL,
  PRIMARY KEY (revision_id, viewer_kind, viewer_id)
) STRICT;
CREATE INDEX offer_read_receipts_offer ON offer_read_receipts(offer_id, first_viewed_at);

-- source: db.recruitmentOffers[].history[]  created at m28/index.mjs:78 hist()
-- owner/writer: m28/index.mjs   lifecycle: append-only; paged at 200; recipient view filters /draft|internal/ actions;
--         subject removal nulls by.name on player entries
-- mapping: id -> id (aud-<n>)   at -> at   by {kind,id,name} -> by_kind, by_id, by_name   action -> action   detail -> detail_json ({revisionId,...})
CREATE TABLE offer_history (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE RESTRICT,
  at INTEGER NOT NULL,
  by_kind TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','guardian','system')),
  by_id TEXT,
  by_name TEXT,                                      -- snapshot
  action TEXT NOT NULL,
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;
CREATE INDEX offer_history_offer_at ON offer_history(offer_id, at);

-- =============================================================================
-- signing_packages  (M23 P7 signing workflow over an ACCEPTED Offer revision)
-- =============================================================================
-- source: db.signingPackages  created at m29/index.mjs:404 (store guaranteed by migration m280_001, schema 2308)
-- owner/writer: m29/index.mjs (start, PATCH draft, document, ready, party completion, executed document, complete,
--         cancel, void, supersede, T&S void, onPlayerDeleted)
--         lifecycle: stored status DRAFT|READY|IN_PROGRESS|COMPLETED|CANCELLED|VOIDED; EXPIRED is derived from
--         expires_at on live rows (never stored); SUPERSEDED is a REVISION status only; never deleted
-- mapping:
--   id -> id (spk-<n>)   orgId -> org_id   caseId -> case_id   playerId -> player_id   offerId -> offer_id
--   offerRevisionId -> offer_revision_id (the ACCEPTED revision)   transactionId -> transaction_id (agent_transactions(id), file 06, no FK)
--   status -> status   currentRevisionId -> current_revision_id   revisions[] -> signing_revisions
--   expiresAt -> expires_at   internalNote -> internal_note (<= 2000, club-private)
--   keys {start, ready[], party[], cancel[], void[], supersede[], complete[]} -> idempotency_keys
--   history[] -> signing_history
--   completion {signingId, completedAt, completedBy{kind,id,name,role}, contract{startDate,endDate}, documentSha256,
--            lifecycle{from,to,at}}|null -> completion_signing_id, completion_completed_at, completion_by_user_id,
--            completion_by_name, completion_by_role, completion_contract_start_date, completion_contract_end_date,
--            completion_document_sha256, completion_lifecycle_from, completion_lifecycle_to, completion_lifecycle_at
--   cancelledAt / cancelledBy / cancelReason -> cancelled_at, cancelled_by_user_id, cancelled_by_name, cancel_reason (<= 500)
--   voidedAt / voidedBy {kind org|admin, id, name} / voidReason -> voided_at, voided_by_kind, voided_by_id, voided_by_name, void_reason
--   createdAt -> created_at   createdBy -> created_by_user_id, created_by_name, created_by_role   updatedAt -> updated_at
--   rev/revAt/revBy -> rev, rev_at, rev_by_user_id, rev_by_name   policyVersion -> policy_version   subjectRemovedAt -> subject_removed_at
-- notes: one LIVE package per offer and one COMPLETED package per offer are enforced by code (canStart) —
--   the two partial unique indexes are NEW. Reads: by (case_id, org_id), by (offer_id, org_id), by player_id
--   for the recipient (only revisions with ready_at).
CREATE TABLE signing_packages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE RESTRICT,
  offer_revision_id TEXT NOT NULL REFERENCES offer_revisions(id) ON DELETE RESTRICT,
  transaction_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','READY','IN_PROGRESS','COMPLETED','CANCELLED','VOIDED')),
  current_revision_id TEXT NOT NULL REFERENCES signing_revisions(id) ON DELETE RESTRICT,
  expires_at INTEGER,
  internal_note TEXT CHECK (internal_note IS NULL OR length(internal_note) <= 2000),
  completion_signing_id TEXT REFERENCES signings(id) ON DELETE RESTRICT,
  completion_completed_at INTEGER,
  completion_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  completion_by_name TEXT,                           -- snapshot
  completion_by_role TEXT,                           -- snapshot
  completion_contract_start_date TEXT CHECK (completion_contract_start_date IS NULL OR length(completion_contract_start_date) = 10),
  completion_contract_end_date TEXT CHECK (completion_contract_end_date IS NULL OR length(completion_contract_end_date) = 10),
  completion_document_sha256 TEXT CHECK (completion_document_sha256 IS NULL OR length(completion_document_sha256) = 64),
  completion_lifecycle_from TEXT,
  completion_lifecycle_to TEXT,
  completion_lifecycle_at INTEGER,
  cancelled_at INTEGER,
  cancelled_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  cancelled_by_name TEXT,                            -- snapshot
  cancel_reason TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
  voided_at INTEGER,
  voided_by_kind TEXT CHECK (voided_by_kind IS NULL OR voided_by_kind IN ('org','admin')),
  voided_by_id TEXT,
  voided_by_name TEXT,                               -- snapshot
  void_reason TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 500),
  created_at INTEGER NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name TEXT,                              -- snapshot
  created_by_role TEXT,                              -- snapshot
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  rev_at INTEGER,
  rev_by_user_id TEXT,
  rev_by_name TEXT,                                  -- snapshot
  policy_version INTEGER NOT NULL DEFAULT 1,
  subject_removed_at INTEGER,
  CHECK ((status = 'COMPLETED') = (completion_signing_id IS NOT NULL))
) STRICT;
CREATE INDEX signing_packages_case_org_created ON signing_packages(case_id, org_id, created_at);
CREATE INDEX signing_packages_offer_org ON signing_packages(offer_id, org_id);
CREATE INDEX signing_packages_player_updated ON signing_packages(player_id, updated_at);
CREATE UNIQUE INDEX signing_packages_one_live_per_offer ON signing_packages(offer_id)
  WHERE status IN ('DRAFT','READY','IN_PROGRESS');
CREATE UNIQUE INDEX signing_packages_one_completed_per_offer ON signing_packages(offer_id)
  WHERE status = 'COMPLETED';

-- source: db.signingPackages[].revisions[]  created at m29/index.mjs:397 (revision 1) and :701 (supersede)
-- owner/writer: m29/index.mjs   lifecycle: DRAFT -> READY -> IN_PROGRESS -> COMPLETED | CANCELLED | VOIDED | SUPERSEDED; never deleted
-- mapping: id -> id (spr-<n>)   revisionNumber -> revision_number   status -> status
--   createdAt -> created_at   createdBy -> created_by_user_id, created_by_name, created_by_role
--   readyAt -> ready_at   readyBy -> ready_by_user_id, ready_by_name, ready_by_role
--   completedAt -> completed_at   completedBy -> completed_by_user_id, completed_by_name, completed_by_role   supersededAt -> superseded_at
--   document -> signing_documents (kind 'signing')   executedDocument -> signing_documents (kind 'executed')
--   contract {startDate, endDate} -> contract_start_date, contract_end_date
--   requiredParties[] -> signing_revision_parties
--   policySnapshot {policyVersion, jurisdiction, offerPolicyVersion} -> policy_version, policy_jurisdiction, policy_offer_policy_version
--   supersedesRevisionId -> supersedes_revision_id   supersededByRevisionId -> superseded_by_revision_id
-- notes: UNIQUE (package_id, revision_number); a presented revision (READY+) must have a document (integrity, not CHECK).
CREATE TABLE signing_revisions (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES signing_packages(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','READY','IN_PROGRESS','COMPLETED','CANCELLED','VOIDED','SUPERSEDED')),
  created_at INTEGER NOT NULL,
  created_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name TEXT,                              -- snapshot
  created_by_role TEXT,                              -- snapshot
  ready_at INTEGER,
  ready_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  ready_by_name TEXT,                                -- snapshot
  ready_by_role TEXT,                                -- snapshot
  completed_at INTEGER,
  completed_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  completed_by_name TEXT,                            -- snapshot
  completed_by_role TEXT,                            -- snapshot
  superseded_at INTEGER,
  contract_start_date TEXT CHECK (contract_start_date IS NULL OR length(contract_start_date) = 10),
  contract_end_date TEXT CHECK (contract_end_date IS NULL OR length(contract_end_date) = 10),
  policy_version INTEGER,
  policy_jurisdiction TEXT,
  policy_offer_policy_version INTEGER,
  supersedes_revision_id TEXT REFERENCES signing_revisions(id) ON DELETE RESTRICT,
  superseded_by_revision_id TEXT REFERENCES signing_revisions(id) ON DELETE RESTRICT,
  UNIQUE (package_id, revision_number)
) STRICT;

-- source: db.signingPackages[].revisions[].document and .executedDocument  created at m29/index.mjs:181 (storeDocument)
-- owner/writer: m29/index.mjs (attach on DRAFT — re-attaching REPLACES the object; executed document on READY/IN_PROGRESS)
--         lifecycle: one 'signing' and one 'executed' per revision; the vault row (ver_evidence) is never removed
-- mapping: id -> id (sgd-<n> | sgx-<n>)   kind (which field) -> kind   evidenceId -> evidence_id (ver_evidence(id), file 05, no FK)
--   sha256 -> sha256 (the digest every party confirms)   filename -> filename   mime -> mime   bytes -> bytes   label -> label (<= 120)
--   uploadedAt -> uploaded_at   uploadedBy {kind,id,name,role} -> uploaded_by_user_id, uploaded_by_name, uploaded_by_role
-- notes: documentBytesProblem re-hashes the vault bytes against sha256 before present/confirm/complete/serve.
CREATE TABLE signing_documents (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES signing_revisions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('signing','executed')),
  evidence_id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  filename TEXT,
  mime TEXT,
  bytes INTEGER,
  label TEXT CHECK (label IS NULL OR length(label) <= 120),
  uploaded_at INTEGER NOT NULL,
  uploaded_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  uploaded_by_name TEXT,                             -- snapshot
  uploaded_by_role TEXT,                             -- snapshot
  UNIQUE (revision_id, kind)
) STRICT;

-- source: db.signingPackages[].revisions[].requiredParties[]  created at m29/signing.mjs:113 (requiredPartiesFor), completed at m29/index.mjs:537
-- owner/writer: m29/index.mjs completeParty   lifecycle: PENDING -> COMPLETED; a superseded revision keeps its parties as evidence
-- mapping: partyType -> party_type   forEntityId -> for_entity_id (players(id) | guardians(id) | orgs(id) by party_type; polymorphic, no FK)
--   forPlayerId -> for_player_id   status -> status   completedAt -> completed_at
--   completedBy {kind,id,name} -> completed_by_kind, completed_by_id, completed_by_name (name NULL after subject removal for player rows)
--   method -> method   evidenceRef {kind, id sgev-*, revisionId, documentSha256, at, actorKind, actorId, session} ->
--            evidence_ref_kind, evidence_ref_id, evidence_document_sha256, evidence_at, evidence_actor_kind, evidence_actor_id,
--            evidence_session (evidenceRef.revisionId == revision_id: derived, integrity-checked, not stored)
-- notes: exactly one recipient party (PLAYER xor GUARDIAN) and one CLUB_SIGNATORY per revision — PRIMARY KEY (revision_id, party_type)
--   covers duplicates; the xor is an integrity rule. Only PLATFORM_ACKNOWLEDGMENT is written by this build.
CREATE TABLE signing_revision_parties (
  revision_id TEXT NOT NULL REFERENCES signing_revisions(id) ON DELETE CASCADE,
  party_type TEXT NOT NULL CHECK (party_type IN ('PLAYER','GUARDIAN','CLUB_SIGNATORY')),
  for_entity_id TEXT NOT NULL,
  for_player_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED')),
  completed_at INTEGER,
  completed_by_kind TEXT CHECK (completed_by_kind IS NULL OR completed_by_kind IN ('player','guardian','org')),
  completed_by_id TEXT,
  completed_by_name TEXT,                            -- snapshot
  method TEXT CHECK (method IS NULL OR method IN ('PLATFORM_ACKNOWLEDGMENT','UPLOAD_EXECUTED_DOCUMENT')),
  evidence_ref_kind TEXT CHECK (evidence_ref_kind IS NULL OR evidence_ref_kind IN ('platform_acknowledgment')),
  evidence_ref_id TEXT,
  evidence_document_sha256 TEXT CHECK (evidence_document_sha256 IS NULL OR length(evidence_document_sha256) = 64),
  evidence_at INTEGER,
  evidence_actor_kind TEXT,
  evidence_actor_id TEXT,
  evidence_session TEXT,
  PRIMARY KEY (revision_id, party_type),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
) STRICT;
CREATE INDEX signing_revision_parties_entity ON signing_revision_parties(party_type, for_entity_id);

-- source: db.signingPackages[].history[]  created at m29/index.mjs:76 hist()
-- owner/writer: m29/index.mjs   lifecycle: append-only; recipient view filters /draft|note|internal/ and hides org names;
--         subject removal nulls by.name on player entries
-- mapping: id -> id (aud-<n>)   at -> at   by {kind,id,name} -> by_kind, by_id, by_name   action -> action   detail -> detail_json
CREATE TABLE signing_history (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES signing_packages(id) ON DELETE RESTRICT,
  at INTEGER NOT NULL,
  by_kind TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','guardian','admin','system')),
  by_id TEXT,
  by_name TEXT,                                      -- snapshot
  action TEXT NOT NULL,
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;
CREATE INDEX signing_history_package_at ON signing_history(package_id, at);

-- =============================================================================
-- signings  (the completed signing record: canonical completion or legacy recording)
-- =============================================================================
-- source: db.signings  created ONLY at m29/index.mjs:273 (recordCompletedSigning; shapes from m29/signing.mjs:471
--         completedSigningRecord and the legacy literal at m29/index.mjs:268); rows older than M29 carry the legacy
--         shape without method/contract/package fields
-- owner/writer: m29/index.mjs recordCompletedSigning (also appends the ledger row, issues the invoice through the
--         billing adapter, sets players.level/contractStatus/availability/timeline and orgs.squad)
--         lifecycle: immutable; never deleted; kept whole on subject removal INCLUDING player_name (known gap)
-- mapping: id -> id (sign-<n>)   playerId -> player_id   playerName -> player_name (snapshot, retained after deletion)
--   orgId -> org_id   orgName -> org_name (snapshot)   userId -> user_id   scoutName -> scout_name (snapshot)
--   ts -> ts (ledger instant for legacy rows; = signedAt)   signedAt -> signed_at
--   firstQualifyingInteraction (a COPY of the first ledger row {id, ts, type, ...}) -> first_qualifying_ledger_id (ledger(id), file 03,
--            no FK), first_qualifying_at, first_qualifying_type; its orgName/userId/scoutName copies are derived via the ledger row
--   attributionWindowMonths -> attribution_window_months   insideAttributionWindow -> inside_attribution_window
--   method -> method (rows without one migrate as LEGACY_RECORDED)   note (legacy, <= 400) -> note
--   signingPackageId -> signing_package_id   signingRevisionId -> signing_revision_id   signingRevisionNumber -> signing_revision_number
--   caseId -> case_id   offerId -> offer_id   offerRevisionId -> offer_revision_id   transactionId -> transaction_id (file 06, no FK)
--   documentSha256 -> document_sha256   documentEvidenceId -> document_evidence_id   executedDocumentEvidenceId -> executed_document_evidence_id (ver_evidence(id), file 05, no FK)
--   contract {startDate, endDate} -> contract_start_date, contract_end_date   parties[] -> signing_parties   policyVersion -> policy_version
--   cancelledAt / revokedAt / voidedAt -> dead fields, not migrated (read at server.mjs:2612, never written anywhere)
-- notes: three uniqueness rules the code keeps: one row per package, one per offer (P7.1 §20), one STANDING legacy
--   row per (org, player) (server.mjs:2612) — all three as partial unique indexes (enforced by code today).
--   invoices.signing_id (another file) is unique per signing. Reads: by org (list), by player (follow-ups),
--   by signing_package_id / offer_id (consistency), by (org_id, player_id) legacy lookups.
CREATE TABLE signings (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  player_name TEXT,                                  -- snapshot; personal data retained after deletion
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name TEXT,                                     -- snapshot
  user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  scout_name TEXT,                                   -- snapshot
  ts INTEGER NOT NULL,
  signed_at INTEGER,
  first_qualifying_ledger_id TEXT,
  first_qualifying_at INTEGER,
  first_qualifying_type TEXT,
  attribution_window_months INTEGER,
  inside_attribution_window INTEGER NOT NULL DEFAULT 0 CHECK (inside_attribution_window IN (0,1)),
  method TEXT NOT NULL DEFAULT 'LEGACY_RECORDED' CHECK (method IN ('CANONICAL_COMPLETION','LEGACY_RECORDED')),
  note TEXT CHECK (note IS NULL OR length(note) <= 400),
  signing_package_id TEXT REFERENCES signing_packages(id) ON DELETE RESTRICT,
  signing_revision_id TEXT REFERENCES signing_revisions(id) ON DELETE RESTRICT,
  signing_revision_number INTEGER,
  case_id TEXT REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  offer_id TEXT REFERENCES recruitment_offers(id) ON DELETE RESTRICT,
  offer_revision_id TEXT REFERENCES offer_revisions(id) ON DELETE RESTRICT,
  transaction_id TEXT,
  document_sha256 TEXT CHECK (document_sha256 IS NULL OR length(document_sha256) = 64),
  document_evidence_id TEXT,
  executed_document_evidence_id TEXT,
  contract_start_date TEXT CHECK (contract_start_date IS NULL OR length(contract_start_date) = 10),
  contract_end_date TEXT CHECK (contract_end_date IS NULL OR length(contract_end_date) = 10),
  policy_version INTEGER,
  CHECK ((method = 'CANONICAL_COMPLETION') = (signing_package_id IS NOT NULL))
) STRICT;
CREATE INDEX signings_org_ts ON signings(org_id, ts);
CREATE INDEX signings_player ON signings(player_id);
CREATE INDEX signings_org_player ON signings(org_id, player_id);
CREATE UNIQUE INDEX signings_one_per_package ON signings(signing_package_id) WHERE signing_package_id IS NOT NULL;
CREATE UNIQUE INDEX signings_one_per_offer ON signings(offer_id) WHERE offer_id IS NOT NULL;
CREATE UNIQUE INDEX signings_one_legacy_per_org_player ON signings(org_id, player_id) WHERE signing_package_id IS NULL;

-- source: db.signings[].parties[]  created at m29/signing.mjs:482 (completedSigningRecord)
-- owner/writer: m29/index.mjs recordCompletedSigning   lifecycle: immutable; canonical rows only
-- mapping: partyType -> party_type   method -> method   completedAt -> completed_at   byKind -> by_kind
-- notes: a provenance SUMMARY of signing_revision_parties at completion; never a name.
CREATE TABLE signing_parties (
  signing_id TEXT NOT NULL REFERENCES signings(id) ON DELETE CASCADE,
  party_type TEXT NOT NULL CHECK (party_type IN ('PLAYER','GUARDIAN','CLUB_SIGNATORY')),
  method TEXT CHECK (method IS NULL OR method IN ('PLATFORM_ACKNOWLEDGMENT','UPLOAD_EXECUTED_DOCUMENT')),
  completed_at INTEGER,
  by_kind TEXT CHECK (by_kind IS NULL OR by_kind IN ('player','guardian','org')),
  PRIMARY KEY (signing_id, party_type)
) STRICT;

-- =============================================================================
-- Post-signing outcomes (M12 F11)
-- =============================================================================
-- source: db.followUps  created at m12/operations.mjs:33 (scheduleFollowUps, run by the sweep for EVERY signing)
-- owner/writer: m12/operations.mjs (sweep: scheduled -> due, notifiedAt; report route: -> complete; admin dueAt edit)
--         lifecycle: scheduled -> due -> complete; never deleted; kept after player deletion ('departed player')
-- mapping: id -> id (fup-<n>)   signingId -> signing_id   playerId -> player_id   orgId -> org_id   milestone -> milestone
--   dueAt -> due_at (signedAt + 91/182/365 d; admin may move it)   status -> status   notifiedAt -> notified_at   createdAt -> created_at
-- notes: UNIQUE (signing_id, milestone) enforced by code (idempotent scheduling). Reads: by org (sorted due_at),
--   by player (own list), by guardian child ids, sweep scan on (status, due_at).
CREATE TABLE follow_ups (
  id TEXT PRIMARY KEY,
  signing_id TEXT NOT NULL REFERENCES signings(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  milestone TEXT NOT NULL CHECK (milestone IN ('3m','6m','12m')),
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','due','complete')),
  notified_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (signing_id, milestone)
) STRICT;
CREATE INDEX follow_ups_org_due ON follow_ups(org_id, due_at);
CREATE INDEX follow_ups_player ON follow_ups(player_id);
CREATE INDEX follow_ups_status_due ON follow_ups(status, due_at);

-- source: db.outcomeReports  created at m12/operations.mjs:69
-- owner/writer: m12/operations.mjs (org files once; player/guardian confirm or dispute)
--         lifecycle: reported -> confirmed | disputed (set by the latest confirmation); never deleted
-- mapping: id -> id (out-<n>)   followUpId -> follow_up_id (UNIQUE)   signingId -> signing_id   playerId -> player_id   orgId -> org_id
--   by {kind:'org', id, name} -> by_user_id, by_name   registrationStatus -> registration_status
--   matchesPlayed -> matches_played (NULL = not evidenced)   progression -> progression (<= 200)   endReason -> end_reason (<= 200)
--   note -> note (<= 300)   status -> status   confirmations[] -> outcome_report_confirmations   at -> at
-- notes: outcomeState (unknown_pending/not_due/disputed/confirmed/reported) is derived in followUpView, not stored.
--   Admin aggregates suppress orgs with < 3 signings.
CREATE TABLE outcome_reports (
  id TEXT PRIMARY KEY,
  follow_up_id TEXT NOT NULL UNIQUE REFERENCES follow_ups(id) ON DELETE RESTRICT,
  signing_id TEXT NOT NULL REFERENCES signings(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  by_name TEXT NOT NULL,                             -- snapshot
  registration_status TEXT NOT NULL CHECK (registration_status IN ('registered','released','left','unknown')),
  matches_played INTEGER,
  progression TEXT CHECK (progression IS NULL OR length(progression) <= 200),
  end_reason TEXT CHECK (end_reason IS NULL OR length(end_reason) <= 200),
  note TEXT CHECK (note IS NULL OR length(note) <= 300),
  status TEXT NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','confirmed','disputed')),
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX outcome_reports_org ON outcome_reports(org_id);

-- source: db.outcomeReports[].confirmations[]  created at m12/operations.mjs:97
-- owner/writer: m12/operations.mjs respondOutcome   lifecycle: append-only; one per actor id per report
-- mapping: by {kind, id, name} -> by_kind, by_id (players(id) | guardians(id) by by_kind; no FK), by_name (snapshot)
--   agree -> agree   note -> note (<= 300)   experienceRating -> experience_rating (1-5 | NULL)   at -> at
-- notes: PRIMARY KEY (report_id, by_id) is what ALREADY_RESPONDED enforces.
CREATE TABLE outcome_report_confirmations (
  report_id TEXT NOT NULL REFERENCES outcome_reports(id) ON DELETE CASCADE,
  by_kind TEXT NOT NULL CHECK (by_kind IN ('player','guardian')),
  by_id TEXT NOT NULL,
  by_name TEXT NOT NULL,                             -- snapshot
  agree INTEGER NOT NULL CHECK (agree IN (0,1)),
  note TEXT CHECK (note IS NULL OR length(note) <= 300),
  experience_rating INTEGER CHECK (experience_rating IS NULL OR experience_rating BETWEEN 1 AND 5),
  at INTEGER NOT NULL,
  PRIMARY KEY (report_id, by_id)
) STRICT;

-- not tables:
--   * In-memory / test-only state read by these modules: db.deliveryFailInject (contact/trial/decision failure
--     injection), the SCOUTBOX_TEST_CLOCK header clock, the development fault layer (faults.shouldFail),
--     rate-limit buckets (m181/rateLimit), SSE broadcasts and event registries, integrity logs.
--   * Code registries referenced by id: PROVIDERS (m16/drills.mjs, Box Cam providers incl. testOnly), the M16.2
--     trust-score component registry (room_snapshots.trust_component_levels_json keys), COMBINE_PROTOCOLS
--     (room_snapshot_source_refs 'combine_result' strings), ROOM_STATUSES / ROOM_TRANSITIONS /
--     STATUS_EVIDENCE_REQUIRED / REASON_CODES / RECOMMENDATIONS / SOURCE_CONTEXTS / TASK_STATES (m17/shared.mjs),
--     LIFECYCLE_ACTIONS (m23/lifecycle.mjs), CONTACT_* / TRIAL_* / DECISION_* / OFFER_* / SIGNING_* vocabularies and
--     limits, OUTCOME_MAP, MINOR_*_PATHWAY_ENABLED policy tables, HANDOFF_TTL_MS, MILESTONES (3m/6m/12m).
--   * Derived values never stored: case.stage when a Room exists (stageForRoomStatus), room health / readiness /
--     funnel / needs-attention, trial `not_recorded` attendance, deriveWorkflowState (stored copy is
--     integrity-checked only), trial report deadline (trialReportDueAt), offer / signing EXPIRED, handoff
--     'expired', contact cooldown, offer liveRevision / liveStatus, signing summaryForOffer, the recruitment
--     journey projection (m23/journey.mjs) and the evidence provider's answers (m23/evidence.mjs), follow-up
--     outcomeState, budget scenario totals (computeScenarioTotals), every `honest` / `note` disclaimer sentence.
--   * Stores in OTHER files that these tables point at: channels, ledger, outbox (03); evidence, assessments,
--     vacancies, combine_requests, evidence_suggestions (04); ver_evidence (05); agent_transactions,
--     representation_agreements (06); box_sessions, box_cam_cv_results (07); players.trialReports is the SAME object
--     as trial_reports and must not become a second table in 01.
