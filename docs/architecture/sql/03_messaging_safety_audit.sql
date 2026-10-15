-- =============================================================================
-- 03_messaging_safety_audit.sql — ScoutBox target SQLite schema, part 3
--
-- Scope (source collections → tables):
--   channels            → channels, messages, message_attachments
--   notifications       → notifications                                     (LIVE since migration 0009_notifications, S7a, REGISTERED)
--   notificationPrefs   → notification_prefs, notification_pref_categories  (LIVE since migration 0009_notifications, S7a, REGISTERED)
--   dispatches          → dispatches, dispatch_attempts                  (LIVE since migration 0010_dispatches, S7b, REGISTERED — implemented, pending independent acceptance)
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
-- notifications — LIVE since migration 0009_notifications (S7a, REGISTERED:
--   repositories/migrations/0009_notifications.mjs; repositories/notifications.mjs).
-- source: db.notifications (the blob every build before S7a wrote; imported and retired by 0009,
--         array position → seq). repeatCount was backfilled by the snapshot migration m182_005;
--         the import applies the same normalisation to a pre-M18.2 row (counted, never silent).
-- owner/writer: repositories/notifications.mjs through server.mjs notify() (single creation path,
--         ~170 call sites; create / coalesce), markNotificationsRead (markRead), deletePlayerData
--         (deleteForAudience, inside the deletion unit), m13/delivery.mjs notifyAction (the
--         acknowledgment contract in the same write) and ackHandler (ack, inside a unit with the
--         dispatch blob). Readers: notificationsFor, m13 sweep, m24 inbox/unread count, enterprise backup.
-- lifecycle: read=0 → 1 via markRead; coalesced (occurred_at refreshed, repeat_count++) while
--         unread and identical within 6h — the pre-S7a reverse scan, unchanged: newest first by
--         INSERTION, a stop at the first row older than the cutoff, exactly six hours included.
--         The person's rows are deleted inside the account-deletion unit (preferences retained).
-- mapping:
--   (position)    -> seq (NEW: the durable ordering key; the feed is ORDER BY seq DESC — reverse
--                    insertion order, NEVER occurred_at, which a coalesce refreshes in place)
--   id            -> id (ntf-*; UNIQUE)
--   ts            -> occurred_at (source field is literally `ts`; NOT immutable — refreshed on coalesce)
--   audience.kind -> audience_kind (no CHECK: polymorphic and open — the reports path writes a
--                    'system' audience today, and a stored row must keep importing)
--   audience.id   -> audience_id (polymorphic: players.id / guardians.id / org_users.id; no FK)
--                    An audience is these two fields only: an entry whose audience carries any
--                    other field refuses the whole import or snapshot write (nothing is dropped).
--   type          -> type (open set registered in m182/notificationPrefs.mjs TYPE_CATEGORY;
--                    unknown types are delivered by design → no CHECK)
--   text          -> text
--   refId         -> ref_id (polymorphic, kind implied by type; no FK)
--   read          -> read
--   repeatCount   -> repeat_count (absent on a pre-M18.2 row → 1, as m182_005 did)
--   groupKey      -> group_key (= "type:refId" or NULL; absent → NULL)
--   category      -> category (validated in code against CATEGORY_NAMES — the vocabulary lives in
--                    m182/notificationPrefs.mjs and must not need a schema change to grow; NULL when
--                    the type is unclassified; absent → NULL)
--   deferredPush  -> deferred_push (absent → 0)
--   actionRequired          -> action_required (1 when the object exists)
--   actionRequired.deadline -> action_deadline_at
--   actionRequired.ackedAt  -> action_acked_at
--   actionRequired.ackedBy  -> action_acked_by (the audience_id that acked; same kind as audience_kind)
--   (unknown fields)        -> extra_json (NEW: kept as given — every own key of the entry, an own
--                              "__proto__" key included — and spread back onto the row on read)
--   target        -> derived, not stored: resolved at read time (notificationsFor)
-- notes: writes are STAGED in the running server: visible in memory at once, durable inside the
--   next snapshot save together with the blob edits made alongside (a message, a request), or
--   inside the enclosing unit of work's commit — never ahead of the action announced; the push
--   and the live `notify` event are effects of the write and go out only once that save
--   committed (review of ba6956d, finding 1). Backups
--   export the rows in the legacy collection shape in seq order; a backup from any build restores
--   through migration 0009. An entry the validators refuse (no coercion) refuses the whole import
--   (NOTIFICATIONS_IMPORT_BLOCKED, entry index and reason, never the text).
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
  seq                INTEGER PRIMARY KEY,
  id                 TEXT NOT NULL UNIQUE,
  occurred_at        INTEGER NOT NULL,
  audience_kind      TEXT NOT NULL,
  audience_id        TEXT NOT NULL,
  type               TEXT NOT NULL,
  text               TEXT NOT NULL,
  ref_id             TEXT,
  read               INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0,1)),
  repeat_count       INTEGER NOT NULL DEFAULT 1 CHECK (repeat_count >= 1),
  group_key          TEXT,
  category           TEXT,
  deferred_push      INTEGER NOT NULL DEFAULT 0 CHECK (deferred_push IN (0,1)),
  action_required    INTEGER NOT NULL DEFAULT 0 CHECK (action_required IN (0,1)),
  action_deadline_at INTEGER,
  action_acked_at    INTEGER,
  action_acked_by    TEXT,
  extra_json         TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object')),
  CHECK (action_required = 1 OR (action_deadline_at IS NULL AND action_acked_at IS NULL AND action_acked_by IS NULL))
) STRICT;
CREATE INDEX notifications_audience_seq ON notifications (audience_kind, audience_id, seq);


-- -----------------------------------------------------------------------------
-- notification_prefs — LIVE since migration 0009_notifications (S7a, REGISTERED; repositories/notifications.mjs).
-- source: db.notificationPrefs (M18.2; the blob every build before S7a wrote; imported and retired by 0009).
-- owner/writer: repositories/notifications.mjs updatePrefs, called by m182/notificationPrefs.mjs
--         (PUT /notification-preferences per router), which keeps the vocabulary, the validation,
--         the effective view and the gate.
-- lifecycle: upsert on write; never deleted (retained after a person's notifications are deleted —
--         no cascade, by decision).
-- mapping:
--   audienceKind -> audience_kind (no CHECK: polymorphic, as notifications.audience_kind)
--   audienceId   -> audience_id (polymorphic; no FK)
--   categories{} -> notification_pref_categories table (one row per category the person set)
--   emailIntent  -> email_intent (absent → 0)
--   updatedAt    -> updated_at (NULL until the first write; absent → NULL)
-- notes: natural key (audienceKind, audienceId) is the PRIMARY KEY (one record per person; a
--   duplicate in a backup refuses the import). Effective prefs are DERIVED (stored over defaults,
--   mandatory always on; effective() in m182/notificationPrefs.mjs).
-- -----------------------------------------------------------------------------
CREATE TABLE notification_prefs (
  audience_kind TEXT NOT NULL,
  audience_id   TEXT NOT NULL,
  email_intent  INTEGER NOT NULL DEFAULT 0 CHECK (email_intent IN (0,1)),
  updated_at    INTEGER,
  PRIMARY KEY (audience_kind, audience_id)
) STRICT;


-- -----------------------------------------------------------------------------
-- notification_pref_categories — LIVE since migration 0009_notifications (S7a, REGISTERED).
-- source: db.notificationPrefs[].categories (object category → boolean).
-- owner/writer: repositories/notifications.mjs (updatePrefs; keys validated in code against
--         CATEGORY_NAMES, values must be booleans — the route coerces with `!!v` before it calls).
-- lifecycle: a key is set once written and never removed; absent key = default applies.
-- mapping:
--   categories.<name> -> (category, enabled) one row per stored key
-- notes: NO CHECK on the category list (the vocabulary lives in code) and NO CHECK forbidding a
--   mandatory category stored false: the route accepts numeric zero, coerces it and stores false
--   (observed on 812e13b, S7a review correction 3), and a legacy row may hold it; the effective
--   view and the notification gate force a mandatory category ON. A stored row is never rewritten.
-- -----------------------------------------------------------------------------
CREATE TABLE notification_pref_categories (
  audience_kind TEXT NOT NULL,
  audience_id   TEXT NOT NULL,
  category      TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  PRIMARY KEY (audience_kind, audience_id, category),
  FOREIGN KEY (audience_kind, audience_id) REFERENCES notification_prefs(audience_kind, audience_id) ON DELETE CASCADE
) STRICT;


-- -----------------------------------------------------------------------------
-- dispatches  (LIVE: migration 0010_dispatches, S7b — repositories/dispatches.mjs;
--              implemented, pending independent acceptance)
-- source: db.dispatches — the eighteen-key literal every build since M13 wrote
--         (m13/delivery.mjs dispatchSweep step 1); container m13/shared.mjs
--         (`??= []`, replaced by the repository's read-only view at boot).
-- owner/writer: repositories/dispatches.mjs (staged mode in the server:
--         m13/delivery.mjs sweep / ack / provider callback write through it).
-- lifecycle: status ladder forward-only queued/held_quiet_hours → accepted →
--         delivered → opened → actioned; terminal side states skipped, failed;
--         transient retrying. NEVER pruned: a dispatch whose notification was
--         deleted stays (option A of docs/architecture/s7-readiness-review.md
--         §9.1, as instructed by the review of dc4b559) — `notification_id` is
--         an indexed reference with NO foreign key and NO cascade; the
--         migration counts such orphans (`orphanReferences`) and imports them
--         unchanged. Retention is an open decision, not decided here.
-- ordering: `seq` is the insertion order every reader depends on (the admin
--         view reverses it, the callback lookup takes the FIRST match, the
--         sweep processes rows in it); the migration assigns it from the array
--         position, backup/restore and the rollback preserve it.
-- mapping (the legacy row ↔ the columns; the export reproduces the literal):
--   id                 -> id (dsp-*; UNIQUE — the prefix is shared with m16 disputes, ids are globally unique via the counter)
--   notificationId     -> notification_id (indexed; no FK, no cascade — see lifecycle)
--   audience.kind      -> audience_kind (copied from the notification — snapshot; open vocabulary, no CHECK)
--   audience.id        -> audience_id (snapshot; polymorphic, no FK)
--   channel            -> channel ('in_app' | 'email' today; open vocabulary)
--   to                 -> to_address (email address or "kind:id" for in_app; NULL when skipped)  -- personal data
--   provider           -> provider ('in_app' | 'local-fake' today; open vocabulary)
--   status             -> status (open vocabulary: the ladder's RANK lives in m13/delivery.mjs)
--   skipReason         -> skip_reason
--   providerMessageId  -> provider_message_id (fm_<16hex>; set on provider accept; NOT unique — duplicates are legal,
--                         the callback lookup is the FIRST row in `seq` order whose value strictly equals the event's;
--                         an explicit null matches the first NULL row; an omitted id matches nothing)
--   attempts[]         -> dispatch_attempts (child; position = seq)
--   nextAt             -> next_at (INTEGER: Date.now() or a sum of it)
--   actionDeadline     -> action_deadline_at (copied from notification.actionRequired.deadline; INTEGER or NULL)
--   createdAt          -> created_at (INTEGER)
--   deliveredAt        -> delivered_at (REAL or NULL: written by the callback route as `Number(ev.at) || Date.now()`,
--                         a finite JavaScript number that MAY be fractional; stored as the writer's double, exactly)
--   openedAt           -> opened_at (REAL or NULL: same writer, same contract)
--   actionedAt         -> actioned_at (INTEGER or NULL: the ack's Date.now())
--   failedAt           -> failed_at (INTEGER or NULL: the sweep's / callback's Date.now())
--   failReason         -> fail_reason (UNTRUNCATED at storage: the sweep writes the provider error as it is;
--                         only the callback route truncates its own input to 120 characters before writing)
--   (unknown own keys) -> extra_json (JSON object; spread back first on export; an own "__proto__" key is data)
-- timestamp contract (review of dc4b559, finding 2): every clock this server
--   writes itself is an integer in an INTEGER column (a fraction is refused by
--   the repository and by STRICT); delivered_at / opened_at are the callback
--   route's doubles in REAL columns — node:sqlite binds every JavaScript number
--   as a double, and a REAL column states exactly what is stored, integer-valued
--   or fractional; a non-finite callback `at` (the legacy in-memory state
--   `Number('Infinity') || Date.now()`) is kept in the process's memory exactly
--   as the previous build kept it — no later event replaces it — and stored as
--   NULL (what that build's JSON save persisted; review of 26d492b, finding 3).
--   No value is rounded.
-- notes: one row per (notification, destination); a notification gets exactly
--   one in_app row plus one external row per audience rule (destinationsFor).
--   No uniqueness of (notification_id, channel) is declared (none existed).
--   Reads go through the repository's in-memory mirror (insertion order);
--   the indexes below serve tools and the future SQL readers.
-- -----------------------------------------------------------------------------
CREATE TABLE dispatches (
  seq                 INTEGER PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE,
  notification_id     TEXT NOT NULL,
  audience_kind       TEXT NOT NULL,
  audience_id         TEXT NOT NULL,
  channel             TEXT NOT NULL,
  to_address          TEXT,
  provider            TEXT NOT NULL,
  status              TEXT NOT NULL,
  skip_reason         TEXT,
  provider_message_id TEXT,
  next_at             INTEGER NOT NULL,
  action_deadline_at  INTEGER,
  created_at          INTEGER NOT NULL,
  delivered_at        REAL,
  opened_at           REAL,
  actioned_at         INTEGER,
  failed_at           INTEGER,
  fail_reason         TEXT,
  extra_json          TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;
CREATE INDEX dispatches_notification ON dispatches (notification_id);
CREATE INDEX dispatches_provider_message ON dispatches (provider_message_id);
CREATE INDEX dispatches_status_next ON dispatches (status, next_at);
CREATE INDEX dispatches_audience_seq ON dispatches (audience_kind, audience_id, seq);


-- -----------------------------------------------------------------------------
-- dispatch_attempts  (LIVE: migration 0010_dispatches, S7b)
-- source: db.dispatches[].attempts[] — two shapes: a send {at, ok, error}
--         (m13/delivery.mjs dispatchSweep step 2) and a quiet-hours re-check
--         note {at, note} (at most one per dispatch, never counted as a send).
-- owner/writer: repositories/dispatches.mjs recordAttempt (append-only; removed
--         with the dispatch through the internal cascade — the only cascade here).
-- mapping:
--   (parent)      -> dispatch_seq (the parent's seq; internal FK, ON DELETE CASCADE)
--   (array index) -> seq (0-based position; the key is the pair — NO minted id, no global counter consumed)
--   at            -> attempted_at (INTEGER)
--   ok            -> ok (send rows: 0/1 and NEVER NULL; note rows: NULL)
--   error         -> error (send rows: the provider error or NULL; note rows: NULL)
--   note          -> note (note rows: the text; send rows: NULL)
--   (shape)       -> kind ('send' | 'quiet_recheck')
-- the total shape CHECK (review of dc4b559, finding 1): SQLite treats a NULL
--   CHECK result as a pass, so `ok IN (0,1)` alone admitted a send row with
--   ok NULL; the predicate below names `ok IS NOT NULL` for a send row and
--   `ok IS NULL AND error IS NULL AND note IS NOT NULL` for a note row, so it
--   is total. scripts/testDispatches.mjs proves it through direct SQL.
-- notes: send rows per dispatch ≤ MAX_ATTEMPTS (4) by the sweep's rule, not by
--   a constraint (a legacy row is imported as it is).
-- -----------------------------------------------------------------------------
CREATE TABLE dispatch_attempts (
  dispatch_seq INTEGER NOT NULL REFERENCES dispatches(seq) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('send', 'quiet_recheck')),
  attempted_at INTEGER NOT NULL,
  ok           INTEGER,
  error        TEXT,
  note         TEXT,
  PRIMARY KEY (dispatch_seq, seq),
  CHECK ((kind = 'send' AND ok IS NOT NULL AND ok IN (0, 1) AND note IS NULL)
      OR (kind = 'quiet_recheck' AND ok IS NULL AND error IS NULL AND note IS NOT NULL))
) STRICT;


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
