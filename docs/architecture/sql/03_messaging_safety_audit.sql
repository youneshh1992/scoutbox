-- =============================================================================
-- 03_messaging_safety_audit.sql — ScoutBox target SQLite schema, part 3
--
-- Scope (source collections → tables):
--   channels            → channels, messages, message_attachments
--   notifications       → notifications
--   notificationPrefs   → notification_prefs, notification_pref_categories
--   dispatches          → dispatches, dispatch_attempts
--   outbox              → outbox
--   pushLog             → push_log
--   pushTokens          → push_tokens
--   blocks              → blocks
--   reports             → reports
--   moderationLog       → moderation_log
--   orgNotes            → org_notes
--   ledger              → ledger
--   opsEvents           → ops_events
--   sourceChanges       → source_changes
--   emailChallenges     → email_challenges   (LIVE since migration 0008_one_time_codes, S6a, REGISTERED)
--   pairingCodes        → pairing_codes      (LIVE since migration 0008_one_time_codes, S6a, REGISTERED)
--   idvQueue            → idv_queue
--
-- Depends on 01_identity.sql: orgs(id), org_users(id), players(id), guardians(id)
-- Depends on 02_recruitment.sql: recruitment_requests(id), trials(id)
--
-- Timestamps are epoch milliseconds (INTEGER). Source fields literally named
-- `ts` / `at` are renamed per convention and the mapping line says so.
-- Audit tables use ON DELETE RESTRICT on players/orgs/guardians: today the
-- server hard-deletes the player row (server.mjs:3984) while keeping these
-- rows id-only; under this schema that deletion must become a tombstone
-- (01_identity owns that decision) or the RESTRICT will refuse it. This is
-- deliberate: the audit rows must outlive their subject.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- channels
-- source: db.channels  created at server.mjs:841-861 (openChannel); container
--         seeded seed.mjs:490, restored by migration m230_001 (m182/migrations.mjs:253)
-- owner/writer: server.mjs (openChannel on request acceptance; readBy on
--         /channels/:id/read 1526, 2273, 3307). Read by m26 (transaction
--         linked threads, m26/index.mjs:402, 1215).
-- lifecycle: no status field; "closed" is DERIVED on every read
--         (channelClosedForOrg 920 / channelClosedForCounterparty 928) from
--         blocks, org.suspended and visibility. Hard-deleted with all messages
--         when the player is deleted (server.mjs:4014) → player FK CASCADE.
-- mapping:
--   id            -> id (chan-*)
--   requestId     -> request_id (1:1 with recruitment_requests; UNIQUE, enforced by code today)
--   playerId      -> player_id
--   playerName    -> player_name (snapshot)
--   orgId         -> org_id
--   orgName       -> org_name (snapshot)
--   orgVerified   -> org_verified (snapshot of the org's verified flag at open time)
--   scoutName     -> scout_name (snapshot)
--   scoutRole     -> scout_role (snapshot)
--   counterparty  -> counterparty ('player' | 'guardian' = request.routedTo)
--   guardianId    -> guardian_id (NULL for adult players)
--   createdAt     -> created_at
--   messages[]    -> messages table (child)
--   readBy.org          -> read_by_org_at
--   readBy.counterparty -> read_by_counterparty_at
--   orgUserIdForNotify  -> dead field, not migrated (read at server.mjs:898, never written anywhere)
-- notes: tenant = org_id; minors: the child is never a party — counterparty is
--   the guardian. Admin /admin/channels (4246) returns every channel with ids.
--   Reads: by org_id (2247), by guardian_id (1506), by player_id+counterparty
--   (3285), by id+owner (all message/read/typing routes), by id alone (m26, SSE 449).
-- -----------------------------------------------------------------------------
CREATE TABLE channels (
  id                      TEXT PRIMARY KEY,
  request_id              TEXT NOT NULL REFERENCES recruitment_requests(id) ON DELETE RESTRICT,
  player_id               TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_name             TEXT NOT NULL,                                   -- snapshot
  org_id                  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name                TEXT NOT NULL,                                   -- snapshot
  org_verified            INTEGER NOT NULL DEFAULT 0 CHECK (org_verified IN (0,1)), -- snapshot
  scout_name              TEXT,                                            -- snapshot
  scout_role              TEXT,                                            -- snapshot
  counterparty            TEXT NOT NULL CHECK (counterparty IN ('player','guardian')),
  guardian_id             TEXT REFERENCES guardians(id) ON DELETE RESTRICT,
  created_at              INTEGER NOT NULL,
  read_by_org_at          INTEGER,
  read_by_counterparty_at INTEGER
) STRICT;

CREATE UNIQUE INDEX channels_request_id ON channels(request_id);          -- 1:1, enforced by code today
CREATE INDEX channels_org_id ON channels(org_id);
CREATE INDEX channels_guardian_id ON channels(guardian_id);
CREATE INDEX channels_player_id_counterparty ON channels(player_id, counterparty);


-- -----------------------------------------------------------------------------
-- messages
-- source: db.channels[].messages[]  created at server.mjs:884-915 (postMessage)
-- owner/writer: server.mjs postMessage (guardian 1520, org 2266, player 3300).
-- lifecycle: append-only; never edited; removed only with the channel.
-- mapping:
--   id            -> id (msg-*)
--   (parent)      -> channel_id
--   ts            -> created_at (source field is literally `ts`)
--   sender.kind   -> sender_kind ('player' | 'guardian' | 'org_user')
--   sender.id     -> sender_id (polymorphic: players.id / guardians.id / org_users.id; no FK)
--   sender.name   -> sender_name (snapshot; for org_user it is "Name · Role · Org" composed at 2266)
--   text          -> text (moderated before write; moderation hits are refused, never stored here)
--   attachment    -> message_attachments table (0..1 row per message)
--   clientMsgId   -> client_msg_id (≤64 chars, optional; idempotency key)
-- notes: ordering is array order = oldest→newest (ts). Idempotency: a resend
--   with the same (clientMsgId, sender.kind, sender.id) inside the same channel
--   returns the existing message (888) → UNIQUE index below is "enforced by
--   code today". A ledger row of type 'message' is appended per message (893).
-- -----------------------------------------------------------------------------
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  sender_kind   TEXT NOT NULL CHECK (sender_kind IN ('player','guardian','org_user')),
  sender_id     TEXT NOT NULL,
  sender_name   TEXT NOT NULL,                                             -- snapshot
  text          TEXT NOT NULL,
  client_msg_id TEXT CHECK (client_msg_id IS NULL OR length(client_msg_id) <= 64)
) STRICT;

CREATE INDEX messages_channel_id_created_at ON messages(channel_id, created_at);
CREATE UNIQUE INDEX messages_channel_sender_client_msg_id
  ON messages(channel_id, sender_kind, sender_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;                                         -- enforced by code today


-- -----------------------------------------------------------------------------
-- message_attachments
-- source: db.channels[].messages[].attachment  built at server.mjs:864-882 (buildAttachment)
-- owner/writer: server.mjs postMessage (one attachment per message, or none).
-- lifecycle: immutable; removed with the message.
-- mapping (shape depends on kind):
--   kind                 -> kind ('clip' | 'trial_report')
--   clip.mediaId         -> media_id (players[].media[].id; polymorphic to the media table of 01, no FK — the
--                           clip may be deleted later while the message keeps the reference)
--   clip.title           -> title (snapshot)
--   clip.url             -> url (snapshot)
--   clip.verifiedClip    -> verified_clip (snapshot boolean of !!m.verifiedClip)
--   trial_report.reportId -> report_id (players[].trialReports[].id = trials.report.id, rep-*; no FK)
--   trial_report.orgName  -> org_name (snapshot)
--   trial_report.summary  -> summary (pre-rendered metrics line, snapshot)
-- notes: an org sender may only attach a trial report its own org wrote (873).
-- -----------------------------------------------------------------------------
CREATE TABLE message_attachments (
  message_id    TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('clip','trial_report')),
  media_id      TEXT,
  title         TEXT,                                                      -- snapshot
  url           TEXT,                                                      -- snapshot
  verified_clip INTEGER NOT NULL DEFAULT 0 CHECK (verified_clip IN (0,1)), -- snapshot
  report_id     TEXT,
  org_name      TEXT,                                                      -- snapshot
  summary       TEXT,                                                      -- snapshot
  CHECK ((kind = 'clip' AND media_id IS NOT NULL AND report_id IS NULL)
      OR (kind = 'trial_report' AND report_id IS NOT NULL AND media_id IS NULL))
) STRICT;


-- -----------------------------------------------------------------------------
-- notifications
-- source: db.notifications  created at server.mjs:809-815 (notify); container
--         seeded seed.mjs:491. repeatCount backfilled by m182_005 (migrations.mjs:129).
-- owner/writer: server.mjs notify() (single creation path, ~160 call sites);
--         m13/delivery.mjs notifyAction (142) adds actionRequired; ackHandler (154-156).
-- lifecycle: read=false → true via markNotificationsRead (831); coalesced
--         (ts refreshed, repeatCount++) while unread and identical within 6h
--         (NOTIFY_COALESCE_MS, 767). Player rows hard-deleted on player deletion (4015).
-- mapping:
--   id            -> id (ntf-*)
--   ts            -> occurred_at (source field is literally `ts`; NOT immutable — refreshed on coalesce at 799)
--   audience.kind -> audience_kind ('player' | 'guardian' | 'org_user')
--   audience.id   -> audience_id (polymorphic: players.id / guardians.id / org_users.id; no FK)
--   type          -> type (open set, ~60 values registered in m182/notificationPrefs.mjs TYPE_CATEGORY;
--                    unknown types are delivered by design (229) → no CHECK)
--   text          -> text
--   refId         -> ref_id (polymorphic, kind implied by type: channel, request, trial, case, player id…; no FK)
--   read          -> read
--   repeatCount   -> repeat_count
--   groupKey      -> group_key (= "type:refId" or NULL)
--   category      -> category (what the preference gate matched; NULL when the type is unclassified)
--   deferredPush  -> deferred_push (quiet-hours / school-hours decision at creation, pushDeferred 739)
--   actionRequired          -> action_required (1 when the object exists)
--   actionRequired.deadline -> action_deadline_at
--   actionRequired.ackedAt  -> action_acked_at
--   actionRequired.ackedBy  -> action_acked_by (the audience_id that acked; same kind as audience_kind)
--   target        -> derived, not stored: resolved at read time (notificationsFor 826-828)
-- notes: a type in a category the person turned off is never created
--   (notificationAllows 781). Reads: by (audience_kind, audience_id) newest
--   first (827, m24:208/696 unread count), coalesce scan newest-first by
--   occurred_at (793), awaiting-ack scan (delivery.mjs:236), by id+audience (delivery.mjs:151).
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
  id                 TEXT PRIMARY KEY,
  occurred_at        INTEGER NOT NULL,
  audience_kind      TEXT NOT NULL CHECK (audience_kind IN ('player','guardian','org_user')),
  audience_id        TEXT NOT NULL,
  type               TEXT NOT NULL,
  text               TEXT NOT NULL,
  ref_id             TEXT,
  read               INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0,1)),
  repeat_count       INTEGER NOT NULL DEFAULT 1 CHECK (repeat_count >= 1),
  group_key          TEXT,
  category           TEXT CHECK (category IS NULL OR category IN (
                       'mentions','assignments','room_changes','evidence_requests','combine',
                       'trial_updates','second_look','brief_updates','messages','activity',
                       'discovery_nudges','watchlist_changes','development_updates','representation',
                       'compliance','transaction_updates','offer_updates','signing_updates','security_account')),
  deferred_push      INTEGER NOT NULL DEFAULT 0 CHECK (deferred_push IN (0,1)),
  action_required    INTEGER NOT NULL DEFAULT 0 CHECK (action_required IN (0,1)),
  action_deadline_at INTEGER,
  action_acked_at    INTEGER,
  action_acked_by    TEXT,
  CHECK (action_required = 1 OR (action_deadline_at IS NULL AND action_acked_at IS NULL AND action_acked_by IS NULL))
) STRICT;

CREATE INDEX notifications_audience_read_occurred_at
  ON notifications(audience_kind, audience_id, read, occurred_at);
CREATE INDEX notifications_occurred_at ON notifications(occurred_at);


-- -----------------------------------------------------------------------------
-- notification_prefs
-- source: db.notificationPrefs (M18.2)  created at m182/notificationPrefs.mjs:262 (update);
--         container by migration m182_004 (migrations.mjs:119) and ??= at 202.
-- owner/writer: m182/notificationPrefs.mjs only (PUT /notification-preferences per router).
-- lifecycle: upsert on write; never deleted (kept after player deletion).
-- mapping:
--   audienceKind -> audience_kind ('player' | 'guardian' | 'org_user')
--   audienceId   -> audience_id (polymorphic; no FK)
--   categories{} -> notification_pref_categories table (one row per category the person set)
--   emailIntent  -> email_intent
--   updatedAt    -> updated_at (NULL on the initial empty row before the first write completes)
-- notes: natural key (audienceKind, audienceId) — UNIQUE enforced by code today
--   (find-then-push at 261-262), here the PRIMARY KEY. Effective prefs are
--   DERIVED (stored over defaults, mandatory always on; effective() 207).
-- -----------------------------------------------------------------------------
CREATE TABLE notification_prefs (
  audience_kind TEXT NOT NULL CHECK (audience_kind IN ('player','guardian','org_user')),
  audience_id   TEXT NOT NULL,
  email_intent  INTEGER NOT NULL DEFAULT 0 CHECK (email_intent IN (0,1)),
  updated_at    INTEGER,
  PRIMARY KEY (audience_kind, audience_id)
) STRICT;


-- -----------------------------------------------------------------------------
-- notification_pref_categories
-- source: db.notificationPrefs[].categories (object category → boolean), written at
--         m182/notificationPrefs.mjs:263; keys validated against CATEGORIES (256).
-- owner/writer: m182/notificationPrefs.mjs.
-- lifecycle: a key is set once written and never removed; absent key = default applies.
-- mapping:
--   categories.<name> -> (category, enabled) one row per stored key
-- notes: a mandatory category ('compliance', 'security_account') can never be
--   stored as false (257-259) → CHECK. Unknown category names are refused (256) → CHECK list.
-- -----------------------------------------------------------------------------
CREATE TABLE notification_pref_categories (
  audience_kind TEXT NOT NULL,
  audience_id   TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN (
                  'mentions','assignments','room_changes','evidence_requests','combine',
                  'trial_updates','second_look','brief_updates','messages','activity',
                  'discovery_nudges','watchlist_changes','development_updates','representation',
                  'compliance','transaction_updates','offer_updates','signing_updates','security_account')),
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  PRIMARY KEY (audience_kind, audience_id, category),
  FOREIGN KEY (audience_kind, audience_id)
    REFERENCES notification_prefs(audience_kind, audience_id) ON DELETE CASCADE,
  CHECK (NOT (category IN ('compliance','security_account') AND enabled = 0))
) STRICT;


-- -----------------------------------------------------------------------------
-- dispatches
-- source: db.dispatches  created at m13/delivery.mjs:86-95 (dispatchSweep step 1);
--         container m13/shared.mjs:27.
-- owner/writer: m13/delivery.mjs (sweep 101-132, ack 157-160, provider callback 187-201).
-- lifecycle: status ladder forward-only queued/held_quiet_hours → accepted →
--         delivered → opened → actioned; terminal side states skipped, failed;
--         transient retrying. NEVER pruned today (orphans remain after the
--         notification is deleted) → here CASCADE with the owning notification.
-- mapping:
--   id                 -> id (dsp-*; prefix SHARED with m16 disputes — ids are globally unique via the counter)
--   notificationId     -> notification_id
--   audience.kind      -> audience_kind (copied from the notification — snapshot)
--   audience.id        -> audience_id (snapshot; polymorphic, no FK)
--   channel            -> channel ('in_app' | 'email')
--   to                 -> to_address (email address or "kind:id" for in_app; NULL when skipped)  -- personal data
--   provider           -> provider ('in_app' | 'local-fake')
--   status             -> status
--   skipReason         -> skip_reason
--   providerMessageId  -> provider_message_id (fm_<16hex>; set on provider accept)
--   attempts[]         -> dispatch_attempts table (child)
--   nextAt             -> next_at
--   actionDeadline     -> action_deadline_at (copied from notification.actionRequired.deadline)
--   createdAt          -> created_at
--   deliveredAt        -> delivered_at
--   openedAt           -> opened_at
--   actionedAt         -> actioned_at
--   failedAt           -> failed_at
--   failReason         -> fail_reason (≤120 chars from callbacks, 199)
-- notes: one row per (notification, destination); a notification gets exactly
--   one in_app row plus one external row per audience rule (destinationsFor 38).
--   Reads: notificationId set-scan (79), by notificationId (157), by
--   providerMessageId (187 — unique lookup, enforced by code today), due rows
--   by status+nextAt (102), org view by audience (210), status counts (231),
--   backlog by status (enterprise.mjs:510), recent 100 (237). Minors: external
--   channels for under-18 players are skipped ('guardian_routed', 47).
-- -----------------------------------------------------------------------------
CREATE TABLE dispatches (
  id                  TEXT PRIMARY KEY,
  notification_id     TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  audience_kind       TEXT NOT NULL CHECK (audience_kind IN ('player','guardian','org_user')), -- snapshot
  audience_id         TEXT NOT NULL,                                                           -- snapshot
  channel             TEXT NOT NULL CHECK (channel IN ('in_app','email')),
  to_address          TEXT,                                                                    -- personal data
  provider            TEXT NOT NULL CHECK (provider IN ('in_app','local-fake')),
  status              TEXT NOT NULL CHECK (status IN (
                        'queued','held_quiet_hours','retrying','accepted','delivered','opened','actioned','skipped','failed')),
  skip_reason         TEXT,
  provider_message_id TEXT,
  next_at             INTEGER NOT NULL,
  action_deadline_at  INTEGER,
  created_at          INTEGER NOT NULL,
  delivered_at        INTEGER,
  opened_at           INTEGER,
  actioned_at         INTEGER,
  failed_at           INTEGER,
  fail_reason         TEXT CHECK (fail_reason IS NULL OR length(fail_reason) <= 120)
) STRICT;

CREATE INDEX dispatches_notification_id ON dispatches(notification_id);
CREATE UNIQUE INDEX dispatches_provider_message_id ON dispatches(provider_message_id)
  WHERE provider_message_id IS NOT NULL;                                   -- enforced by code today (random id)
CREATE INDEX dispatches_status_next_at ON dispatches(status, next_at);
CREATE INDEX dispatches_audience ON dispatches(audience_kind, audience_id);


-- -----------------------------------------------------------------------------
-- dispatch_attempts
-- source: db.dispatches[].attempts[]  pushed at m13/delivery.mjs:106 (quiet re-check note)
--         and :110 (send attempt).
-- owner/writer: m13/delivery.mjs dispatchSweep.
-- lifecycle: append-only; removed with the dispatch.
-- mapping:
--   (no id today) -> id minted by the migration as 'dat-<n>' from the global counter
--   (parent)      -> dispatch_id
--   (array index) -> seq (0-based position; preserves order for the MAX_ATTEMPTS count)
--   at            -> attempted_at (source field is literally `at`)
--   ok            -> ok (absent on note rows → stored 0 with kind='quiet_recheck')
--   error         -> error
--   note          -> note ('quiet hours re-check'); presence of `note` ⇔ kind = 'quiet_recheck'
--                    (the retry counter at 114/122 skips note rows)
-- notes: send rows per dispatch ≤ MAX_ATTEMPTS (4); at most one quiet_recheck row (106).
-- -----------------------------------------------------------------------------
CREATE TABLE dispatch_attempts (
  id           TEXT PRIMARY KEY,
  dispatch_id  TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL CHECK (seq >= 0),
  kind         TEXT NOT NULL CHECK (kind IN ('send','quiet_recheck')),
  attempted_at INTEGER NOT NULL,
  ok           INTEGER NOT NULL DEFAULT 0 CHECK (ok IN (0,1)),
  error        TEXT,
  note         TEXT,
  CHECK ((kind = 'quiet_recheck' AND note IS NOT NULL) OR (kind = 'send' AND note IS NULL))
) STRICT;

CREATE UNIQUE INDEX dispatch_attempts_dispatch_id_seq ON dispatch_attempts(dispatch_id, seq); -- new


-- -----------------------------------------------------------------------------
-- outbox
-- source: db.outbox  TWO writers with two shapes:
--   (a) adapters.mjs:76-77 createMailer.send → {id, ts, to, subject, text, transport, delivered}
--   (b) m13/delivery.mjs:33 fakeSend         → {id, at, channel, to, text(≤300), providerMessageId, provider}
--   container server.mjs:219, seed.mjs:485.
-- owner/writer: adapters.mjs mailer (called from server.mjs 1250/3026/3695,
--         m14/organisations.mjs 236/533/717/918, m23/contactRoutes.mjs:521,
--         m13/enterprise.mjs:88) and m13/delivery.mjs fakeSend.
-- lifecycle: append-only; never pruned; never deleted on player deletion.
-- mapping (unified):
--   id                 -> id (mail-*)
--   ts | at            -> created_at (source field is `ts` in (a), `at` in (b))
--   to                 -> to_address  -- personal data
--   subject            -> subject (NULL for (b) rows)
--   text               -> text (full mail body in (a); first 300 chars of the notification text in (b))
--   transport | provider -> transport ('sendgrid' | 'dev-outbox' from (a); 'local-fake' from (b))
--   delivered          -> delivered ((a): !live, or res.ok when live; (b) never sets it → 0)
--   channel            -> channel ('email' for (b) rows; NULL for (a))
--   providerMessageId  -> provider_message_id ((b) only)
-- notes: KNOWN DEFECT — the (a) rows carry one-time secrets in clear in `text`
--   (guardian email code 1250, club domain code 3026, m14 domain/application
--   codes, m14/m13 invite codes). They are retained here unchanged because the
--   outbox is the dev transport's only record; redaction of `text` for rows
--   older than their code's expiry is a follow-up, not a schema concern.
--   Reads: admin full list newest first (4151), count (4136).
-- -----------------------------------------------------------------------------
CREATE TABLE outbox (
  id                  TEXT PRIMARY KEY,
  created_at          INTEGER NOT NULL,
  to_address          TEXT NOT NULL,                                       -- personal data
  subject             TEXT,
  text                TEXT NOT NULL,                                       -- may contain one-time codes (defect)
  transport           TEXT NOT NULL CHECK (transport IN ('sendgrid','dev-outbox','local-fake')),
  delivered           INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0,1)),
  channel             TEXT CHECK (channel IS NULL OR channel IN ('email')),
  provider_message_id TEXT
) STRICT;

CREATE INDEX outbox_created_at ON outbox(created_at);


-- -----------------------------------------------------------------------------
-- push_log
-- source: db.pushLog  created at adapters.mjs:106-107 (createPushSender.send);
--         container server.mjs:220, seed.mjs:486.
-- owner/writer: adapters.mjs push sender, called only from notify() (server.mjs:818)
--         when deferredPush is false.
-- lifecycle: append-only; never pruned; never deleted on player deletion.
-- mapping:
--   id            -> id (push-*)
--   ts            -> created_at (source field is literally `ts`)
--   audience.kind -> audience_kind ('player' | 'guardian' | 'org_user')
--   audience.id   -> audience_id (polymorphic; no FK)
--   title         -> title (always 'ScoutBox' today)
--   body          -> body (= notification text)
--   transport     -> transport ('expo' | 'dev-log')
-- notes: the row is written whether or not any device token matched. Reads:
--   last 200 newest first (4152), count (4137).
-- -----------------------------------------------------------------------------
CREATE TABLE push_log (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  audience_kind TEXT NOT NULL CHECK (audience_kind IN ('player','guardian','org_user')),
  audience_id   TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  transport     TEXT NOT NULL CHECK (transport IN ('expo','dev-log'))
) STRICT;

CREATE INDEX push_log_created_at ON push_log(created_at);


-- -----------------------------------------------------------------------------
-- push_tokens
-- source: db.pushTokens  created at server.mjs:3787-3788 (POST /push/register);
--         container server.mjs:221, seed.mjs:487.
-- owner/writer: server.mjs /push/register (delete-then-push upsert of the triple).
-- lifecycle: no expiry, no revocation; NOT removed on player deletion or logout.
-- mapping:
--   kind   -> ref_kind (session.kind: 'player' | 'guardian' | 'org' | 'ts_reviewer')
--   refId  -> ref_id (session.refId: players.id / guardians.id / orgs.id / tsReviewers.id — polymorphic, no FK)
--   token  -> token (Expo device push token, kept in CLEAR — see notes)
--   ts     -> registered_at (source field is literally `ts`)
-- notes: natural key (kind, refId, token) — UNIQUE enforced by code today, here the PK.
--   The token is NOT hashed: it is the delivery address handed to Expo on every
--   send (adapters.mjs:115), not a credential for ScoutBox; a hash would make it
--   unusable. Treat as a device identifier (personal data).
--   KNOWN DEFECT: org sessions register ref_kind='org' with ref_id=orgs.id
--   (createSession('org', org.id, …) 1740/1859), but the sender filters on the
--   notification audience kind 'org_user' with an org_users.id (adapters.mjs:111)
--   → org-staff pushes never match a token. Read: by (ref_kind, ref_id) on every live push.
-- -----------------------------------------------------------------------------
CREATE TABLE push_tokens (
  ref_kind      TEXT NOT NULL CHECK (ref_kind IN ('player','guardian','org','ts_reviewer')),
  ref_id        TEXT NOT NULL,
  token         TEXT NOT NULL,                                             -- personal data (device identifier)
  registered_at INTEGER NOT NULL,
  PRIMARY KEY (ref_kind, ref_id, token)
) STRICT;


-- -----------------------------------------------------------------------------
-- blocks
-- source: db.blocks  created at server.mjs:1633 (guardian), 3751 (player),
--         1672 (auto, urgent report); container seed.mjs:482, migration m230_001 (migrations.mjs:250).
-- owner/writer: server.mjs. Read by isBlocked (605) inside EVERY visibility
--         path, m23/journey.mjs:557, m23/journeyRoutes.mjs:104.
-- lifecycle: hard delete only by admin lift (4235-4237). No soft delete.
--         Kept after player deletion.
-- mapping:
--   id       -> id (blk-*)
--   playerId -> player_id
--   orgId    -> org_id
--   by       -> by_kind ('guardian' | 'player' — who placed it; the auto path reuses the reporter's kind)
--   reason   -> reason ('' allowed; 'suspended_pending_review' for the auto path)
--   ts       -> created_at (source field is literally `ts`)
-- notes: NO uniqueness today — the same (player, org) can be blocked several
--   times (e.g. manual + auto); isBlocked is `some()`, lift removes one row.
--   Index (player_id, org_id) is the hottest read in the system. Safeguarding:
--   a block hides the player from the org entirely (404, not 403).
-- -----------------------------------------------------------------------------
CREATE TABLE blocks (
  id         TEXT PRIMARY KEY,
  player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  by_kind    TEXT NOT NULL CHECK (by_kind IN ('guardian','player')),
  reason     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX blocks_player_id_org_id ON blocks(player_id, org_id);


-- -----------------------------------------------------------------------------
-- reports
-- source: db.reports  created at server.mjs:1647-1661 (handleReport: guardian 1623,
--         org_user 2239, player 3746) and 1032-1037 (automatic grooming escalation);
--         container seed.mjs:481, migration m230_001 (migrations.mjs:251).
-- owner/writer: server.mjs; resolved by admin (4164-4181).
-- lifecycle: status 'pending_review' → 'resolved' (both 'dismiss' and other
--         actions land on 'resolved', 4170). Never deleted; kept after player deletion.
-- mapping:
--   id              -> id (rep-*; prefix SHARED with trials.report ids — globally unique via the counter)
--   ts              -> created_at (source field is literally `ts`)
--   by              -> by_kind ('guardian' | 'player' | 'org_user' | 'system')
--   byId            -> by_id (polymorphic: guardians.id / players.id / org_users.id / the literal 'moderation' for system; no FK)
--   byOrgId         -> by_org_id (org_user reports only, 2239)
--   targetKind      -> target_kind ('club' | 'scout' | 'player')
--   targetOrgId     -> target_org_id
--   targetScoutName -> target_scout_name (free text typed by the reporter, not a snapshot)
--   targetPlayerId  -> target_player_id (NULL on the auto path)
--   reason          -> reason
--   urgent          -> urgent
--   status          -> status
--   outcome         -> outcome (admin text)
--   resolvedAt      -> resolved_at
-- notes: an urgent report naming an org creates blocks for the reporter's
--   players and suspends their pending requests (1665-1678). safeguardingCertified
--   (978) scans reports by (target_org_id, urgent, status) on every org view →
--   index. Resolution notifies the reporter at (by_kind, by_id) with type
--   'report_resolved' (4178) — for by_kind='system' that targets audience kind
--   'system', which no reader serves (defect, harmless). Reads: by (by_kind, by_id)
--   per router (1600, 2242, 3331), admin triage sort (4146-4148), by id (4165),
--   pending count (4130).
-- -----------------------------------------------------------------------------
CREATE TABLE reports (
  id                TEXT PRIMARY KEY,
  created_at        INTEGER NOT NULL,
  by_kind           TEXT NOT NULL CHECK (by_kind IN ('guardian','player','org_user','system')),
  by_id             TEXT NOT NULL,
  by_org_id         TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
  target_kind       TEXT NOT NULL CHECK (target_kind IN ('club','scout','player')),
  target_org_id     TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
  target_scout_name TEXT,
  target_player_id  TEXT REFERENCES players(id) ON DELETE RESTRICT,
  reason            TEXT NOT NULL,
  urgent            INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0,1)),
  status            TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','resolved')),
  outcome           TEXT,
  resolved_at       INTEGER,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
) STRICT;

CREATE INDEX reports_by_kind_by_id ON reports(by_kind, by_id);
CREATE INDEX reports_target_org_id_urgent_status ON reports(target_org_id, urgent, status);
CREATE INDEX reports_status_created_at ON reports(status, created_at);


-- -----------------------------------------------------------------------------
-- moderation_log
-- source: db.moderationLog  created at server.mjs:1028 (moderateOrRefuse);
--         container seed.mjs:483, migration m230_001 (migrations.mjs:252).
-- owner/writer: server.mjs moderateOrRefuse, invoked from ~75 call sites across
--         server.mjs and m12–m28 modules (each passes its own context object).
-- lifecycle: append-only; never deleted; kept after player deletion.
-- mapping:
--   id               -> id (mod-*)
--   ts               -> created_at (source field is literally `ts`)
--   context.kind     -> context_kind (open set of ~70 caller labels, e.g. 'org_message',
--                       'guardian_message', 'player_message', 'trial_notes', 'recruitment_room_comment',
--                       'recruitment_contact', 'passport_bio', 'coach_vouch'… → TEXT, no CHECK)
--   context.orgId    -> context_org_id
--   context.userId   -> context_user_id
--   context.channelId-> context_channel_id
--   context.playerId -> context_player_id
--   context.requestId-> context_request_id
--   context.trialId  -> context_trial_id (m23/trialRoutes.mjs:948/976)
--   flags[]          -> flags_json (JSON array of rule codes from domain.mjs:131-142:
--                       email, email_obfuscated, phone_number, phone_spelled, social_handle,
--                       social_platform, url, meet_off_platform, secrecy, personal_probing.
--                       Retained as JSON by design: a variable-length list read only for
--                       display on the admin console, never queried per flag.)
--   severity         -> severity ('contact' | 'grooming')
--   excerpt          -> excerpt (first 140 chars of the BLOCKED text — sensitive: may hold the
--                       very contact details / grooming language that was refused)
-- notes: context ids are kept as plain TEXT without FKs — they are forensic
--   pointers and must survive their subjects. A 'grooming' hit also creates an
--   urgent system report (1031-1037). Reads: admin full list newest first (4243),
--   count (4132), count by severity (4140) → index.
-- -----------------------------------------------------------------------------
CREATE TABLE moderation_log (
  id                 TEXT PRIMARY KEY,
  created_at         INTEGER NOT NULL,
  context_kind       TEXT NOT NULL,
  context_org_id     TEXT,
  context_user_id    TEXT,
  context_channel_id TEXT,
  context_player_id  TEXT,
  context_request_id TEXT,
  context_trial_id   TEXT,
  flags_json         TEXT NOT NULL CHECK (json_valid(flags_json) AND json_type(flags_json) = 'array'),
  severity           TEXT NOT NULL CHECK (severity IN ('contact','grooming')),
  excerpt            TEXT NOT NULL CHECK (length(excerpt) <= 140)          -- sensitive
) STRICT;

CREATE INDEX moderation_log_severity ON moderation_log(severity);
CREATE INDEX moderation_log_created_at ON moderation_log(created_at);


-- -----------------------------------------------------------------------------
-- org_notes
-- source: db.orgNotes  created at server.mjs:1982-1983 (POST /org/players/:id/notes);
--         container by migration m230_003 (migrations.mjs:312) — previously ??= in the handler.
-- owner/writer: server.mjs.
-- lifecycle: never edited, never deleted; KEPT after player deletion (with the note text).
-- mapping:
--   id        -> id (note-*)
--   orgId     -> org_id
--   playerId  -> player_id
--   userId    -> user_id (author org user; SET NULL tolerated — only scout_name is displayed)
--   scoutName -> scout_name (snapshot)
--   text      -> text (moderation is NOT applied to notes — only TEXT_REQUIRED, 1981)
--   ts        -> created_at (source field is literally `ts`)
-- notes: tenant = org_id; org-private (never visible to the player or other
--   orgs). Privacy: free text about a possibly-minor player, retained after
--   deletion — flagged by the survey. Read: by (org_id, player_id) newest first (1969).
-- -----------------------------------------------------------------------------
CREATE TABLE org_notes (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  user_id    TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  scout_name TEXT NOT NULL,                                                -- snapshot
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX org_notes_org_id_player_id_created_at ON org_notes(org_id, player_id, created_at);


-- -----------------------------------------------------------------------------
-- ledger
-- source: db.ledger  created at server.mjs:595-602 (ledgerAppend: `{id, ts, ...entry}`);
--         container seed.mjs:480. ~45 call sites in server.mjs, m12, m13, m15, m16, m29.
-- owner/writer: server.mjs ledgerAppend (the only push). KNOWN DEFECT: m29/index.mjs:618
--         truncates the array (`db.ledger.length = snapshot.ledgerLen`) when a signing
--         rollback fires — the one place "append-only" is violated.
-- lifecycle: append-only; never edited; kept id-only after player deletion.
-- mapping:
--   id        -> id (led-*)
--   ts        -> occurred_at (source field is literally `ts`)
--   type      -> type (open set — includes template literals `${request.type}_accepted`,
--                `${type}_request_to_guardian` etc. Values seen: view, save, shortlist, message,
--                contact_request, trial_request, contact_request_to_guardian,
--                trial_request_to_guardian, contact_accepted, trial_accepted, contact_declined,
--                trial_declined, *_accepted_by_guardian, *_declined_by_guardian,
--                org_blocked_by_guardian, org_blocked_by_player, clip_tagged, trial_report,
--                open_trial_posted, open_trial_registration, open_trial_registration_by_guardian,
--                released_by_club, matchday_logged, account_transitioned, attendance_verified,
--                signing, assessment_submitted, staff_removed, passport_view,
--                passport_recruitment_view, passport_share_created, passport_share_revoked,
--                coach_affiliation_confirmed, opportunity_application, trial_checkin,
--                transition_pack_view, level_review, box_assignment_created,
--                box_assignment_cancelled, box_challenge_published, box_prefs_changed,
--                box_result_invalidated, box_result_restored → TEXT, no CHECK)
--   playerId  -> player_id (NULL for org-only events: open_trial_posted, matchday_logged, staff_removed…)
--   orgId     -> org_id (NULL for platform events; org_name then holds 'ScoutBox' / 'Trust & Safety')
--   orgName   -> org_name (snapshot; falls back to the org id at 1634/3752 when the org is unknown)
--   userId    -> actor_id when actor_kind = 'org_user' (see actor pair below)
--   scoutName -> actor_name (snapshot; also carries the pseudo-actors 'guardian', 'player',
--                'system', 'open day', 'T&S level review')
--   (derived) -> actor_kind: polymorphic actor pair per convention —
--                'org_user' when userId is set (actor_id = userId → org_users.id);
--                'guardian' when scoutName = 'guardian' (actor_id NULL: the guardian id is NOT recorded today);
--                'player' when scoutName = 'player' (actor_id = playerId);
--                'system' when scoutName ∈ {'system','T&S level review'} or orgId IS NULL and userId IS NULL;
--                NULL when none of the above applies (e.g. 'open day' rows without createdByUserId,
--                m16/m15 rows that omit scoutName entirely).
--   detail    -> detail_json (only m13/m15/m16 rows set it; per-type small objects such as
--                {drillId,target}, {shareId,mode}, {from,to,reason}. Retained JSON: shape is
--                per type and never queried — read only in audit exports.)
-- notes: reads — by player_id + type (insightsFor 992, 3734), by player_id (1611 via
--   guardian childIds, 3888 export), by (player_id, org_id) ordered (3062, m29:258),
--   by org_id (2986, 3054, enterprise.mjs:331, audit.mjs:206), by org_id + type
--   'shortlist'/'save' (2011, 2351, imports.mjs:305, planning.mjs:193, groups.mjs:128,
--   nobodyMissed.mjs:129), ts-range windows inside insightsFor (1008-1011).
--   Privacy: a minor's discovery events are visible to the guardian only.
-- -----------------------------------------------------------------------------
CREATE TABLE ledger (
  id          TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  type        TEXT NOT NULL,
  player_id   TEXT REFERENCES players(id) ON DELETE RESTRICT,
  org_id      TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name    TEXT,                                                        -- snapshot
  actor_kind  TEXT CHECK (actor_kind IS NULL OR actor_kind IN ('org_user','guardian','player','system')),
  actor_id    TEXT,                                                        -- org_users.id / players.id; no FK
  actor_name  TEXT,                                                        -- snapshot (source: scoutName)
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;

CREATE INDEX ledger_player_id_type ON ledger(player_id, type);
CREATE INDEX ledger_player_id_org_id_occurred_at ON ledger(player_id, org_id, occurred_at);
CREATE INDEX ledger_org_id_type ON ledger(org_id, type);
CREATE INDEX ledger_occurred_at ON ledger(occurred_at);


-- -----------------------------------------------------------------------------
-- ops_events
-- source: db.opsEvents  created at server.mjs:1844, m13/delivery.mjs:118,
--         m13/enterprise.mjs:338 and :458, m13/imports.mjs:413; container m13/shared.mjs:34.
-- owner/writer: the five call sites above (all `db.opsEvents.push`).
-- lifecycle: append-only; UNBOUNDED, never pruned.
-- mapping:
--   id     -> id (ops-*)
--   at     -> occurred_at (source field is literally `at`)
--   kind   -> kind ('staff_bootstrapped' | 'delivery_failed' | 'audit_export' | 'backup_created' | 'webhook_failed')
--   detail -> detail_json (per-kind object: {orgId,userId,by} / {dispatchId,channel} / {orgId,by} /
--             {dir,files} / {deliveryId,endpointId}. Retained JSON by design: operator display
--             only (last 50, enterprise.mjs:512); never filtered on a detail field.)
-- notes: reads — count by kind (enterprise.mjs:508-509), last 50 newest first (512).
-- -----------------------------------------------------------------------------
CREATE TABLE ops_events (
  id          TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('staff_bootstrapped','delivery_failed','audit_export','backup_created','webhook_failed')),
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;

CREATE INDEX ops_events_kind ON ops_events(kind);
CREATE INDEX ops_events_occurred_at ON ops_events(occurred_at);


-- -----------------------------------------------------------------------------
-- source_changes
-- source: db.sourceChanges (M18.1)  created at m181/sourceChanges.mjs:37-44 (recordSourceChange);
--         container :29. Called from m15/passport.mjs:327 and :343 only.
-- owner/writer: m181/sourceChanges.mjs.
-- lifecycle: append-only; capped at 20,000 rows (oldest spliced, :47) — a change LOG,
--         not history of record. No deletion hook on player deletion.
-- mapping:
--   id           -> id (srcc-*)
--   playerId     -> player_id
--   type         -> type ('position_changed' is the only value written today; 'current_club_confirmed'
--                   is declared derivable and never written → TEXT with CHECK on the one real value)
--   sourceSystem -> source_system ('passport_prefs' | 'position_history')
--   sourceId     -> source_id (the canonical row this change points at; polymorphic, no FK)
--   occurredAt   -> occurred_at (the moment the fact changed — never a record's createdAt)
--   detail       -> detail_json (small structured copy input, e.g. {from, to}; retained JSON by design:
--                   used only to render change copy, never queried)
-- notes: holds no player content. Read: by player_id ordered occurred_at asc (:53-55).
-- -----------------------------------------------------------------------------
CREATE TABLE source_changes (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  type          TEXT NOT NULL CHECK (type IN ('position_changed')),
  source_system TEXT NOT NULL CHECK (source_system IN ('passport_prefs','position_history')),
  source_id     TEXT,
  occurred_at   INTEGER NOT NULL,
  detail_json   TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
) STRICT;

CREATE INDEX source_changes_player_id_occurred_at ON source_changes(player_id, occurred_at);


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


-- -----------------------------------------------------------------------------
-- idv_queue
-- source: db.idvQueue  created at server.mjs:1332-1336 (POST /guardian/verify-id);
--         container by migration m230_003 (migrations.mjs:311) — previously ??= in the handler.
-- owner/writer: server.mjs; status flipped by admin (4222-4229).
-- lifecycle: 'approved' → 'revoked' (and back) by admin; never deleted.
-- mapping:
--   id           -> id (idv-*)
--   guardianId   -> guardian_id
--   guardianName -> guardian_name (snapshot)
--   documentType -> document_type (free text from the guardian)
--   documentRef  -> document_ref_last4 (only the last 4 chars are stored, adapters.mjs:145)
--   provider     -> provider ('onfido' | 'dev-attestation')
--   reference    -> reference (provider check reference, idv_<16hex>; same value as guardians.idvReference)
--   ts           -> created_at (source field is literally `ts`)
--   status       -> status ('approved' | 'revoked')
-- notes: a guardian may verify more than once → several rows; admin updates
--   only the FIRST row for the guardian (4226 `find`) — defect: later rows keep
--   'approved'. Reads: admin full list (4219), first by guardian_id (4226).
-- -----------------------------------------------------------------------------
CREATE TABLE idv_queue (
  id                 TEXT PRIMARY KEY,
  guardian_id        TEXT NOT NULL REFERENCES guardians(id) ON DELETE RESTRICT,
  guardian_name      TEXT NOT NULL,                                        -- snapshot
  document_type      TEXT NOT NULL,
  document_ref_last4 TEXT NOT NULL CHECK (length(document_ref_last4) <= 4),
  provider           TEXT NOT NULL CHECK (provider IN ('onfido','dev-attestation')),
  reference          TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','revoked'))
) STRICT;

CREATE INDEX idv_queue_guardian_id_created_at ON idv_queue(guardian_id, created_at);


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
