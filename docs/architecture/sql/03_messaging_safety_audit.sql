-- =============================================================================
-- 03_messaging_safety_audit.sql — ScoutBox target SQLite schema, part 3
--
-- Scope (source collections → tables):
--   channels            → channels, messages, message_attachments           (LIVE since migration 0012_channels, S7d, REGISTERED — independently accepted at 4f954ad; channels REBUILT by migration 0015_recruitment (S8a-core) with the real request_id foreign key — implemented, pending independent acceptance)
--   notifications       → notifications                                    (LIVE since migration 0009_notifications, S7a, REGISTERED)
--   notificationPrefs   → notification_prefs, notification_pref_categories  (LIVE since migration 0009_notifications, S7a, REGISTERED)
--   dispatches          → dispatches, dispatch_attempts                  (LIVE since migration 0010_dispatches, S7b, REGISTERED — independently accepted at ac50b60)
--   outbox              → outbox                                           (LIVE since migration 0011_outbox_push, S7c, REGISTERED — implemented, pending independent acceptance)
--   pushLog             → push_log                                         (LIVE since migration 0011_outbox_push, S7c, REGISTERED — implemented, pending independent acceptance)
--   pushTokens          → push_tokens                                      (LIVE since migration 0011_outbox_push, S7c, REGISTERED — implemented, pending independent acceptance)
--   blocks              → blocks                                           (LIVE since migration 0013_safety_audit, S6b, REGISTERED — implemented, pending independent acceptance)
--   reports             → reports                                          (LIVE since migration 0013_safety_audit, S6b, REGISTERED — implemented, pending independent acceptance)
--   moderationLog       → moderation_log                                   (LIVE since migration 0013_safety_audit, S6b, REGISTERED — implemented, pending independent acceptance)
--   orgNotes            → org_notes                                        (LIVE since migration 0013_safety_audit, S6b, REGISTERED — implemented, pending independent acceptance)
--   ledger              → ledger                                           (LIVE since migration 0013_safety_audit, S6b, REGISTERED — implemented, pending independent acceptance)
--   opsEvents           → ops_events                                       (LIVE since migration 0013_safety_audit, S6b, REGISTERED — implemented, pending independent acceptance)
--   sourceChanges       → source_changes                                   (LIVE since migration 0013_safety_audit, S6b, REGISTERED — implemented, pending independent acceptance)
--   emailChallenges     → email_challenges   (LIVE since migration 0008_one_time_codes, S6a, REGISTERED)
--   pairingCodes        → pairing_codes      (LIVE since migration 0008_one_time_codes, S6a, REGISTERED)
--   idvQueue            → idv_queue                                        (LIVE since migration 0013_safety_audit, S6b, REGISTERED — implemented, pending independent acceptance; Domain G strict in code, Q4b)
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
-- channels — LIVE since migration 0012_channels (S7d, REGISTERED — implemented, pending
--   independent acceptance: repositories/migrations/0012_channels.mjs; repositories/channels.mjs;
--   docs/architecture/s7-readiness-review.md §11.5 as corrected in §11.7/§11.8, approved by the
--   Founder's decisions D-A and D-B recorded in §11.9).
-- source: db.channels (the blob every build since M9 wrote; imported and retired by 0012, array
--         position → seq). The container is still created by seed.mjs and the snapshot migration
--         m230_001 (m182/migrations.mjs) before the data layer attaches; attachDataLayer drops that
--         array and defines db.channels as a read-only view over the mirror.
-- owner/writer: repositories/channels.mjs through server.mjs openChannel (the acceptance routes,
--         player and guardian), postMessage (appendMessage), the three /channels/:id/read routes
--         (markRead) and deletePlayerData (deleteForPlayer, inside the account-deletion unit).
--         Readers unchanged: the three list routes, the export, the admin audit, the SSE lookup,
--         m26 (transaction linked threads, read-only), the enterprise backup (exportRows).
-- lifecycle: no status field; "closed" is DERIVED on every read (channelClosedForOrg /
--         channelClosedForCounterparty) from blocks, org.suspended and visibility. Deleted with
--         every message, attachment and receipt when the player is deleted — EXPLICITLY, by
--         deleteForPlayer inside the deletion unit (D-B: today's behaviour reproduced for this
--         storage-only step; no CASCADE, no RESTRICT, no retention rule — retention stays OPEN for S4b).
-- mapping (the openChannel literal, key for key):
--   (array position) -> seq (the durable thread order every reader sees)
--   id            -> id (chan-*)
--   requestId     -> request_id (UNIQUE: a request opens one thread, enforced by the routes and the
--                    repository; since migration 0015 (S8a-core) a REAL FOREIGN KEY to
--                    recruitment_requests(id) ON DELETE RESTRICT — the conversion D-A approved; the
--                    0012 definition had no key and checked the request in code against the requests
--                    blob. open() still checks the request against the live collection, the import
--                    and every snapshot write still validate the FINAL combined state, and the prune
--                    of a request still named by a thread is refused with ids)
--   playerId      -> player_id (NO foreign key and NO lifecycle clause — D-B, see lifecycle)
--   playerName    -> player_name (snapshot; nullable; absent recorded in absent_keys_json)
--   orgId         -> org_id (REFERENCES orgs — kept: organisations are upserted and pruned, never rewritten)
--   orgName       -> org_name (snapshot)
--   orgVerified   -> org_verified (snapshot of the org's verified flag at open time; nullable)
--   scoutName     -> scout_name (snapshot; nullable)
--   scoutRole     -> scout_role (snapshot; nullable)
--   counterparty  -> counterparty ('player' | 'guardian' = request.routedTo)
--   guardianId    -> guardian_id (NULL for adult players; NO foreign key — a bounded code-validated
--                    reference, not a SQLite necessity (review of 8330f08): open() refuses a guardian
--                    that does not exist and the final-state assertion checks every retained or
--                    incoming channel against the final guardians table after every identity rewrite)
--   createdAt     -> created_at
--   messages[]    -> messages table (child, position = array index)
--   readBy.org          -> read_by_org_at
--   readBy.counterparty -> read_by_counterparty_at
--   (absent optional keys: playerName, orgVerified, scoutName, scoutRole, guardianId, readBy.org,
--    readBy.counterparty) -> absent_keys_json (a JSON array of the ABSENT keys; NULL when every key
--                    was present — absence is preserved as absence, a NULL column alone cannot tell
--                    present-and-null from absent)
--   orgUserIdForNotify and every other unknown own field -> extra_json (a JSON object; the unknown
--                    keys INSIDE readBy are nested under "readBy"); spread back FIRST on export.
--                    orgUserIdForNotify is never written by the current creator but is read by
--                    postMessage and observable through the spread views and the export — preserved exactly.
-- notes: tenant = org_id; minors: the child is never a party — counterparty is
--   the guardian. Admin /admin/channels returns every channel with ids.
--   Reads: by org_id, by guardian_id, by player_id+counterparty, by id+owner (all
--   message/read/typing routes), by id alone (m26, SSE).
-- -----------------------------------------------------------------------------
CREATE TABLE channels (
  seq                     INTEGER PRIMARY KEY,
  id                      TEXT NOT NULL UNIQUE,
  request_id              TEXT NOT NULL REFERENCES recruitment_requests(id) ON DELETE RESTRICT,  -- the real key since migration 0015 (S8a-core, D-A converted)
  player_id               TEXT NOT NULL,
  player_name             TEXT,
  org_id                  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name                TEXT NOT NULL,
  org_verified            INTEGER CHECK (org_verified IS NULL OR org_verified IN (0, 1)),
  scout_name              TEXT,
  scout_role              TEXT,
  counterparty            TEXT NOT NULL CHECK (counterparty IN ('player', 'guardian')),
  guardian_id             TEXT,
  created_at              INTEGER NOT NULL,
  read_by_org_at          INTEGER,
  read_by_counterparty_at INTEGER,
  absent_keys_json        TEXT CHECK (absent_keys_json IS NULL OR (json_valid(absent_keys_json) AND json_type(absent_keys_json) = 'array')),
  extra_json              TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;

CREATE UNIQUE INDEX channels_request_id ON channels (request_id);          -- one thread per request
CREATE INDEX channels_org_id ON channels (org_id);
CREATE INDEX channels_guardian_id ON channels (guardian_id);
CREATE INDEX channels_player_id_counterparty ON channels (player_id, counterparty);


-- -----------------------------------------------------------------------------
-- messages — LIVE since migration 0012_channels (S7d, REGISTERED — implemented, pending independent acceptance)
-- source: db.channels[].messages[] (the postMessage literal; imported with its thread by 0012,
--         array index → position)
-- owner/writer: repositories/channels.mjs appendMessage, called by server.mjs postMessage
--         (guardian, org and player message routes).
-- lifecycle: append-only; never edited; removed only with the channel (ON DELETE CASCADE from the
--         explicit thread deletion).
-- mapping (the postMessage literal, key for key):
--   (array index) -> position (UNIQUE per channel: the durable message order; a tie on ts keeps its order)
--   id            -> id (msg-*)
--   (parent)      -> channel_id
--   ts            -> created_at (source field is literally `ts`)
--   sender.kind   -> sender_kind ('player' | 'guardian' | 'org_user' — the three kinds the routes produce)
--   sender.id     -> sender_id (polymorphic: players.id / guardians.id / org_users.id; no FK)
--   sender.name   -> sender_name (snapshot; for org_user it is "Name · Role · Org" composed by the route;
--                    nullable; an absent key is recorded as "sender.name" in absent_keys_json)
--   text          -> text (moderated before write; moderation hits are refused, never stored here)
--   attachment    -> message_attachments table (0..1 row per message; the key is always present and null
--                    when the writer sends no attachment; an ABSENT key — a legacy record — is recorded in
--                    absent_keys_json)
--   clientMsgId   -> client_msg_id (present only when the client sent one — the writer omits the key
--                    otherwise, never null; the route bounds it to 64 chars)
--   every unknown own field -> extra_json (the unknown keys INSIDE sender nested under "sender")
-- notes: ordering is array order = position (oldest→newest). Idempotency: a resend
--   with the same (clientMsgId, sender.kind, sender.id) inside the same channel
--   returns the existing message — postMessage reads the thread's view first, as before;
--   no uniqueness index is declared for it (the rule stays the writer's). A ledger row of
--   type 'message' is appended per message.
-- -----------------------------------------------------------------------------
CREATE TABLE messages (
  seq              INTEGER PRIMARY KEY,
  id               TEXT NOT NULL UNIQUE,
  channel_id       TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  sender_kind      TEXT NOT NULL CHECK (sender_kind IN ('player', 'guardian', 'org_user')),
  sender_id        TEXT NOT NULL,
  sender_name      TEXT,
  text             TEXT NOT NULL,
  client_msg_id    TEXT,
  absent_keys_json TEXT CHECK (absent_keys_json IS NULL OR (json_valid(absent_keys_json) AND json_type(absent_keys_json) = 'array')),
  extra_json       TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;

CREATE UNIQUE INDEX messages_channel_position ON messages (channel_id, position);


-- -----------------------------------------------------------------------------
-- message_attachments — LIVE since migration 0012_channels (S7d, REGISTERED — implemented, pending independent acceptance)
-- source: db.channels[].messages[].attachment (the two shapes buildAttachment produces; imported with
--         its message by 0012)
-- owner/writer: repositories/channels.mjs appendMessage (one attachment per message, or none).
-- lifecycle: immutable; removed with the message (ON DELETE CASCADE).
-- mapping (shape depends on kind; the CHECK ties each kind to its columns):
--   kind                 -> kind ('clip' | 'trial_report')
--   clip.mediaId         -> media_id (players[].media[].id; polymorphic to the media table of 01, no FK — the
--                           clip may be deleted later while the message keeps the reference)
--   clip.title           -> title (snapshot; nullable)
--   clip.url             -> url (snapshot; nullable)
--   clip.verifiedClip    -> verified_clip (snapshot boolean of !!m.verifiedClip)
--   trial_report.reportId -> report_id (players[].trialReports[].id = trials.report.id, rep-*; no FK)
--   trial_report.orgName  -> org_name (snapshot; nullable)
--   trial_report.summary  -> summary (pre-rendered metrics line, snapshot; nullable)
--   every unknown own field -> extra_json
-- notes: an org sender may only attach a trial report its own org wrote (the route's rule).
-- -----------------------------------------------------------------------------
CREATE TABLE message_attachments (
  message_id    TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('clip', 'trial_report')),
  media_id      TEXT,
  title         TEXT,
  url           TEXT,
  verified_clip INTEGER CHECK (verified_clip IS NULL OR verified_clip IN (0, 1)),
  report_id     TEXT,
  org_name      TEXT,
  summary       TEXT,
  extra_json    TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object')),
  CHECK ((kind = 'clip' AND media_id IS NOT NULL AND verified_clip IS NOT NULL AND report_id IS NULL AND org_name IS NULL AND summary IS NULL)
      OR (kind = 'trial_report' AND report_id IS NOT NULL AND media_id IS NULL AND title IS NULL AND url IS NULL AND verified_clip IS NULL))
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
-- outbox   (LIVE since migration 0011_outbox_push, S7c — repositories/outboxPush.mjs;
--           docs/architecture/s7-readiness-review.md §10 as corrected by the review of 6ca66ba)
-- source: db.outbox  TWO writers with two literals, told apart STRUCTURALLY (never by a value):
--   (a) the MAILER record   adapters.mjs createMailer.send → {id, ts, to, subject, text, transport, delivered}
--   (b) the DELIVERY record m13/delivery.mjs fakeSend     → {id, at, channel, to, text(≤300), providerMessageId, provider}
--   a shape's keys must ALL be present and none of the other shape's; an entry matching both
--   or neither is refused by position. `source` records which literal a row is.
-- owner/writer: the outbox repository, called by adapters.mjs createMailer.send (nine route
--         sites: server.mjs guardian sign-up, club e-mail challenge (the one `secrets` site),
--         reference request; m14/organisations.mjs 236/533/717/918; m23/contactRoutes.mjs:521;
--         m13/enterprise.mjs:88) and by m13/delivery.mjs fakeSend; the mailer's `markDelivered`
--         after the live provider call settles.
-- lifecycle: append-only; never pruned; never deleted on player deletion; `seq` is the
--         insertion order every reader depends on (the admin view lists newest first).
-- mapping:
--   (position)         -> seq (the array position at import; assigned at insert afterwards)
--   id                 -> id (mail-*; UNIQUE)
--   (shape)            -> source ('mailer' for (a), 'delivery' for (b))
--   ts | at            -> created_at (source field is `ts` in (a), `at` in (b))
--   to                 -> to_address  -- personal data; NULL is a VALUE a writer produces: the real
--                                        boot sweep over an accepted queued dispatch with to:null writes
--                                        a delivery record with to:null (review of 6ca66ba) — kept as
--                                        present-and-null on the way back; a STRING goes here
--   to (not a string)  -> to_json  -- the value JSON-encoded, to_address NULL, decoded on read: POST /org/invites
--                                   (RegExp.test coerces, the invite stores String(email), the mailer gets the
--                                   ORIGINAL value) and the m14 player invite (emailProblem coerces) hand the
--                                   mailer an ARRAY, which the accepted build persisted (review of 40aa05c, F2)
--   subject            -> subject ((a) only; NULL = the key is absent in (b))
--   text               -> text (the withheld mail text in (a) — S6a: every `secrets` value replaced by the
--                                placeholder; the dev full text lives in process memory only, never here;
--                                the first 300 chars of the notification text in (b))
--   transport | provider -> transport (as written: 'sendgrid' | 'dev-outbox' from (a); 'local-fake' from (b);
--                                      OPEN vocabulary, no CHECK)
--   delivered          -> delivered ((a) only, 0/1 from the boolean; NULL = the key is absent in (b))
--   channel            -> channel ((b) only, as written; NULL = absent in (a); OPEN vocabulary)
--   providerMessageId  -> provider_message_id ((b) only; NULL = absent in (a))
--   (unknown own keys) -> extra_json (detached JSON, spread back FIRST on export)
-- notes: the structural CHECK below is total: a mailer row carries subject and delivered and no
--   channel/provider_message_id; a delivery row carries channel and provider_message_id and no
--   subject/delivered — so NULL always means "absent key" and the way back rebuilds exactly the
--   writer's literal with exactly its keys. The six plain-code mail sites (every site but the club
--   challenge) still write their one-time code into `text`: carried through unchanged (an owner
--   decision outside S7c, not a schema concern); the one `secrets` site persists the placeholder.
--   Reads: /admin/outbox (newest first, the dev full text merged from memory), /admin/overview count.
-- -----------------------------------------------------------------------------
CREATE TABLE outbox (
  seq                 INTEGER PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE,
  source              TEXT NOT NULL CHECK (source IN ('mailer', 'delivery')),
  created_at          INTEGER NOT NULL,
  to_address          TEXT,                                                -- personal data; NULL accepted (an accepted queued dispatch)
  to_json             TEXT CHECK (to_json IS NULL OR (json_valid(to_json) AND json_type(to_json) NOT IN ('text', 'null'))),  -- any OTHER JSON destination value, losslessly (review of 40aa05c, F2)
  subject             TEXT,
  text                TEXT NOT NULL,                                       -- withheld where the writer withheld; may contain a one-time code elsewhere (carried through)
  transport           TEXT NOT NULL,
  delivered           INTEGER,
  channel             TEXT,
  provider_message_id TEXT,
  extra_json          TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object')),
  CHECK (to_address IS NULL OR to_json IS NULL),                          -- a destination is in one column, or null
  CHECK ((source = 'mailer' AND subject IS NOT NULL AND delivered IS NOT NULL AND delivered IN (0, 1) AND channel IS NULL AND provider_message_id IS NULL)
      OR (source = 'delivery' AND subject IS NULL AND delivered IS NULL AND channel IS NOT NULL AND provider_message_id IS NOT NULL))
) STRICT;

CREATE INDEX outbox_created_at ON outbox (created_at);


-- -----------------------------------------------------------------------------
-- push_log   (LIVE since migration 0011_outbox_push, S7c — repositories/outboxPush.mjs)
-- source: db.pushLog  the SENDER record adapters.mjs createPushSender.send →
--         {id, ts, audience: {kind, id}, title, body, transport}.
-- owner/writer: the push log repository, called by the push sender, which notify()
--         (server.mjs) runs through the notification repository's after-durable effect
--         when deferredPush is false — i.e. AFTER the save carrying the notification row
--         committed, so the push row is never in that save; the sender's nextId() calls the
--         server's debounced persist(), the existing best-effort scheduling (about two
--         seconds, not a guarantee) that lands it in a later save (review of 6ca66ba, D1).
-- lifecycle: append-only; never pruned (the admin view's 200-row window is a read-time slice);
--         never deleted on player deletion; `seq` is the insertion order.
-- mapping:
--   (position)    -> seq
--   id            -> id (push-*; UNIQUE)
--   ts            -> created_at (source field is literally `ts`)
--   audience.kind -> audience_kind (OPEN, as notifications.audience_kind: the notification
--                                   repository validated the audience; no CHECK)
--   audience.id   -> audience_id (polymorphic; no FK)
--   title         -> title (always 'ScoutBox' today)
--   body          -> body (= notification text)
--   transport     -> transport ('expo' | 'dev-log' as written; OPEN, no CHECK)
--   (unknown own keys) -> extra_json
-- notes: the row is written whether or not any device token matched (the staff-push
--   identity mismatch — tokens registered under 'org', pushes addressed to 'org_user' — is
--   carried through unchanged). Reads: /admin/push-log (last 200, newest first), /admin/overview count.
-- -----------------------------------------------------------------------------
CREATE TABLE push_log (
  seq           INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  audience_kind TEXT NOT NULL,
  audience_id   TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  transport     TEXT NOT NULL,
  extra_json    TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;

CREATE INDEX push_log_created_at ON push_log (created_at);
CREATE INDEX push_log_audience_seq ON push_log (audience_kind, audience_id, seq);


-- -----------------------------------------------------------------------------
-- push_tokens   (LIVE since migration 0011_outbox_push, S7c — repositories/outboxPush.mjs)
-- source: db.pushTokens  the ROUTE record POST /push/register (server.mjs) → {kind, refId, token, ts}.
-- owner/writer: the push tokens repository (`register`), called by the route; read by the
--         push sender (`forAudience`) on every live push.
-- lifecycle: no expiry, no revocation; NOT removed on player deletion or logout; `seq` is
--         "last registration last" — the route's filter-then-push order.
-- mapping:
--   (position)    -> seq
--   kind   -> ref_kind (the session kind as written: 'player' | 'guardian' | 'org' | 'ts_reviewer' today; OPEN, no CHECK)
--   refId  -> ref_id (session.refId — polymorphic, no FK)
--   token  -> token_json: ANY JSON value the route accepted (it checks truthiness only — the review
--             of 6ca66ba registered a number, a string, a boolean, objects and arrays), stored
--             LOSSLESSLY as JSON text and decoded on read to the value and type it was registered
--             with (a consumer never sees the encoded string; the sender hands Expo the same value)
--   ts     -> registered_at (source field is literally `ts`)
--   (unknown own keys) -> extra_json
-- notes: NO uniqueness constraint. The route's rule is JavaScript `===` on the token: a primitive
--   collapses an earlier row of the same (kind, refId) holding the same value of the same type
--   (424242 and '424242' are different tokens); an object or an array NEVER matches an existing
--   row (every request body is freshly parsed), so structurally equal objects are separate rows.
--   `register` reproduces exactly that (in SQL: equality of the JSON text, which for primitives is
--   the same relation; objects and arrays excluded). A UNIQUE on the JSON text would collapse the
--   object/array rows — rejected. The token is NOT hashed: it is the delivery address handed to
--   Expo, not a credential for ScoutBox. Treat as a device identifier (personal data).
--   KNOWN DEFECT, carried through: org sessions register ref_kind='org' with ref_id=orgs.id while
--   the sender filters on the notification audience ('org_user', org_users.id) → org-staff pushes
--   never match a token. Not re-keyed here.
-- -----------------------------------------------------------------------------
CREATE TABLE push_tokens (
  seq           INTEGER PRIMARY KEY,
  ref_kind      TEXT NOT NULL,
  ref_id        TEXT NOT NULL,
  token_json    TEXT NOT NULL CHECK (json_valid(token_json)),              -- personal data (device identifier), any JSON type
  registered_at INTEGER NOT NULL,
  extra_json    TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;

CREATE INDEX push_tokens_ref_seq ON push_tokens (ref_kind, ref_id, seq);


-- =============================================================================
-- S6b (migration 0013_safety_audit, REGISTERED — implemented, pending independent
-- acceptance; repositories/safetyAudit.mjs, repositories/migrations/0013_safety_audit.mjs;
-- docs/architecture/sqlite-migration-plan.md §D.4 Candidate A as accepted at 1792fc7, and
-- the Founder's decisions of 19 October 2026: Q4 — the five historical player references
-- stay when the player is absent, counted and never refused, invented or deleted; Q4b —
-- idv_queue moves now with a STRICT application check that the guardian exists (no FK
-- yet; the database constraint is a later step); Q5 — lifting a block deletes its row).
-- The eight tables below are the IMPLEMENTED DDL (SAFETY_AUDIT_DDL), column for column:
-- NO foreign key on any of them (the player references are tolerant per Q4; the
-- organisation and staff references are historical pointers, because POST /player/block
-- and handleReport accept an unchecked orgId / targetOrgId / byOrgId today and that
-- shape is preserved — stated as a shape-compatibility decision, not a design goal),
-- NO vocabulary CHECK (open sets: by_kind, status, kind, type, severity, provider…
-- are stored as the writers pass them), every literal column nullable (an absent key
-- is absence, recorded in absent_keys_json), `seq INTEGER PRIMARY KEY` as the durable
-- order and `id TEXT NOT NULL UNIQUE` as the writer's id. The target-model constraints
-- the earlier drafts of this file proposed (NOT NULL, CHECK vocabularies, RESTRICT
-- references, a derived actor kind) are NOT what 0013 creates; they remain OPEN for the
-- milestone that decides tombstones/retention (S4b) and the foreign keys (§D.2a).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- blocks — LIVE since migration 0013_safety_audit (S6b, REGISTERED — implemented,
--   pending independent acceptance). Repository: repositories/safetyAudit.mjs (blocks).
-- source: db.blocks (the blob every build wrote; imported and retired by 0013, array position
--         → seq). The container is still created by seed.mjs and the snapshot migration
--         m230_001 before the data layer attaches; attachDataLayer drops that array and
--         defines db.blocks as a read-only view over the mirror (insertion order).
-- owner/writer: safetyAudit.blocks.append from server.mjs — the guardian block route, the
--         player block route (an UNCHECKED orgId: stored as received) and handleReport's
--         urgent suspension (reason 'suspended_pending_review'); safetyAudit.blocks.remove
--         from the admin lift route (Q5: the row is deleted, as it always was; no lifted_at).
-- lifecycle: append + delete-on-lift; KEPT after player deletion with the now-unresolved
--         player_id (Q4: counted by the data-layer report, never refused or invented).
-- mapping (the route literal, key for key):
--   (array position) -> seq
--   id       -> id (blk-*)
--   playerId -> player_id (NO foreign key — Q4, tolerant historical reference; indexed)
--   orgId    -> org_id (NO foreign key — the player route accepts an unchecked id)
--   by       -> by_kind ('guardian' | 'player' today; the auto path reuses the reporter's kind; open)
--   reason   -> reason ('' allowed; an off-type value kept in offtype_json)
--   ts       -> created_at (source field is literally `ts`)
--   (every S6b table also carries the three lossless columns of the writers' literals:
--   absent_keys_json — a JSON array of the known keys the writer's object did NOT carry
--   (absence is restored as absence, never as null); offtype_json — a JSON object of the
--   known keys whose value is not the column's type, kept exactly (a numeric or object
--   targetPlayerId, an object orgId, a numeric reason); extra_json — a JSON object of the
--   unknown own fields, restored first, in their order. `seq` is the array position at
--   the import and the insertion order afterwards: every list, export, backup and the
--   rollback read the rows in `seq` order, exactly as the array was read.)
-- notes: NO uniqueness — the same (player, org) can be blocked several times; isBlocked is
--   `some()` on the view, lift removes one row. (player_id, org_id) is the hottest read.
-- -----------------------------------------------------------------------------
CREATE TABLE blocks (
  seq                INTEGER PRIMARY KEY,
  id                 TEXT NOT NULL UNIQUE,
  player_id          TEXT,
  org_id             TEXT,
  by_kind            TEXT,
  reason             TEXT,
  created_at         INTEGER,
  absent_keys_json   TEXT CHECK (absent_keys_json IS NULL OR (json_valid(absent_keys_json) AND json_type(absent_keys_json) = 'array')),
  offtype_json       TEXT CHECK (offtype_json IS NULL OR (json_valid(offtype_json) AND json_type(offtype_json) = 'object')),
  extra_json         TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;
CREATE INDEX blocks_player_id_org_id ON blocks (player_id, org_id);

-- -----------------------------------------------------------------------------
-- reports — LIVE since migration 0013_safety_audit (S6b, REGISTERED — implemented,
--   pending independent acceptance). Repository: repositories/safetyAudit.mjs (reports).
-- source: db.reports (imported and retired by 0013, array position → seq; container seed.mjs
--         / m230_001 as for blocks; db.reports is the read-only view).
-- owner/writer: safetyAudit.reports.append from handleReport (guardian / player / org_user
--         callers — the org caller adds byOrgId) and from moderateOrRefuse (the automatic
--         grooming escalation: by 'system', byId 'moderation', NO targetPlayerId key);
--         safetyAudit.reports.patch(id, {status, outcome, resolvedAt}) from the admin resolve
--         route — the three fields the route always changed, by row id.
-- lifecycle: 'pending_review' → 'resolved' (dismiss and every other action); never deleted;
--         KEPT after player deletion (Q4). A report about a club, a scout or an automatic
--         escalation has no player target; a report naming an UNKNOWN player is accepted
--         (handleReport stores a truthy targetPlayerId as received, any type — not narrowed).
-- mapping (the handleReport literal, key for key):
--   (array position) -> seq
--   id              -> id (rep-*)
--   ts              -> created_at (source field is literally `ts`)
--   by              -> by_kind ('guardian' | 'player' | 'org_user' | 'system'; open)
--   byId            -> by_id (polymorphic; no FK)
--   byOrgId         -> by_org_id (org_user reports only; absent otherwise → absent_keys_json; no FK)
--   targetKind      -> target_kind ('club' | 'scout' | 'player'; open)
--   targetOrgId     -> target_org_id (NO foreign key — accepted unchecked)
--   targetScoutName -> target_scout_name (free text typed by the reporter)
--   targetPlayerId  -> target_player_id (NO foreign key — Q4; a non-string value kept in offtype_json; indexed)
--   reason          -> reason
--   urgent          -> urgent (0/1; a non-boolean kept in offtype_json)
--   status          -> status
--   outcome         -> outcome
--   resolvedAt      -> resolved_at
--   (every S6b table also carries the three lossless columns of the writers' literals:
--   absent_keys_json — a JSON array of the known keys the writer's object did NOT carry
--   (absence is restored as absence, never as null); offtype_json — a JSON object of the
--   known keys whose value is not the column's type, kept exactly (a numeric or object
--   targetPlayerId, an object orgId, a numeric reason); extra_json — a JSON object of the
--   unknown own fields, restored first, in their order. `seq` is the array position at
--   the import and the insertion order afterwards: every list, export, backup and the
--   rollback read the rows in `seq` order, exactly as the array was read.)
-- notes: an urgent report naming an org creates blocks for the reporter's players and
--   suspends their pending requests (same request, next save). safeguardingCertified scans
--   (target_org_id, urgent, status) on every org view → index; admin triage sorts by status
--   and time; reporters read their own by (by_kind, by_id).
-- -----------------------------------------------------------------------------
CREATE TABLE reports (
  seq                INTEGER PRIMARY KEY,
  id                 TEXT NOT NULL UNIQUE,
  created_at         INTEGER,
  by_kind            TEXT,
  by_id              TEXT,
  by_org_id          TEXT,
  target_kind        TEXT,
  target_org_id      TEXT,
  target_scout_name  TEXT,
  target_player_id   TEXT,
  reason             TEXT,
  urgent             INTEGER,
  status             TEXT,
  outcome            TEXT,
  resolved_at        INTEGER,
  absent_keys_json   TEXT CHECK (absent_keys_json IS NULL OR (json_valid(absent_keys_json) AND json_type(absent_keys_json) = 'array')),
  offtype_json       TEXT CHECK (offtype_json IS NULL OR (json_valid(offtype_json) AND json_type(offtype_json) = 'object')),
  extra_json         TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;
CREATE INDEX reports_by_kind_by_id ON reports (by_kind, by_id);
CREATE INDEX reports_target_org_id_urgent_status ON reports (target_org_id, urgent, status);
CREATE INDEX reports_status_created_at ON reports (status, created_at);
CREATE INDEX reports_target_player_id ON reports (target_player_id);

-- -----------------------------------------------------------------------------
-- moderation_log — LIVE since migration 0013_safety_audit (S6b, REGISTERED — implemented,
--   pending independent acceptance). Repository: repositories/safetyAudit.mjs (moderationLog).
-- source: db.moderationLog (imported and retired by 0013, array position → seq; db.moderationLog
--         is the read-only view).
-- owner/writer: safetyAudit.moderationLog.append from server.mjs moderateOrRefuse, invoked from
--         every moderated text route in server.mjs and the m12–m28 modules (each passes its own
--         context object, kept WHOLE).
-- lifecycle: append-only; never deleted; kept after player deletion.
-- mapping (the moderateOrRefuse literal, key for key):
--   (array position) -> seq
--   id       -> id (mod-*)
--   ts       -> created_at (source field is literally `ts`)
--   context  -> context_json (the caller's context object AS A WHOLE — kind, orgId, userId,
--               channelId, playerId, requestId, trialId and any future field, nested values
--               included; the per-field columns the earlier draft proposed are NOT created)
--   flags    -> flags_json (JSON array of rule codes; display only)
--   severity -> severity ('contact' | 'grooming'; open)
--   excerpt  -> excerpt (first 140 chars of the BLOCKED text — sensitive; never printed in a
--               log or an error by the repository)
--   (every S6b table also carries the three lossless columns of the writers' literals:
--   absent_keys_json — a JSON array of the known keys the writer's object did NOT carry
--   (absence is restored as absence, never as null); offtype_json — a JSON object of the
--   known keys whose value is not the column's type, kept exactly (a numeric or object
--   targetPlayerId, an object orgId, a numeric reason); extra_json — a JSON object of the
--   unknown own fields, restored first, in their order. `seq` is the array position at
--   the import and the insertion order afterwards: every list, export, backup and the
--   rollback read the rows in `seq` order, exactly as the array was read.)
-- notes: a 'grooming' hit also creates an urgent system report (same request). Reads: the
--   admin list newest first, the dashboard counts (total, by severity) → index.
-- -----------------------------------------------------------------------------
CREATE TABLE moderation_log (
  seq                INTEGER PRIMARY KEY,
  id                 TEXT NOT NULL UNIQUE,
  created_at         INTEGER,
  context_json       TEXT CHECK (context_json IS NULL OR json_valid(context_json)),
  flags_json         TEXT CHECK (flags_json IS NULL OR json_valid(flags_json)),
  severity           TEXT,
  excerpt            TEXT,
  absent_keys_json   TEXT CHECK (absent_keys_json IS NULL OR (json_valid(absent_keys_json) AND json_type(absent_keys_json) = 'array')),
  offtype_json       TEXT CHECK (offtype_json IS NULL OR (json_valid(offtype_json) AND json_type(offtype_json) = 'object')),
  extra_json         TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;
CREATE INDEX moderation_log_severity ON moderation_log (severity);
CREATE INDEX moderation_log_created_at ON moderation_log (created_at);

-- -----------------------------------------------------------------------------
-- org_notes — LIVE since migration 0013_safety_audit (S6b, REGISTERED — implemented,
--   pending independent acceptance). Repository: repositories/safetyAudit.mjs (orgNotes).
-- source: db.orgNotes (imported and retired by 0013, array position → seq; container by the
--         snapshot migration m230_003; db.orgNotes is the read-only view).
-- owner/writer: safetyAudit.orgNotes.append from POST /org/players/:id/notes (server.mjs).
-- lifecycle: never edited, never deleted; KEPT after player deletion with the note text
--         (Q4; the retention question stays OPEN for S4b, as before).
-- mapping (the route literal, key for key):
--   (array position) -> seq
--   id        -> id (note-*)
--   orgId     -> org_id (NO foreign key — historical pointer)
--   playerId  -> player_id (NO foreign key — Q4, tolerant; indexed with org_id)
--   userId    -> user_id (NO foreign key — the author's staff id as recorded)
--   scoutName -> scout_name (snapshot)
--   text      -> text (moderation is NOT applied to notes — TEXT_REQUIRED only, unchanged)
--   ts        -> created_at (source field is literally `ts`)
--   (every S6b table also carries the three lossless columns of the writers' literals:
--   absent_keys_json — a JSON array of the known keys the writer's object did NOT carry
--   (absence is restored as absence, never as null); offtype_json — a JSON object of the
--   known keys whose value is not the column's type, kept exactly (a numeric or object
--   targetPlayerId, an object orgId, a numeric reason); extra_json — a JSON object of the
--   unknown own fields, restored first, in their order. `seq` is the array position at
--   the import and the insertion order afterwards: every list, export, backup and the
--   rollback read the rows in `seq` order, exactly as the array was read.)
-- notes: tenant = org_id; org-private (never visible to the player or other orgs). Read:
--   by (org_id, player_id) newest first.
-- -----------------------------------------------------------------------------
CREATE TABLE org_notes (
  seq                INTEGER PRIMARY KEY,
  id                 TEXT NOT NULL UNIQUE,
  org_id             TEXT,
  player_id          TEXT,
  user_id            TEXT,
  scout_name         TEXT,
  text               TEXT,
  created_at         INTEGER,
  absent_keys_json   TEXT CHECK (absent_keys_json IS NULL OR (json_valid(absent_keys_json) AND json_type(absent_keys_json) = 'array')),
  offtype_json       TEXT CHECK (offtype_json IS NULL OR (json_valid(offtype_json) AND json_type(offtype_json) = 'object')),
  extra_json         TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;
CREATE INDEX org_notes_org_id_player_id_created_at ON org_notes (org_id, player_id, created_at);

-- -----------------------------------------------------------------------------
-- ledger — LIVE since migration 0013_safety_audit (S6b, REGISTERED — implemented, pending
--   independent acceptance). Repository: repositories/safetyAudit.mjs (ledger).
-- source: db.ledger (imported and retired by 0013, array position → seq; container seed.mjs;
--         db.ledger is the read-only view, in insertion order).
-- owner/writer: safetyAudit.ledger.append from server.mjs ledgerAppend (`{id, ts, ...entry}` —
--         the ONE writer; its ~45 callers in server.mjs, m12, m13, m15, m16, m29 are unchanged;
--         m29 appends its signing row INSIDE the signing unit, so the row commits or rolls back
--         with the signing — the array truncation an earlier draft of this file described no
--         longer exists in m29). Any direct write on the view throws (repositories/readonly.mjs).
-- lifecycle: append-only; never edited; KEPT after player deletion with the now-unresolved
--         player_id (Q4; counted, never refused).
-- mapping (the ledgerAppend literal, key for key):
--   (array position) -> seq
--   id        -> id (led-*)
--   ts        -> occurred_at (source field is literally `ts`)
--   type      -> type (open set, template literals included — no CHECK)
--   playerId  -> player_id (NO foreign key — Q4; NULL/absent for org-only events; indexed)
--   orgId     -> org_id (NO foreign key — historical pointer; NULL for platform events)
--   orgName   -> org_name (snapshot; the org id when the org was unknown, as the routes do)
--   userId    -> user_id (VERBATIM — whatever the caller passed, null included; NO actor kind
--                is derived: the polymorphic actor pair the earlier draft proposed is NOT created)
--   scoutName -> actor_name (VERBATIM — the pseudo-actors 'guardian', 'player', 'system',
--                'open day', 'T&S level review' stay as text)
--   detail    -> detail_json (m13/m15/m16 rows only; per-type small objects, kept whole)
--   (every S6b table also carries the three lossless columns of the writers' literals:
--   absent_keys_json — a JSON array of the known keys the writer's object did NOT carry
--   (absence is restored as absence, never as null); offtype_json — a JSON object of the
--   known keys whose value is not the column's type, kept exactly (a numeric or object
--   targetPlayerId, an object orgId, a numeric reason); extra_json — a JSON object of the
--   unknown own fields, restored first, in their order. `seq` is the array position at
--   the import and the insertion order afterwards: every list, export, backup and the
--   rollback read the rows in `seq` order, exactly as the array was read.)
-- notes: reads — by player_id + type (insightsFor), by player_id (the guardian log, the export),
--   by (player_id, org_id) ordered (the org's player timeline, m29), by org_id (the org ledger,
--   enterprise, audit), by org_id + type 'shortlist'/'save' (planning, groups, nobodyMissed,
--   imports); every reader filters the view in insertion order, exactly as the array.
-- -----------------------------------------------------------------------------
CREATE TABLE ledger (
  seq                INTEGER PRIMARY KEY,
  id                 TEXT NOT NULL UNIQUE,
  occurred_at        INTEGER,
  type               TEXT,
  player_id          TEXT,
  org_id             TEXT,
  org_name           TEXT,
  user_id            TEXT,
  actor_name         TEXT,
  detail_json        TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  absent_keys_json   TEXT CHECK (absent_keys_json IS NULL OR (json_valid(absent_keys_json) AND json_type(absent_keys_json) = 'array')),
  offtype_json       TEXT CHECK (offtype_json IS NULL OR (json_valid(offtype_json) AND json_type(offtype_json) = 'object')),
  extra_json         TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;
CREATE INDEX ledger_player_id_type ON ledger (player_id, type);
CREATE INDEX ledger_player_id_org_id_occurred_at ON ledger (player_id, org_id, occurred_at);
CREATE INDEX ledger_org_id_type ON ledger (org_id, type);
CREATE INDEX ledger_occurred_at ON ledger (occurred_at);

-- -----------------------------------------------------------------------------
-- ops_events — LIVE since migration 0013_safety_audit (S6b, REGISTERED — implemented,
--   pending independent acceptance). Repository: repositories/safetyAudit.mjs (opsEvents).
-- source: db.opsEvents (imported and retired by 0013, array position → seq; container
--         m13/shared.mjs migrateM13; db.opsEvents is the read-only view).
-- owner/writer: safetyAudit.opsEvents.append from server.mjs (staff_bootstrapped),
--         m13/delivery.mjs (delivery_failed, staged into the sweep pass's persistNow with the
--         dispatch and outbox rows), m13/enterprise.mjs (audit_export, backup_created,
--         backup_refused, backup_failed and the other operations events: EVERY kind is an
--         ordinary row — no vocabulary CHECK), m13/imports.mjs (webhook_failed). The m13
--         modules keep an array push for a bare context without the repository (the reviewer
--         feasibility scripts); the server always passes the repository.
-- lifecycle: append-only; UNBOUNDED, never pruned (unchanged).
-- mapping (the writers' literal, key for key):
--   (array position) -> seq
--   id     -> id (ops-*)
--   at     -> occurred_at (source field is literally `at`)
--   kind   -> kind (open set)
--   detail -> detail_json (per-kind object, kept whole; operator display only)
--   (every S6b table also carries the three lossless columns of the writers' literals:
--   absent_keys_json — a JSON array of the known keys the writer's object did NOT carry
--   (absence is restored as absence, never as null); offtype_json — a JSON object of the
--   known keys whose value is not the column's type, kept exactly (a numeric or object
--   targetPlayerId, an object orgId, a numeric reason); extra_json — a JSON object of the
--   unknown own fields, restored first, in their order. `seq` is the array position at
--   the import and the insertion order afterwards: every list, export, backup and the
--   rollback read the rows in `seq` order, exactly as the array was read.)
-- notes: reads — counts by kind and the last 50 newest first (enterprise metrics). The
--   admin backup writes its db.json BEFORE appending its own backup_created event (as every
--   build did), so that one row is never inside the backup it describes.
-- -----------------------------------------------------------------------------
CREATE TABLE ops_events (
  seq                INTEGER PRIMARY KEY,
  id                 TEXT NOT NULL UNIQUE,
  occurred_at        INTEGER,
  kind               TEXT,
  detail_json        TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  absent_keys_json   TEXT CHECK (absent_keys_json IS NULL OR (json_valid(absent_keys_json) AND json_type(absent_keys_json) = 'array')),
  offtype_json       TEXT CHECK (offtype_json IS NULL OR (json_valid(offtype_json) AND json_type(offtype_json) = 'object')),
  extra_json         TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;
CREATE INDEX ops_events_kind ON ops_events (kind);
CREATE INDEX ops_events_occurred_at ON ops_events (occurred_at);

-- -----------------------------------------------------------------------------
-- source_changes — LIVE since migration 0013_safety_audit (S6b, REGISTERED — implemented,
--   pending independent acceptance). Repository: repositories/safetyAudit.mjs (sourceChanges).
-- source: db.sourceChanges (M18.1; imported and retired by 0013, array position → seq;
--         db.sourceChanges is the read-only view).
-- owner/writer: m181/sourceChanges.mjs recordSourceChange — safetyAudit.sourceChanges.append
--         then safetyAudit.sourceChanges.trimTo(20000) (the cap deletes the OLDEST rows beyond
--         20 000 in insertion order, the same splice the array had), both staged into the
--         persistNow() that follows. Called from m15/passport.mjs only.
-- lifecycle: append-only, capped; no deletion hook on player deletion (Q4: the row stays with
--         its now-unresolved player_id, counted).
-- mapping (the recordSourceChange literal, key for key):
--   (array position) -> seq
--   id           -> id (srcc-*)
--   playerId     -> player_id (NO foreign key — Q4; indexed with occurred_at)
--   type         -> type (open; 'position_changed' is the only value written today)
--   sourceSystem -> source_system (open)
--   sourceId     -> source_id (polymorphic; no FK)
--   occurredAt   -> occurred_at (the moment the fact changed)
--   detail       -> detail_json (small structured copy input, kept whole)
--   (every S6b table also carries the three lossless columns of the writers' literals:
--   absent_keys_json — a JSON array of the known keys the writer's object did NOT carry
--   (absence is restored as absence, never as null); offtype_json — a JSON object of the
--   known keys whose value is not the column's type, kept exactly (a numeric or object
--   targetPlayerId, an object orgId, a numeric reason); extra_json — a JSON object of the
--   unknown own fields, restored first, in their order. `seq` is the array position at
--   the import and the insertion order afterwards: every list, export, backup and the
--   rollback read the rows in `seq` order, exactly as the array was read.)
-- notes: holds no player content. Read: by player_id ordered occurred_at asc.
-- -----------------------------------------------------------------------------
CREATE TABLE source_changes (
  seq                INTEGER PRIMARY KEY,
  id                 TEXT NOT NULL UNIQUE,
  player_id          TEXT,
  type               TEXT,
  source_system      TEXT,
  source_id          TEXT,
  occurred_at        INTEGER,
  detail_json        TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  absent_keys_json   TEXT CHECK (absent_keys_json IS NULL OR (json_valid(absent_keys_json) AND json_type(absent_keys_json) = 'array')),
  offtype_json       TEXT CHECK (offtype_json IS NULL OR (json_valid(offtype_json) AND json_type(offtype_json) = 'object')),
  extra_json         TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;
CREATE INDEX source_changes_player_id_occurred_at ON source_changes (player_id, occurred_at);


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
-- idv_queue — LIVE since migration 0013_safety_audit (S6b, REGISTERED — implemented,
--   pending independent acceptance; Q4b). Repository: repositories/safetyAudit.mjs (idvQueue).
-- source: db.idvQueue (imported and retired by 0013, array position → seq; container by the
--         snapshot migration m230_003; db.idvQueue is the read-only view).
-- owner/writer: safetyAudit.idvQueue.append from POST /guardian/verify-id, INSIDE the unit
--         that sets the guardian's idVerified / idvReference columns (the row and the columns
--         commit together, or nothing does); safetyAudit.idvQueue.patch(id, {status}) from the
--         admin toggle, on the FIRST entry of the guardian in insertion order (as before), in the
--         same unit as the guardian's idVerified column.
-- Domain G — STRICT (Q4b, in code; NO foreign key yet): guardian_id is NOT NULL and the
--         repository refuses an append, an import (0013) and a snapshot write whose entry names
--         a guardian that does not exist in the FINAL guardians table (IDV_GUARDIAN_MISSING,
--         ids only) — the whole operation is refused atomically, the identity-only replacement
--         (a snapshot that omits idvQueue but replaces guardians) included. The database
--         constraint is a later step (§D.2a).
-- lifecycle: 'approved' ↔ 'revoked' by admin; never deleted (a guardian's own deletion path
--         is unchanged by S6b).
-- mapping (the route literal, key for key):
--   (array position) -> seq
--   id           -> id (idv-*)
--   guardianId   -> guardian_id (NOT NULL; checked in code against guardians — no FK)
--   guardianName -> guardian_name (snapshot)
--   documentType -> document_type (free text from the guardian)
--   documentRef  -> document_ref_last4 (only the last 4 chars are stored by the route — unchanged)
--   provider     -> provider (open)
--   reference    -> reference (provider check reference; same value as guardians.idvReference)
--   ts           -> created_at (source field is literally `ts`)
--   status       -> status (open; 'approved' | 'revoked' today)
--   (every S6b table also carries the three lossless columns of the writers' literals:
--   absent_keys_json — a JSON array of the known keys the writer's object did NOT carry
--   (absence is restored as absence, never as null); offtype_json — a JSON object of the
--   known keys whose value is not the column's type, kept exactly (a numeric or object
--   targetPlayerId, an object orgId, a numeric reason); extra_json — a JSON object of the
--   unknown own fields, restored first, in their order. `seq` is the array position at
--   the import and the insertion order afterwards: every list, export, backup and the
--   rollback read the rows in `seq` order, exactly as the array was read.)
-- notes: a guardian may verify more than once → several rows; the admin toggle updates only
--   the FIRST row for the guardian (the known behaviour, preserved). Reads: the admin list,
--   first by guardian_id. Logs and refusals name ids only — never a name or a document value.
-- -----------------------------------------------------------------------------
CREATE TABLE idv_queue (
  seq                INTEGER PRIMARY KEY,
  id                 TEXT NOT NULL UNIQUE,
  guardian_id        TEXT NOT NULL,
  guardian_name      TEXT,
  document_type      TEXT,
  document_ref_last4 TEXT,
  provider           TEXT,
  reference          TEXT,
  created_at         INTEGER,
  status             TEXT,
  absent_keys_json   TEXT CHECK (absent_keys_json IS NULL OR (json_valid(absent_keys_json) AND json_type(absent_keys_json) = 'array')),
  offtype_json       TEXT CHECK (offtype_json IS NULL OR (json_valid(offtype_json) AND json_type(offtype_json) = 'object')),
  extra_json         TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;
CREATE INDEX idv_queue_guardian_id_created_at ON idv_queue (guardian_id, created_at);


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
