-- =============================================================================
-- 03_messaging_safety_audit.sql — ScoutBox target SQLite schema, part 3
--
-- Scope (source collections → tables):
--   channels            → channels, messages, message_attachments           (LIVE since migration 0012_channels, S7d, REGISTERED; explicit writes since S14c, 0012 amended in place)
--   notifications       → notifications                                    (migration 0009_notifications, S7a, REGISTERED; explicit since S14e)
--   notificationPrefs   → notification_prefs, notification_pref_categories  (migration 0009_notifications, S7a, REGISTERED; explicit since S14e)
--   dispatches          → dispatches, dispatch_attempts                  (LIVE since migration 0010_dispatches, S7b, REGISTERED; explicit writes since S14d, 0010 amended in place)
--   outbox              → outbox                                           (LIVE since migration 0011_outbox_push, S7c, REGISTERED; explicit writes since S14d, 0011 amended in place)
--   pushLog             → push_log                                         (LIVE since migration 0011_outbox_push, S7c, REGISTERED; explicit writes since S14d, 0011 amended in place)
--   pushTokens          → push_tokens                                      (LIVE since migration 0011_outbox_push, S7c, REGISTERED; explicit writes since S14d, 0011 amended in place)
--   blocks              → blocks                                           (LIVE since migration 0013_safety_audit, S6b, REGISTERED; explicit writes since S14b)
--   reports             → reports                                          (LIVE since migration 0013_safety_audit, S6b, REGISTERED; explicit writes since S14b)
--   moderationLog       → moderation_log, moderation_flags                 (LIVE since migration 0013_safety_audit, S6b, REGISTERED; explicit writes since S14b)
--   orgNotes            → org_notes                                        (LIVE since migration 0013_safety_audit, S6b, REGISTERED; explicit writes since S14b)
--   ledger              → ledger, ledger_protocols                         (LIVE since migration 0013_safety_audit, S6b, REGISTERED; explicit writes since S14b)
--   opsEvents           → ops_events                                       (LIVE since migration 0013_safety_audit, S6b, REGISTERED; explicit writes since S14b)
--   sourceChanges       → source_changes                                   (LIVE since migration 0013_safety_audit, S6b, REGISTERED; explicit writes since S14b)
--   emailChallenges     → email_challenges   (LIVE since migration 0008_one_time_codes, S6a, REGISTERED)
--   pairingCodes        → pairing_codes      (LIVE since migration 0008_one_time_codes, S6a, REGISTERED)
--   idvQueue            → idv_queue                                        (LIVE since migration 0013_safety_audit, S6b, REGISTERED; explicit writes since S14b)
--
-- Depends on 01_identity.sql: orgs(id), org_users(id), players(id), guardians(id)
-- Depends on 02_recruitment.sql: recruitment_requests(id), trials(id)
--
-- Timestamps are epoch milliseconds (INTEGER). Source fields literally named
-- `ts` / `at` are renamed per convention and the mapping line says so.
-- The eight audit tables (S6b, 0013) carry NO foreign key: today the server
-- hard-deletes the player row while keeping these rows with their now-unresolved
-- id, and the Founder's decision Q4 (19 October 2026) preserves exactly that —
-- the references are tolerant and COUNTED, never refused, invented or deleted.
-- The RESTRICT references the earlier drafts of this file proposed would have
-- refused that deletion; they stay OPEN for S4b (tombstones) and the foreign-key
-- step of the plan (§D.2a). The audit rows must outlive their subject either way.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- channels — LIVE since migration 0012_channels (S7d; explicit writes and SQL reads since S14c, when 0012 was
--   amended in place: repositories/channels.mjs).
-- One thread per accepted request (UNIQUE request_id). For a minor the counterparty is the guardian; the child is
-- never a party. "closed" is derived on every read (blocks, suspension, visibility), not stored.
-- owner/writer: repositories/channels.mjs `open` (the two acceptance routes, in their unit of work), `markRead`
--   (the three receipt routes) and `deleteForPlayer` (the account-deletion unit, D-B: a deleted player's threads go,
--   guardian threads included; retention stays open, S4b).
-- keys: request_id → recruitment_requests, org_id → orgs (RESTRICT). player_id and guardian_id carry no key
--   (tolerant, migration.md §4.3); `open` refuses a guardian that does not exist and every snapshot's final state is
--   checked for it.
-- last_activity_at: the creation time, then the newest message's; the organisation's inbox and the admin list page by
--   (last_activity_at, seq), most recently active first. The player's and guardian's lists are by seq.
-- The player, organisation and scout names and orgVerified are the request's, as they were when the thread opened.
-- -----------------------------------------------------------------------------
CREATE TABLE channels (
  seq                     INTEGER PRIMARY KEY,
  id                      TEXT NOT NULL UNIQUE CHECK (id IS NULL OR length(id) BETWEEN 1 AND 80),
  request_id              TEXT NOT NULL REFERENCES recruitment_requests(id) ON DELETE RESTRICT,
  player_id               TEXT NOT NULL CHECK (player_id IS NULL OR length(player_id) BETWEEN 1 AND 80),
  player_name             TEXT CHECK (player_name IS NULL OR length(player_name) BETWEEN 0 AND 300),
  org_id                  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name                TEXT NOT NULL CHECK (org_name IS NULL OR length(org_name) BETWEEN 0 AND 300),
  org_verified            INTEGER CHECK (org_verified IS NULL OR org_verified IN (0, 1)),
  scout_name              TEXT CHECK (scout_name IS NULL OR length(scout_name) BETWEEN 0 AND 300),
  scout_role              TEXT CHECK (scout_role IS NULL OR length(scout_role) BETWEEN 0 AND 300),
  counterparty            TEXT NOT NULL CHECK (counterparty IN ('player', 'guardian')),
  guardian_id             TEXT CHECK (guardian_id IS NULL OR length(guardian_id) BETWEEN 1 AND 80),
  created_at              INTEGER NOT NULL,
  last_activity_at        INTEGER NOT NULL,
  read_by_org_at          INTEGER,
  read_by_counterparty_at INTEGER,
  CHECK (last_activity_at >= created_at)
) STRICT;
CREATE UNIQUE INDEX channels_request_id ON channels (request_id);
CREATE INDEX channels_org_activity ON channels (org_id, last_activity_at, seq);
CREATE INDEX channels_activity ON channels (last_activity_at, seq);
CREATE INDEX channels_guardian_id ON channels (guardian_id);
CREATE INDEX channels_player_id_counterparty ON channels (player_id, counterparty);


-- -----------------------------------------------------------------------------
-- messages — LIVE since migration 0012_channels (S7d; amended in place in S14c)
-- owner/writer: repositories/channels.mjs `appendMessage`, called by server.mjs postMessage in one unit with the
--   message's ledger row and notifications. Append-only, in thread order (position); removed only with the thread.
-- sender: typed columns by kind. Staff (`org_user`) in sender_user_id, a RESTRICT key to org_users; a player or
--   guardian in sender_person_id (no key). sender_name is the name the route composed ("Name · Role · Org" for staff).
-- text: moderated before the write, 1–4,000 characters (the route refuses longer with FIELD_INVALID).
-- client_msg_id: the client's retry id, at most 64 characters, unique per thread and sender: a retry returns the
--   stored message.
-- -----------------------------------------------------------------------------
CREATE TABLE messages (
  seq              INTEGER PRIMARY KEY,
  id               TEXT NOT NULL UNIQUE CHECK (id IS NULL OR length(id) BETWEEN 1 AND 80),
  channel_id       TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL CHECK (position >= 0),
  created_at       INTEGER NOT NULL,
  sender_kind      TEXT NOT NULL CHECK (sender_kind IN ('player', 'guardian', 'org_user')),
  sender_user_id   TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  sender_person_id TEXT CHECK (sender_person_id IS NULL OR length(sender_person_id) BETWEEN 1 AND 80),
  sender_name      TEXT CHECK (sender_name IS NULL OR length(sender_name) BETWEEN 0 AND 300),
  text             TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  client_msg_id    TEXT CHECK (client_msg_id IS NULL OR length(client_msg_id) BETWEEN 1 AND 64),
  CHECK ((sender_kind = 'org_user' AND sender_user_id IS NOT NULL AND sender_person_id IS NULL)
      OR (sender_kind <> 'org_user' AND sender_person_id IS NOT NULL AND sender_user_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX messages_channel_position ON messages (channel_id, position);
CREATE UNIQUE INDEX messages_client_msg_id ON messages (channel_id, sender_kind, COALESCE(sender_user_id, sender_person_id), client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX messages_sender_user_id ON messages (sender_user_id);


-- -----------------------------------------------------------------------------
-- message_attachments — LIVE since migration 0012_channels (S7d)
-- owner/writer: repositories/channels.mjs `appendMessage` (0..1 per message). Immutable; removed with the message.
-- The CHECK ties each kind to its columns: a clip names the player's media item (no key: the clip may be deleted
-- later) with its title, url and verified flag as they were; a trial report names the report (no key) with the
-- club's name and the metrics line. An organisation may attach only a trial report it wrote (the route's rule).
-- -----------------------------------------------------------------------------
CREATE TABLE message_attachments (
  message_id    TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('clip', 'trial_report')),
  media_id      TEXT CHECK (media_id IS NULL OR length(media_id) BETWEEN 1 AND 80),
  title         TEXT CHECK (title IS NULL OR length(title) BETWEEN 0 AND 300),
  url           TEXT CHECK (url IS NULL OR length(url) BETWEEN 0 AND 2000),
  verified_clip INTEGER CHECK (verified_clip IS NULL OR verified_clip IN (0, 1)),
  report_id     TEXT CHECK (report_id IS NULL OR length(report_id) BETWEEN 1 AND 80),
  org_name      TEXT CHECK (org_name IS NULL OR length(org_name) BETWEEN 0 AND 300),
  summary       TEXT CHECK (summary IS NULL OR length(summary) BETWEEN 0 AND 500),
  CHECK ((kind = 'clip' AND media_id IS NOT NULL AND verified_clip IS NOT NULL AND report_id IS NULL AND org_name IS NULL AND summary IS NULL)
      OR (kind = 'trial_report' AND report_id IS NOT NULL AND media_id IS NULL AND title IS NULL AND url IS NULL AND verified_clip IS NULL))
) STRICT;


-- -----------------------------------------------------------------------------
-- notifications, notification_prefs, notification_pref_categories  (migration 0009_notifications, S7a; explicit
--   since S14e, amended in place — repositories/notifications.mjs, NOTIFICATIONS_DDL)
-- The in-app feed, one row per notification, and each person's category preferences. Written by server.mjs notify()
-- (create, or coalesce an identical unread notice whose last occurrence was within six hours) inside the unit of
-- work of the action it announces, or a transaction of its own; markRead; the account-deletion unit
-- (deleteForAudience; the preferences are kept, by decision); the acknowledgment (ack, with its dispatches); the
-- delivery centre's marker (markDispatched, with the dispatches it made); PUT /notification-preferences
-- (updatePrefs; the route refuses non-boolean values). Read through SQL: the feed newest insertion first (seq; a
-- coalesce refreshes occurred_at in place), unread and awaiting-acknowledgment counts, the undispatched notices.
-- The audience kind is player, guardian or org_user; a staff audience is a RESTRICT key to org_users through the
-- generated staff_id; player and guardian ids carry no key (tolerant). `groupKey` (type:refId) and
-- `actionRequired.ackedBy` (the audience's id) are worked out on read. `type` is an open set by design (an
-- unknown type is delivered and counted); `category` is the preference vocabulary
-- (domains/platform/notificationPrefs.mjs CATEGORY_NAMES). A stored mandatory category false is forced on by the
-- effective view.
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
  seq                INTEGER PRIMARY KEY,
  id                 TEXT NOT NULL UNIQUE CHECK (id IS NULL OR length(id) BETWEEN 1 AND 80),
  occurred_at        INTEGER NOT NULL,
  audience_kind      TEXT NOT NULL CHECK (audience_kind IN ('player', 'guardian', 'org_user')),
  audience_id        TEXT NOT NULL CHECK (audience_id IS NULL OR length(audience_id) BETWEEN 1 AND 80),
  staff_id           TEXT GENERATED ALWAYS AS (CASE WHEN audience_kind = 'org_user' THEN audience_id END) STORED REFERENCES org_users(id) ON DELETE RESTRICT,
  type               TEXT NOT NULL CHECK (type IS NULL OR length(type) BETWEEN 1 AND 80),
  text               TEXT NOT NULL CHECK (text IS NULL OR length(text) BETWEEN 1 AND 2000),
  ref_id             TEXT CHECK (ref_id IS NULL OR length(ref_id) BETWEEN 1 AND 200),
  read               INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
  repeat_count       INTEGER NOT NULL DEFAULT 1 CHECK (repeat_count >= 1),
  category           TEXT CHECK (category IS NULL OR category IN ('mentions', 'assignments', 'room_changes', 'evidence_requests', 'combine', 'trial_updates', 'second_look', 'brief_updates', 'messages', 'activity', 'discovery_nudges', 'watchlist_changes', 'development_updates', 'representation', 'compliance', 'transaction_updates', 'offer_updates', 'signing_updates', 'security_account')),
  deferred_push      INTEGER NOT NULL DEFAULT 0 CHECK (deferred_push IN (0, 1)),
  dispatched_at      INTEGER,
  action_required    INTEGER NOT NULL DEFAULT 0 CHECK (action_required IN (0, 1)),
  action_deadline_at INTEGER,
  action_acked_at    INTEGER,
  CHECK (action_required = 1 OR (action_deadline_at IS NULL AND action_acked_at IS NULL))
) STRICT;
CREATE INDEX notifications_audience_seq ON notifications (audience_kind, audience_id, seq);
CREATE INDEX notifications_unread ON notifications (audience_kind, audience_id, type, occurred_at) WHERE read = 0;
CREATE INDEX notifications_staff ON notifications (staff_id) WHERE staff_id IS NOT NULL;
CREATE INDEX notifications_undispatched ON notifications (seq) WHERE dispatched_at IS NULL;
CREATE INDEX notifications_awaiting_ack ON notifications (seq) WHERE action_required = 1 AND action_acked_at IS NULL;
CREATE TABLE notification_prefs (
  audience_kind TEXT NOT NULL CHECK (audience_kind IN ('player', 'guardian', 'org_user')),
  audience_id   TEXT NOT NULL CHECK (audience_id IS NULL OR length(audience_id) BETWEEN 1 AND 80),
  staff_id      TEXT GENERATED ALWAYS AS (CASE WHEN audience_kind = 'org_user' THEN audience_id END) STORED REFERENCES org_users(id) ON DELETE RESTRICT,
  email_intent  INTEGER NOT NULL DEFAULT 0 CHECK (email_intent IN (0, 1)),
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (audience_kind, audience_id)
) STRICT;
CREATE INDEX notification_prefs_staff ON notification_prefs (staff_id) WHERE staff_id IS NOT NULL;
CREATE TABLE notification_pref_categories (
  audience_kind TEXT NOT NULL,
  audience_id   TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('mentions', 'assignments', 'room_changes', 'evidence_requests', 'combine', 'trial_updates', 'second_look', 'brief_updates', 'messages', 'activity', 'discovery_nudges', 'watchlist_changes', 'development_updates', 'representation', 'compliance', 'transaction_updates', 'offer_updates', 'signing_updates', 'security_account')),
  enabled       INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  PRIMARY KEY (audience_kind, audience_id, category),
  FOREIGN KEY (audience_kind, audience_id) REFERENCES notification_prefs(audience_kind, audience_id) ON DELETE CASCADE
) STRICT;


-- -----------------------------------------------------------------------------
-- dispatches, dispatch_attempts  (migration 0010_dispatches, S7b; explicit since S14d, amended in place —
--   repositories/dispatches.mjs, DISPATCHES_DDL)
-- One row per notification and channel: an in_app row (delivered at once) and an email row (sent through the
-- provider, skipped, or held for quiet hours). Written by the delivery centre (m13/delivery.mjs): a notification's
-- dispatches in one unit of work; each send (its attempt, status, the outbox row, the injected failure it used and,
-- when the retries run out, the ops event and webhook) in one unit; a callback event with its seen marker; an
-- acknowledgment with the notification's contract. Status ladder, forward-only: queued/held_quiet_hours →
-- accepted → delivered → opened → actioned; side states skipped, failed, retrying.
-- keys: org_id is a staff audience's organisation, a RESTRICT key DEFERRABLE INITIALLY DEFERRED (the organisations
--   are still written by their staged hook at COMMIT). notification_id and audience_id carry no key: a dispatch
--   outlives its notification after an account deletion (retention is open, Q6).
-- clocks: integers (Date.now()); a callback's at is a whole-number timestamp, junk refused at the route.
-- attempts: ordered child rows, a send (ok 0/1, error) or a quiet re-check note; the shape CHECK is total.
-- -----------------------------------------------------------------------------
CREATE TABLE dispatches (
  seq                 INTEGER PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE CHECK (id IS NULL OR length(id) BETWEEN 1 AND 80),
  notification_id     TEXT NOT NULL CHECK (notification_id IS NULL OR length(notification_id) BETWEEN 1 AND 80),
  audience_kind       TEXT NOT NULL CHECK (audience_kind IN ('player', 'guardian', 'org_user')),
  audience_id         TEXT NOT NULL CHECK (audience_id IS NULL OR length(audience_id) BETWEEN 1 AND 80),
  org_id              TEXT REFERENCES orgs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  channel             TEXT NOT NULL CHECK (channel IN ('in_app', 'email')),
  to_address          TEXT CHECK (to_address IS NULL OR length(to_address) BETWEEN 1 AND 320),
  provider            TEXT NOT NULL CHECK (provider IN ('in_app', 'local-fake')),
  status              TEXT NOT NULL CHECK (status IN ('queued', 'held_quiet_hours', 'accepted', 'delivered', 'opened', 'actioned', 'skipped', 'failed', 'retrying')),
  skip_reason         TEXT CHECK (skip_reason IS NULL OR length(skip_reason) BETWEEN 1 AND 200),
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 80),
  next_at             INTEGER NOT NULL,
  action_deadline_at  INTEGER,
  created_at          INTEGER NOT NULL,
  delivered_at        INTEGER,
  opened_at           INTEGER,
  actioned_at         INTEGER,
  failed_at           INTEGER,
  fail_reason         TEXT CHECK (fail_reason IS NULL OR length(fail_reason) BETWEEN 1 AND 500),
  CHECK (org_id IS NULL OR audience_kind = 'org_user'),
  CHECK ((channel = 'in_app') = (provider = 'in_app')),
  CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  CHECK (channel <> 'email' OR status = 'skipped' OR to_address IS NOT NULL)
) STRICT;
CREATE INDEX dispatches_notification ON dispatches (notification_id);
CREATE UNIQUE INDEX dispatches_provider_message ON dispatches (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX dispatches_status_next ON dispatches (status, next_at);
CREATE INDEX dispatches_org_seq ON dispatches (org_id, seq) WHERE org_id IS NOT NULL;
CREATE INDEX dispatches_unopened_in_app ON dispatches (seq) WHERE channel = 'in_app' AND opened_at IS NULL;
CREATE TABLE dispatch_attempts (
  dispatch_seq INTEGER NOT NULL REFERENCES dispatches(seq) ON DELETE CASCADE,
  seq          INTEGER NOT NULL CHECK (seq >= 0),
  kind         TEXT NOT NULL CHECK (kind IN ('send', 'quiet_recheck')),
  attempted_at INTEGER NOT NULL,
  ok           INTEGER,
  error        TEXT CHECK (error IS NULL OR length(error) BETWEEN 1 AND 500),
  note         TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 200),
  PRIMARY KEY (dispatch_seq, seq),
  CHECK ((kind = 'send' AND ok IS NOT NULL AND ok IN (0, 1) AND note IS NULL)
      OR (kind = 'quiet_recheck' AND ok IS NULL AND error IS NULL AND note IS NOT NULL))
) STRICT;


-- -----------------------------------------------------------------------------
-- outbox, push_log, push_tokens  (migration 0011_outbox_push, S7c; explicit since S14d, amended in place —
--   repositories/outboxPush.mjs, OUTBOX_PUSH_DDL)
-- outbox: one row per mail handed to a transport. source 'mailer' (adapters.mjs createMailer: written before the
--   provider call, its answer after; the text withholds every one-time code passed as a secret) or 'delivery' (the
--   local fake provider's record of an accepted e-mail dispatch, in the send's unit). Both carry an address.
--   Paged newest first for /admin/outbox.
-- push_log: one row per push handed to the push sender, written once the notification is durable (an after-commit
--   effect). Paged newest first for /admin/push-log.
-- push_tokens: one row per device token, players and guardians only (POST /push/register). A token another account
--   registers moves to it, so a shared phone receives only the notices of the account that last signed in on it.
--   Not hashed: the token is the delivery address handed to Expo, not a ScoutBox credential (personal data).
-- Nothing here carries a key: the rows outlive the accounts they were addressed to (retention is open, Q6).
-- -----------------------------------------------------------------------------
CREATE TABLE outbox (
  seq                 INTEGER PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE CHECK (id IS NULL OR length(id) BETWEEN 1 AND 80),
  source              TEXT NOT NULL CHECK (source IN ('mailer', 'delivery')),
  created_at          INTEGER NOT NULL,
  to_address          TEXT NOT NULL CHECK (to_address IS NULL OR length(to_address) BETWEEN 1 AND 320),
  subject             TEXT CHECK (subject IS NULL OR length(subject) BETWEEN 0 AND 300),
  text                TEXT NOT NULL CHECK (text IS NULL OR length(text) BETWEEN 0 AND 10000),
  transport           TEXT NOT NULL CHECK (transport IN ('sendgrid', 'dev-outbox', 'local-fake')),
  delivered           INTEGER,
  channel             TEXT CHECK (channel IS NULL OR channel = 'email'),
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 80),
  CHECK ((source = 'mailer' AND subject IS NOT NULL AND delivered IS NOT NULL AND delivered IN (0, 1) AND channel IS NULL AND provider_message_id IS NULL AND transport IN ('sendgrid', 'dev-outbox'))
      OR (source = 'delivery' AND subject IS NULL AND delivered IS NULL AND channel IS NOT NULL AND provider_message_id IS NOT NULL AND transport = 'local-fake' AND length(text) <= 300))
) STRICT;
CREATE TABLE push_log (
  seq           INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE CHECK (id IS NULL OR length(id) BETWEEN 1 AND 80),
  created_at    INTEGER NOT NULL,
  audience_kind TEXT NOT NULL CHECK (audience_kind IN ('player', 'guardian', 'org_user')),
  audience_id   TEXT NOT NULL CHECK (audience_id IS NULL OR length(audience_id) BETWEEN 1 AND 80),
  title         TEXT NOT NULL CHECK (title IS NULL OR length(title) BETWEEN 1 AND 100),
  body          TEXT NOT NULL CHECK (body IS NULL OR length(body) BETWEEN 0 AND 4000),
  transport     TEXT NOT NULL CHECK (transport IN ('expo', 'dev-log'))
) STRICT;
CREATE TABLE push_tokens (
  seq           INTEGER PRIMARY KEY,
  ref_kind      TEXT NOT NULL CHECK (ref_kind IN ('player', 'guardian')),
  ref_id        TEXT NOT NULL CHECK (ref_id IS NULL OR length(ref_id) BETWEEN 1 AND 80),
  token         TEXT NOT NULL UNIQUE CHECK (token IS NULL OR length(token) BETWEEN 1 AND 200),
  registered_at INTEGER NOT NULL
) STRICT;
CREATE INDEX push_tokens_ref ON push_tokens (ref_kind, ref_id);


-- =============================================================================
-- S6b, explicit since S14b (migration 0013_safety_audit, amended in place in S14b; repositories/safetyAudit.mjs).
-- The ten tables below are the IMPLEMENTED DDL (SAFETY_AUDIT_DDL), column for column:
--   blocks, reports, moderation_log (+ moderation_flags, ordered rows), org_notes, ledger (+ ledger_protocols),
--   ops_events, source_changes, idv_queue.
-- Every column is typed; vocabularies are CHECKs (block and report authors, report targets and statuses, the
-- moderation flags and severities, the ledger types, the ops-event kinds, the source systems, the IDV statuses).
-- A polymorphic detail is typed columns by type: ledger.detail_* by ledger type (LEDGER_DETAIL), ops_events.detail_*
-- by kind (OPS_DETAIL), source_changes' position change; each column carries a CHECK naming the types that use it.
-- The moderation context is typed columns (context_kind and the ids a caller passes).
-- Organisations (org_id, by_org_id, target_org_id, context_org_id, detail_org_id) and staff (user_id,
-- context_user_id, detail_user_id) are RESTRICT keys. Player ids carry no key (Q4: a row outlives the account; an
-- unresolved id is counted by the data-layer report, never refused). idv_queue.guardian_id has no key while the
-- guardians are the staged identity repository's: every write and every snapshot checks it (Q4b). Lifting a block
-- deletes its row (Q5). `seq INTEGER PRIMARY KEY` is the durable order and the paging cursor; `id` the writer's id.
-- Writes are explicit repository operations (one unit of work per route); reads are SQL.
-- =============================================================================

CREATE TABLE blocks (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                        TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  org_id                           TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  by_kind                          TEXT NOT NULL CHECK (by_kind IN ('player','guardian')),
  reason                           TEXT NOT NULL CHECK (length(reason) <= 2000),
  created_at                       INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX blocks_player_id_org_id ON blocks (player_id, org_id);
CREATE INDEX blocks_org_id ON blocks (org_id);
CREATE TABLE reports (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  created_at                       INTEGER NOT NULL,
  by_kind                          TEXT NOT NULL CHECK (by_kind IN ('player','guardian','org_user','system')),
  by_id                            TEXT NOT NULL CHECK (length(by_id) <= 80 AND length(by_id) > 0),
  by_org_id                        TEXT CHECK (by_org_id IS NULL OR length(by_org_id) <= 80 AND length(by_org_id) > 0),
  target_kind                      TEXT NOT NULL CHECK (target_kind IN ('club','scout','player')),
  target_org_id                    TEXT CHECK (target_org_id IS NULL OR length(target_org_id) <= 80 AND length(target_org_id) > 0),
  target_scout_name                TEXT CHECK (target_scout_name IS NULL OR length(target_scout_name) <= 200 AND length(target_scout_name) > 0),
  target_player_id                 TEXT CHECK (target_player_id IS NULL OR length(target_player_id) <= 200 AND length(target_player_id) > 0),
  reason                           TEXT NOT NULL CHECK (length(reason) <= 2000 AND length(reason) > 0),
  urgent                           INTEGER NOT NULL CHECK (urgent IN (0,1)),
  status                           TEXT NOT NULL CHECK (status IN ('pending_review','resolved')),
  outcome                          TEXT CHECK (outcome IS NULL OR length(outcome) <= 2000 AND length(outcome) > 0),
  resolved_at                      INTEGER,
  FOREIGN KEY (by_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (target_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK (status = 'resolved' OR outcome IS NULL),
  CHECK ((by_kind = 'org_user') = (by_org_id IS NOT NULL))
) STRICT;
CREATE INDEX reports_by_kind_by_id ON reports (by_kind, by_id);
CREATE INDEX reports_target_org_id_urgent_status ON reports (target_org_id, urgent, status);
CREATE INDEX reports_status_created_at ON reports (status, created_at);
CREATE INDEX reports_target_player_id ON reports (target_player_id);
CREATE TABLE moderation_log (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  created_at                       INTEGER NOT NULL,
  context_kind                     TEXT NOT NULL CHECK (length(context_kind) <= 60 AND length(context_kind) > 0),
  context_player_id                TEXT CHECK (context_player_id IS NULL OR length(context_player_id) <= 80 AND length(context_player_id) > 0),
  context_org_id                   TEXT CHECK (context_org_id IS NULL OR length(context_org_id) <= 80 AND length(context_org_id) > 0),
  context_user_id                  TEXT CHECK (context_user_id IS NULL OR length(context_user_id) <= 80 AND length(context_user_id) > 0),
  context_channel_id               TEXT CHECK (context_channel_id IS NULL OR length(context_channel_id) <= 80 AND length(context_channel_id) > 0),
  context_request_id               TEXT CHECK (context_request_id IS NULL OR length(context_request_id) <= 80 AND length(context_request_id) > 0),
  context_trial_id                 TEXT CHECK (context_trial_id IS NULL OR length(context_trial_id) <= 80 AND length(context_trial_id) > 0),
  severity                         TEXT NOT NULL CHECK (severity IN ('contact','grooming')),
  excerpt                          TEXT NOT NULL CHECK (length(excerpt) <= 140),
  FOREIGN KEY (context_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (context_user_id) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX moderation_log_severity ON moderation_log (severity);
CREATE TABLE moderation_flags (
  moderation_id TEXT NOT NULL,
  ord INTEGER NOT NULL CHECK (ord >= 0),
  flag TEXT NOT NULL CHECK (flag IN ('email', 'email_obfuscated', 'phone_number', 'phone_spelled', 'social_handle', 'social_platform', 'url', 'meet_off_platform', 'secrecy', 'personal_probing')),
  PRIMARY KEY (moderation_id, ord),
  FOREIGN KEY (moderation_id) REFERENCES moderation_log(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE org_notes (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                           TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  player_id                        TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  user_id                          TEXT NOT NULL CHECK (length(user_id) <= 80 AND length(user_id) > 0),
  scout_name                       TEXT NOT NULL CHECK (length(scout_name) <= 200),
  text                             TEXT NOT NULL CHECK (length(text) <= 2000 AND length(text) > 0),
  created_at                       INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX org_notes_org_id_player_id ON org_notes (org_id, player_id);
CREATE TABLE ledger (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  occurred_at                      INTEGER NOT NULL,
  type                             TEXT NOT NULL CHECK (type IN ('view','save','shortlist','contact_request','contact_request_to_guardian','contact_accepted','contact_accepted_by_guardian','contact_declined','contact_declined_by_guardian','trial_request','trial_request_to_guardian','trial_accepted','trial_accepted_by_guardian','trial_declined','trial_declined_by_guardian','message','signing','released_by_club','staff_removed','org_blocked_by_player','org_blocked_by_guardian','account_transitioned','assessment_submitted','attendance_verified','clip_tagged','coach_affiliation_confirmed','level_review','matchday_logged','open_trial_posted','open_trial_registration','open_trial_registration_by_guardian','opportunity_application','passport_view','passport_recruitment_view','passport_share_created','passport_share_revoked','recruitment_room_created','transition_pack_view','trial_checkin','trial_report','box_assignment_created','box_assignment_cancelled','box_challenge_published','box_clip_saved','box_prefs_changed','box_result_invalidated','box_result_restored','combine_attempt_completed','combine_request_created','combine_request_completed','verification_decision','verification_root_approved')),
  player_id                        TEXT CHECK (player_id IS NULL OR length(player_id) <= 80 AND length(player_id) > 0),
  org_id                           TEXT CHECK (org_id IS NULL OR length(org_id) <= 80 AND length(org_id) > 0),
  org_name                         TEXT CHECK (org_name IS NULL OR length(org_name) <= 200),
  user_id                          TEXT CHECK (user_id IS NULL OR length(user_id) <= 80 AND length(user_id) > 0),
  actor_name                       TEXT CHECK (actor_name IS NULL OR length(actor_name) <= 200),
  detail_assignment_id             TEXT CHECK (detail_assignment_id IS NULL OR length(detail_assignment_id) <= 80 AND length(detail_assignment_id) > 0) CHECK (detail_assignment_id IS NULL OR type IN ('box_assignment_cancelled')),
  detail_drill_id                  TEXT CHECK (detail_drill_id IS NULL OR length(detail_drill_id) <= 80 AND length(detail_drill_id) > 0) CHECK (detail_drill_id IS NULL OR type IN ('box_assignment_created', 'box_challenge_published')),
  detail_target_type               TEXT CHECK (detail_target_type IS NULL OR length(detail_target_type) <= 40) CHECK (detail_target_type IS NULL OR type IN ('box_assignment_created')),
  detail_target_value              REAL CHECK (detail_target_value IS NULL OR type IN ('box_assignment_created')),
  detail_challenge_id              TEXT CHECK (detail_challenge_id IS NULL OR length(detail_challenge_id) <= 80 AND length(detail_challenge_id) > 0) CHECK (detail_challenge_id IS NULL OR type IN ('box_challenge_published')),
  detail_session_id                TEXT CHECK (detail_session_id IS NULL OR length(detail_session_id) <= 80 AND length(detail_session_id) > 0) CHECK (detail_session_id IS NULL OR type IN ('box_clip_saved', 'box_result_invalidated', 'box_result_restored')),
  detail_media_id                  TEXT CHECK (detail_media_id IS NULL OR length(detail_media_id) <= 80 AND length(detail_media_id) > 0) CHECK (detail_media_id IS NULL OR type IN ('box_clip_saved')),
  detail_by                        TEXT CHECK (detail_by IS NULL OR length(detail_by) <= 40) CHECK (detail_by IS NULL OR type IN ('box_prefs_changed', 'passport_share_revoked')),
  detail_share                     TEXT CHECK (detail_share IS NULL OR length(detail_share) <= 40) CHECK (detail_share IS NULL OR type IN ('box_prefs_changed')),
  detail_retain_clips              INTEGER CHECK (detail_retain_clips IS NULL OR detail_retain_clips IN (0,1)) CHECK (detail_retain_clips IS NULL OR type IN ('box_prefs_changed')),
  detail_dispute_id                TEXT CHECK (detail_dispute_id IS NULL OR length(detail_dispute_id) <= 80 AND length(detail_dispute_id) > 0) CHECK (detail_dispute_id IS NULL OR type IN ('box_result_invalidated')),
  detail_outcome                   TEXT CHECK (detail_outcome IS NULL OR length(detail_outcome) <= 40) CHECK (detail_outcome IS NULL OR type IN ('box_result_invalidated')),
  detail_reason                    TEXT CHECK (detail_reason IS NULL OR length(detail_reason) <= 300) CHECK (detail_reason IS NULL OR type IN ('box_result_restored', 'level_review')),
  detail_attempt_id                TEXT CHECK (detail_attempt_id IS NULL OR length(detail_attempt_id) <= 80 AND length(detail_attempt_id) > 0) CHECK (detail_attempt_id IS NULL OR type IN ('combine_attempt_completed')),
  detail_protocol                  TEXT CHECK (detail_protocol IS NULL OR length(detail_protocol) <= 120) CHECK (detail_protocol IS NULL OR type IN ('combine_attempt_completed')),
  detail_state                     TEXT CHECK (detail_state IS NULL OR length(detail_state) <= 40) CHECK (detail_state IS NULL OR type IN ('combine_attempt_completed')),
  detail_request_id                TEXT CHECK (detail_request_id IS NULL OR length(detail_request_id) <= 80 AND length(detail_request_id) > 0) CHECK (detail_request_id IS NULL OR type IN ('combine_request_completed', 'combine_request_created')),
  detail_from_value                TEXT CHECK (detail_from_value IS NULL OR length(detail_from_value) <= 40) CHECK (detail_from_value IS NULL OR type IN ('level_review')),
  detail_to_value                  TEXT CHECK (detail_to_value IS NULL OR length(detail_to_value) <= 40) CHECK (detail_to_value IS NULL OR type IN ('level_review')),
  detail_trial_id                  TEXT CHECK (detail_trial_id IS NULL OR length(detail_trial_id) <= 80 AND length(detail_trial_id) > 0) CHECK (detail_trial_id IS NULL OR type IN ('open_trial_posted')),
  detail_via                       TEXT CHECK (detail_via IS NULL OR length(detail_via) <= 40) CHECK (detail_via IS NULL OR type IN ('passport_recruitment_view')),
  detail_mode                      TEXT CHECK (detail_mode IS NULL OR length(detail_mode) <= 40) CHECK (detail_mode IS NULL OR type IN ('passport_share_created')),
  detail_share_id                  TEXT CHECK (detail_share_id IS NULL OR length(detail_share_id) <= 80 AND length(detail_share_id) > 0) CHECK (detail_share_id IS NULL OR type IN ('passport_share_created', 'passport_share_revoked')),
  detail_claim_id                  TEXT CHECK (detail_claim_id IS NULL OR length(detail_claim_id) <= 80 AND length(detail_claim_id) > 0) CHECK (detail_claim_id IS NULL OR type IN ('verification_decision')),
  detail_action                    TEXT CHECK (detail_action IS NULL OR length(detail_action) <= 40) CHECK (detail_action IS NULL OR type IN ('verification_decision')),
  detail_root_request_id           TEXT CHECK (detail_root_request_id IS NULL OR length(detail_root_request_id) <= 80 AND length(detail_root_request_id) > 0) CHECK (detail_root_request_id IS NULL OR type IN ('verification_root_approved')),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ledger_player_id_type ON ledger (player_id, type);
CREATE INDEX ledger_player_id_org_id ON ledger (player_id, org_id);
CREATE INDEX ledger_org_id_type ON ledger (org_id, type);
CREATE INDEX ledger_actor ON ledger (actor_name, org_name, type);
CREATE TABLE ledger_protocols (
  ledger_id TEXT NOT NULL,
  ord INTEGER NOT NULL CHECK (ord >= 0),
  protocol TEXT NOT NULL CHECK (length(protocol) > 0 AND length(protocol) <= 120),
  PRIMARY KEY (ledger_id, ord),
  FOREIGN KEY (ledger_id) REFERENCES ledger(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE ops_events (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  occurred_at                      INTEGER NOT NULL,
  kind                             TEXT NOT NULL CHECK (kind IN ('staff_bootstrapped','audit_export','backup_created','backup_refused','backup_failed','delivery_failed','webhook_failed')),
  detail_org_id                    TEXT CHECK (detail_org_id IS NULL OR length(detail_org_id) <= 80 AND length(detail_org_id) > 0) CHECK (detail_org_id IS NULL OR kind IN ('staff_bootstrapped', 'audit_export')),
  detail_user_id                   TEXT CHECK (detail_user_id IS NULL OR length(detail_user_id) <= 80 AND length(detail_user_id) > 0) CHECK (detail_user_id IS NULL OR kind IN ('staff_bootstrapped')),
  detail_by                        TEXT CHECK (detail_by IS NULL OR length(detail_by) <= 200) CHECK (detail_by IS NULL OR kind IN ('staff_bootstrapped', 'audit_export')),
  detail_dir                       TEXT CHECK (detail_dir IS NULL OR length(detail_dir) <= 200) CHECK (detail_dir IS NULL OR kind IN ('backup_created', 'backup_refused', 'backup_failed')),
  detail_files                     INTEGER CHECK (detail_files IS NULL OR kind IN ('backup_created')),
  detail_queued_for_removal        INTEGER CHECK (detail_queued_for_removal IS NULL OR kind IN ('backup_created')),
  detail_error                     TEXT CHECK (detail_error IS NULL OR length(detail_error) <= 300) CHECK (detail_error IS NULL OR kind IN ('backup_refused', 'backup_failed')),
  detail_conflict_count            INTEGER CHECK (detail_conflict_count IS NULL OR kind IN ('backup_refused')),
  detail_dispatch_id               TEXT CHECK (detail_dispatch_id IS NULL OR length(detail_dispatch_id) <= 80 AND length(detail_dispatch_id) > 0) CHECK (detail_dispatch_id IS NULL OR kind IN ('delivery_failed')),
  detail_channel                   TEXT CHECK (detail_channel IS NULL OR length(detail_channel) <= 40) CHECK (detail_channel IS NULL OR kind IN ('delivery_failed')),
  detail_delivery_id               TEXT CHECK (detail_delivery_id IS NULL OR length(detail_delivery_id) <= 80 AND length(detail_delivery_id) > 0) CHECK (detail_delivery_id IS NULL OR kind IN ('webhook_failed')),
  detail_endpoint_id               TEXT CHECK (detail_endpoint_id IS NULL OR length(detail_endpoint_id) <= 80 AND length(detail_endpoint_id) > 0) CHECK (detail_endpoint_id IS NULL OR kind IN ('webhook_failed')),
  FOREIGN KEY (detail_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (detail_user_id) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX ops_events_kind ON ops_events (kind);
CREATE TABLE source_changes (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                        TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  type                             TEXT NOT NULL CHECK (type IN ('position_changed')),
  source_system                    TEXT NOT NULL CHECK (source_system IN ('passport_prefs','position_history')),
  source_id                        TEXT CHECK (source_id IS NULL OR length(source_id) <= 200 AND length(source_id) > 0),
  occurred_at                      INTEGER NOT NULL,
  detail_position_from             TEXT CHECK (detail_position_from IS NULL OR length(detail_position_from) <= 40) CHECK (detail_position_from IS NULL OR type IN ('position_changed')),
  detail_position_to               TEXT CHECK (detail_position_to IS NULL OR length(detail_position_to) <= 40) CHECK (detail_position_to IS NULL OR type IN ('position_changed')),
  detail_submitted_by              TEXT CHECK (detail_submitted_by IS NULL OR length(detail_submitted_by) <= 40) CHECK (detail_submitted_by IS NULL OR type IN ('position_changed'))
) STRICT;
CREATE INDEX source_changes_player_id_occurred_at ON source_changes (player_id, occurred_at);
CREATE TABLE idv_queue (
  seq                              INTEGER PRIMARY KEY,
  id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= 80),
  guardian_id                      TEXT NOT NULL CHECK (length(guardian_id) <= 80 AND length(guardian_id) > 0),
  guardian_name                    TEXT CHECK (guardian_name IS NULL OR length(guardian_name) <= 200),
  document_type                    TEXT NOT NULL CHECK (length(document_type) <= 60 AND length(document_type) > 0),
  document_ref_last4               TEXT NOT NULL CHECK (length(document_ref_last4) <= 20),
  provider                         TEXT NOT NULL CHECK (length(provider) <= 60 AND length(provider) > 0),
  reference                        TEXT NOT NULL CHECK (length(reference) <= 200 AND length(reference) > 0),
  created_at                       INTEGER NOT NULL,
  status                           TEXT NOT NULL CHECK (status IN ('approved','revoked'))
) STRICT;
CREATE INDEX idv_queue_guardian_id ON idv_queue (guardian_id);


-- -----------------------------------------------------------------------------
-- email_challenges — LIVE since migration 0008_one_time_codes (S6a, REGISTERED:
--   repositories/migrations/0008_one_time_codes.mjs; repositories/oneTimeCodes.mjs).
-- source: db.emailChallenges (the blob every build before S6a wrote; imported and retired by 0008)
--         written at POST /org/verification/email, consumed at POST /org/verification/email/confirm.
-- owner/writer: repositories/oneTimeCodes.mjs (issueEmailChallenge: INSERT OR REPLACE, one live
--         challenge per organisation, durable before the mail is sent; noteFailedEmailAttempt:
--         attempts + 1, the row deleted at EMAIL_CHALLENGE_MAX_ATTEMPTS = 10; consumeEmailChallenge:
--         DELETE inside the confirmation unit of work, with orgs.update in the same transaction).
-- lifecycle: 30-minute lifetime judged on every read (expires_at > now); expired rows swept at
--         boot and before every issue; replaced on re-request; removed on success or after ten
--         wrong codes. Never kept after use.
-- mapping:
--   orgId     -> org_id (one row per organisation; the foreign key cascades with a pruned organisation —
--                organisations are upserted and pruned, never rewritten whole)
--   email     -> email  -- personal data (work mailbox)
--   code      -> code_hash (sha256 hex of the code trimmed and upper-cased — the comparison the route
--                always made; the plain code exists in the mail only. A 31-character alphabet gives
--                ~2^29.7 values, so the hash resists casual disclosure of a file or backup, not an
--                offline search by someone holding it; the 30-minute lifetime bounds that exposure)
--   expiresAt -> expires_at
--   (new)     -> attempts (wrong confirmations counted on the row; survives a restart, unlike the
--                process-memory rate limiter that complements it)
-- notes: backups export the rows in this stored form (codeHash); a backup from before S6a carries
--   the legacy plain-code shape, which migration 0008 hashes on import. An entry carrying both or
--   neither, an unknown field, a malformed hash or expiry, or a duplicate organisation refuses the
--   whole import (ONE_TIME_CODES_IMPORT_BLOCKED).
-- -----------------------------------------------------------------------------
CREATE TABLE email_challenges (
  org_id     TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,                                                -- personal data
  code_hash  TEXT NOT NULL CHECK (length(code_hash) = 64),
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
) STRICT;
CREATE INDEX email_challenges_expires_at ON email_challenges (expires_at);


-- -----------------------------------------------------------------------------
-- pairing_codes — LIVE since migration 0008_one_time_codes (S6a, REGISTERED; repositories/oneTimeCodes.mjs).
-- source: db.pairingCodes (the blob every build before S6a wrote — and did not persist at mint; imported
--         and retired by 0008); written at POST /guardian/children/:id/pairing-code, consumed at
--         POST /auth/player/pair, revoked by the deletion unit of work.
-- owner/writer: repositories/oneTimeCodes.mjs (issuePairingCode: the child's previous row deleted and
--         the new one inserted in one transaction, durable before the response; consumePairingCode:
--         DELETE inside the pairing unit of work, with the session insert in the same transaction;
--         revokePairingCodesFor: the deletion unit, before the player row goes).
-- lifecycle: 15-minute lifetime judged on every read; expired rows swept at boot and before every
--         issue; single use (consumed with the session it buys, so a crash between the two can no
--         longer leave a committed session beside a live code).
-- mapping:
--   code      -> code_hash (sha256 hex of the upper-cased code; same note as email_challenges — the
--                plain code exists in the guardian's response only)
--   playerId  -> player_id — NO foreign key, on purpose: the identity snapshot rewrite deletes and
--                reinserts every player row, so a cascading reference would silently erase every
--                pairing code on a whole-snapshot save that omits the collection. The deletion unit
--                revokes the child's codes explicitly, every snapshot write checks the FINAL state
--                (a code naming a player not in the table refuses the whole save,
--                PAIRING_CODE_PLAYER_MISSING), and migration 0008 refuses an outstanding code of a
--                player that does not exist.
--   expiresAt -> expires_at
-- notes: lookup is by code → PK on code_hash. One live code per child → UNIQUE player_id. Child =
--   minor; the code is the minor's login bootstrap, so the row is safeguarding-sensitive. The
--   guessing budget is the per-IP /auth limiter plus `pairing_attempt` (wrong codes only).
-- -----------------------------------------------------------------------------
CREATE TABLE pairing_codes (
  code_hash  TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  player_id  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX pairing_codes_player_id ON pairing_codes (player_id);
CREATE INDEX pairing_codes_expires_at ON pairing_codes (expires_at);


-- =============================================================================
-- not tables (in scope of this file but deliberately not persisted as tables):
--   notificationsSuppressed      in-memory counter (server.mjs:775)
--   unknownTypes                 in-memory Map of unclassified notification types (notificationPrefs.mjs:226)
--   CATEGORIES / TYPE_CATEGORY   code registries (notificationPrefs.mjs:28, 83) — the CHECK lists above mirror them
--   MODERATION rule table        code registry (domain.mjs:131-142) — flags_json values mirror it
--   RETRY_MS / MAX_ATTEMPTS      retry ladder constants (delivery.mjs:70-73)
--   deliveryFailInject           admin fault-injection counters (delivery.mjs:20) — operational, not data
--   deliveryCentreSince          single boot timestamp (delivery.mjs:21) — becomes a config value, not a row
--   deliveryCallbacksSeen        processed provider callback ids (delivery.mjs:184-186) — belongs beside
--                                dispatches but is outside this file's assigned list; see reply
--   sseClients / tickets / eventLog / typing broadcasts   in-memory SSE state (server.mjs:403, 534)
--   notification.target, channel.closed, effective notification prefs   derived at read time
-- =============================================================================
