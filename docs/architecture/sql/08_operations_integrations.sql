-- =====================================================================
-- 08_operations_integrations.sql — ScoutBox target relational schema
-- Scope: integrations (API keys, webhooks, imports, prospects, identity
-- reviews), enterprise (org invites, SSO, support), group workspaces,
-- grassroots operations (open trials, matchdays, friendlies), saved
-- searches, resumable uploads, billing invoices, product catalogues
-- (plans, archetypes), demo reputation seed, delivery idempotency and
-- operational settings.
--
-- Conventions: see ddl-conventions (STRICT tables, snake_case, epoch-ms
-- INTEGER *_at, TEXT YYYY-MM-DD *_date, booleans INTEGER 0/1, JSON only
-- where justified, *_hash for secrets, snapshots marked).
--
-- Parent tables created earlier in lexical order and referenced here:
--   orgs(id), org_users(id), players(id), guardians(id)      (01_identity.sql)
--   recruitment_cases(id), assessment_templates(id, version),
--   signings(id), notifications(id)                          (other files)
--
-- Ids: every source row that already has an id keeps it as TEXT PRIMARY KEY
-- (prefixes noted per table). Nested rows without ids get a natural
-- composite PRIMARY KEY (parent id + ordinal/natural key) — stated per table.
-- =====================================================================


-- ---------------------------------------------------------------------
-- api_keys
-- source: db.apiKeys  created at m13/shared.mjs:13 (migrateM13); rows minted at m13/imports.mjs:259-265
-- owner/writer: m13/imports.mjs   lifecycle: live until revoked_at set (soft revoke, never deleted)
-- mapping: id -> id (key-N); orgId -> org_id; scopes[] -> api_key_scopes child table;
--          keyHash -> key_hash (already sha256 hex of the plaintext, unsalted, imports.mjs:261 — unchanged);
--          label -> label; createdBy -> created_by_name (code stores req.orgUser.name, not an id);
--          createdAt -> created_at; revokedAt -> revoked_at; lastUsedAt -> last_used_at
-- notes: plaintext key shown once at creation, never stored. Lookup by key_hash where
--        revoked_at IS NULL on every /api/v1 request (imports.mjs:284) — unique index is NEW
--        (48 random hex bytes make collisions impossible; code never checked). last_used_at is
--        written on every API call without persist() (imports.mjs:287) — lost on crash today.
-- ---------------------------------------------------------------------
CREATE TABLE api_keys (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  key_hash        TEXT NOT NULL,                       -- sha256 hex; plain never stored (same as today)
  label           TEXT NOT NULL,
  created_by_name TEXT NOT NULL,                       -- snapshot
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  last_used_at    INTEGER
) STRICT;
CREATE UNIQUE INDEX api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX api_keys_org_id ON api_keys(org_id);

-- source: db.apiKeys[].scopes[]  (string array, imports.mjs:256)
-- owner/writer: m13/imports.mjs   lifecycle: set once at creation, never changed
-- mapping: each scope string -> one row (api_key_id, scope); PK is the natural pair
-- notes: values limited to API_SCOPES (imports.mjs:253). At least one scope is enforced by code.
CREATE TABLE api_key_scopes (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL CHECK (scope IN ('export:prospects', 'export:shortlist')),
  PRIMARY KEY (api_key_id, scope)
) STRICT;


-- ---------------------------------------------------------------------
-- webhook_endpoints
-- source: db.webhookEndpoints  created at m13/shared.mjs:14; rows minted at m13/imports.mjs:329-334
-- owner/writer: m13/imports.mjs   lifecycle: active 1 -> 0 on deactivate (never deleted)
-- mapping: id -> id (whk-N); orgId -> org_id; url -> url; events[] -> webhook_endpoint_events child table;
--          secret -> secret; secretPrev -> secret_prev; secretPrevValidUntil -> secret_prev_valid_until;
--          active -> active; createdBy -> created_by_name (name string, imports.mjs:332); createdAt -> created_at
-- notes: secret / secret_prev are NOT hashed: the server must sign outgoing bodies with the plain
--        secret (imports.mjs:401 signBody(w.secret, ...)) so a hash cannot replace it.
--        -- secret material, encrypt at rest (open question). OPERATIONS.md:12 states these are tenant
--        data that live in the database by design. Both are stripped from every API response.
--        Rotation keeps the previous secret 24h (imports.mjs:343-345). URL is SSRF-checked on write
--        and again on every delivery (webhookUrlProblem). Read patterns: by org; by org+active+event
--        on emit (imports.mjs:367); by id on delivery (imports.mjs:386).
-- ---------------------------------------------------------------------
CREATE TABLE webhook_endpoints (
  id                     TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  url                    TEXT NOT NULL,
  secret                 TEXT NOT NULL,                -- secret material, encrypt at rest (open question)
  secret_prev            TEXT,                         -- secret material, encrypt at rest (open question)
  secret_prev_valid_until INTEGER,
  active                 INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by_name        TEXT NOT NULL,                -- snapshot
  created_at             INTEGER NOT NULL
) STRICT;
CREATE INDEX webhook_endpoints_org_id_active ON webhook_endpoints(org_id, active);

-- source: db.webhookEndpoints[].events[]  (string array filtered to WEBHOOK_EVENTS, imports.mjs:321,327)
-- owner/writer: m13/imports.mjs   lifecycle: set once at creation
-- mapping: each event string -> one row (endpoint_id, event); natural PK
-- notes: emit filters `x.events.includes(type)` — served by the PK.
CREATE TABLE webhook_endpoint_events (
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event       TEXT NOT NULL CHECK (event IN ('import.committed', 'identity.resolved', 'transition.granted', 'transition.revoked', 'delivery.failed')),
  PRIMARY KEY (endpoint_id, event)
) STRICT;


-- ---------------------------------------------------------------------
-- webhook_deliveries
-- source: db.webhookDeliveries  created at m13/shared.mjs:15; rows minted at m13/imports.mjs:368-372
-- owner/writer: m13/imports.mjs (emitWebhook, deliverOne, webhookSweep)
-- lifecycle: queued -> retrying* -> delivered | failed | abandoned; NEVER pruned
-- mapping: id -> id (dlv-N); endpointId -> endpoint_id; orgId -> org_id; eventId -> event_id;
--          type -> type; data -> data_json; status -> status; attempts[] -> webhook_delivery_attempts child table;
--          nextAt -> next_at; createdAt -> created_at; deliveredAt (added on success only, imports.mjs:407) -> delivered_at
-- notes: data_json stays JSON because it is the free-form event payload by design (each event type
--        carries its own small object: {batchId,created} / {reviewId,resolution} / {dispatchId} / transition
--        payloads) — it is serialised verbatim into the signed body and never queried. event_id is the
--        receiver-side replay key (guidance imports.mjs:317) so it is unique here (NEW, 12 random bytes).
--        Read patterns: sweep = status IN ('queued','retrying') AND next_at <= now (imports.mjs:421);
--        per-endpoint last 100 (imports.mjs:362); backlog count by status (enterprise.mjs:511).
-- ---------------------------------------------------------------------
CREATE TABLE webhook_deliveries (
  id           TEXT PRIMARY KEY,
  endpoint_id  TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE RESTRICT,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  event_id     TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('import.committed', 'identity.resolved', 'transition.granted', 'transition.revoked', 'delivery.failed')),
  data_json    TEXT NOT NULL CHECK (json_valid(data_json)),  -- free-form event payload by design (signed verbatim)
  status       TEXT NOT NULL CHECK (status IN ('queued', 'retrying', 'delivered', 'failed', 'abandoned')),
  next_at      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
) STRICT;
CREATE UNIQUE INDEX webhook_deliveries_event_id ON webhook_deliveries(event_id);
CREATE INDEX webhook_deliveries_endpoint_id_created_at ON webhook_deliveries(endpoint_id, created_at);
CREATE INDEX webhook_deliveries_status_next_at ON webhook_deliveries(status, next_at);

-- source: db.webhookDeliveries[].attempts[]  ({at,status} on HTTP response, {at,error} on fetch error /
--         rejected destination; imports.mjs:389,406,409)
-- owner/writer: m13/imports.mjs deliverOne   lifecycle: append-only, max 5 per delivery (MAX_ATTEMPTS)
-- mapping: array index -> attempt_no (1-based); at -> attempted_at; status -> http_status; error -> error
-- notes: no id in source; natural PK (delivery_id, attempt_no). Retry ladder RETRY_MS is code, not data.
CREATE TABLE webhook_delivery_attempts (
  delivery_id  TEXT NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt_no   INTEGER NOT NULL CHECK (attempt_no >= 1),
  attempted_at INTEGER NOT NULL,
  http_status  INTEGER,
  error        TEXT,                                   -- <=120 chars, imports.mjs:409
  PRIMARY KEY (delivery_id, attempt_no)
) STRICT;


-- ---------------------------------------------------------------------
-- org_invites
-- source: db.orgInvites  created at m13/shared.mjs:29; rows minted at m13/enterprise.mjs:80-86
-- owner/writer: m13/enterprise.mjs   lifecycle: pending -> accepted | revoked | expired (expired is set
--               lazily only when an expired code is presented, enterprise.mjs:110); never deleted
-- mapping: id -> id (inv-N — the SAME prefix as invoices; the global counter keeps ids distinct);
--          orgId -> org_id; email -> email; name -> name; role -> role;
--          token -> token_hash (sha256 hex of the 36-hex code; the PLAIN token was stored before,
--          enterprise.mjs:83, and is emailed as the invite code — lookup becomes hash(token));
--          status -> status; invitedBy -> invited_by_name (name string); createdAt -> created_at;
--          expiresAt -> expires_at; acceptedAt -> accepted_at; revokedAt -> revoked_at;
--          userId (added on accept, enterprise.mjs:118) -> user_id
-- notes: email + name are invitee PII held before any account exists. Read patterns: by org
--        (enterprise.mjs:94,99); by token on public accept (enterprise.mjs:108) -> unique token_hash.
-- ---------------------------------------------------------------------
CREATE TABLE org_invites (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  email           TEXT NOT NULL,                       -- personal data
  name            TEXT NOT NULL,                       -- personal data
  role            TEXT NOT NULL,
  token_hash      TEXT NOT NULL,                       -- sha256 hex; plain token was stored before
  status          TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by_name TEXT NOT NULL,                       -- snapshot
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  accepted_at     INTEGER,
  revoked_at      INTEGER,
  user_id         TEXT REFERENCES org_users(id) ON DELETE SET NULL
) STRICT;
CREATE UNIQUE INDEX org_invites_token_hash ON org_invites(token_hash);
CREATE INDEX org_invites_org_id ON org_invites(org_id);


-- ---------------------------------------------------------------------
-- sso_configs
-- source: db.ssoConfigs  created at m13/shared.mjs:30; rows minted at m13/enterprise.mjs:235-238
-- owner/writer: m13/enterprise.mjs   lifecycle: one per org, upserted; never deleted
-- mapping: id -> id (sso-N); orgId -> org_id; createdAt -> created_at; issuer -> issuer;
--          clientId -> client_id; updatedAt -> updated_at
-- notes: one row per org enforced by code (find-or-create, enterprise.mjs:234) — unique index.
--        Only 'local-test-idp' can ever be written (enterprise.mjs:230). No IdP secrets are stored;
--        the test IdP key is env TEST_IDP_SECRET. Read: by org (enterprise.mjs:219,272).
-- ---------------------------------------------------------------------
CREATE TABLE sso_configs (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  issuer     TEXT NOT NULL CHECK (issuer IN ('local-test-idp')),
  client_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX sso_configs_org_id ON sso_configs(org_id);


-- ---------------------------------------------------------------------
-- sso_states
-- source: db.ssoStates  created at m13/shared.mjs:31; rows minted at m13/enterprise.mjs:274-278
-- owner/writer: m13/enterprise.mjs   lifecycle: single-use (used_at set on first callback, even on
--               failure, enterprise.mjs:301); 10-minute expiry; NEVER pruned
-- mapping: id -> id (sst-N); state -> state_hash (sha256 hex; plain 32-hex value stored before —
--          the callback looks it up as hash(state)); nonce -> nonce_hash (sha256 hex; verified as
--          hash(tok.nonce) = nonce_hash, enterprise.mjs:304); orgId -> org_id; createdAt -> created_at;
--          expiresAt -> expires_at; usedAt -> used_at
-- notes: both values are one-time secrets handed to the browser; hashing them removes the replay
--        material from backups. Read: by state (enterprise.mjs:297) -> unique state_hash.
--        Retention: nothing deletes these; a scheduled prune of used/expired rows is recommended.
-- ---------------------------------------------------------------------
CREATE TABLE sso_states (
  id         TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL,                            -- sha256 hex; plain stored before
  nonce_hash TEXT NOT NULL,                            -- sha256 hex; plain stored before
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
) STRICT;
CREATE UNIQUE INDEX sso_states_state_hash ON sso_states(state_hash);


-- ---------------------------------------------------------------------
-- support_tickets
-- source: db.supportTickets  created at m13/shared.mjs:32; rows minted at m13/enterprise.mjs:347-352
-- owner/writer: m13/enterprise.mjs (org creates; admin replies/closes)   lifecycle: open -> closed; never deleted
-- mapping: id -> id (tkt-N); orgId -> org_id; byUserId -> by_user_id; byName -> by_name;
--          subject -> subject (<=160); body -> body (<=2000); refs[] -> support_ticket_refs child table;
--          status -> status; replies[] -> support_ticket_replies child table; createdAt -> created_at
-- notes: refs are ids only — nothing is copied into the ticket (enterprise.mjs:355). Read: by org
--        (enterprise.mjs:359); by id (admin); admin full list newest first.
-- ---------------------------------------------------------------------
CREATE TABLE support_tickets (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  by_user_id TEXT REFERENCES org_users(id) ON DELETE SET NULL,   -- code tolerates a missing user (enterprise.mjs:381)
  by_name    TEXT NOT NULL,                            -- snapshot
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX support_tickets_org_id_created_at ON support_tickets(org_id, created_at);

-- source: db.supportTickets[].replies[]  ({at, by:'Trust & Safety', text}, enterprise.mjs:379)
-- owner/writer: m13/enterprise.mjs adminRouter   lifecycle: append-only
-- mapping: array index -> reply_no (1-based); at -> replied_at; by -> by_name; text -> text (<=2000)
-- notes: no id in source; natural PK (ticket_id, reply_no). by is always the literal 'Trust & Safety'.
CREATE TABLE support_ticket_replies (
  ticket_id  TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  reply_no   INTEGER NOT NULL CHECK (reply_no >= 1),
  replied_at INTEGER NOT NULL,
  by_name    TEXT NOT NULL,                            -- snapshot ('Trust & Safety')
  text       TEXT NOT NULL,
  PRIMARY KEY (ticket_id, reply_no)
) STRICT;

-- source: db.supportTickets[].refs[]  ({kind<=30, id<=40}, max 10, enterprise.mjs:350)
-- owner/writer: m13/enterprise.mjs   lifecycle: set once at creation
-- mapping: array index -> ref_no (1-based); kind -> ref_kind; id -> ref_id
-- notes: polymorphic reference, no FK. kind is free text from the client; the only kinds the
--        server resolves are 'case' (recruitment_cases) and 'import' (import_batches),
--        enterprise.mjs:416-417. Other kinds are stored and ignored.
CREATE TABLE support_ticket_refs (
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  ref_no    INTEGER NOT NULL CHECK (ref_no >= 1),
  ref_kind  TEXT NOT NULL,                             -- polymorphic: 'case' | 'import' | other (ignored)
  ref_id    TEXT NOT NULL,
  PRIMARY KEY (ticket_id, ref_no)
) STRICT;


-- ---------------------------------------------------------------------
-- support_access_grants
-- source: db.supportAccessGrants  created at m13/shared.mjs:33; rows minted at m13/enterprise.mjs:391-394
-- owner/writer: m13/enterprise.mjs (admin requests; org lead approves; admin reads log access)
-- lifecycle: requested -> active; expiry is DERIVED (expires_at > now), never a stored state; never deleted
-- mapping: id -> id (sag-N); ticketId -> ticket_id; orgId -> org_id; hours -> hours (1..72);
--          status -> status; requestedAt -> requested_at; approvedBy -> approved_by_name (name string);
--          approvedAt -> approved_at; expiresAt -> expires_at; accessLog[] -> support_access_log child table
-- notes: read patterns: by ticket+org+status='requested' (enterprise.mjs:364); by ticket+status='active'
--        +expires_at>now (enterprise.mjs:407); by org for audit export (enterprise.mjs:336).
--        Audit rows: ON DELETE RESTRICT from the ticket.
-- ---------------------------------------------------------------------
CREATE TABLE support_access_grants (
  id               TEXT PRIMARY KEY,
  ticket_id        TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE RESTRICT,
  org_id           TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  hours            INTEGER NOT NULL CHECK (hours BETWEEN 1 AND 72),
  status           TEXT NOT NULL CHECK (status IN ('requested', 'active')),
  requested_at     INTEGER NOT NULL,
  approved_by_name TEXT,                               -- snapshot
  approved_at      INTEGER,
  expires_at       INTEGER
) STRICT;
CREATE INDEX support_access_grants_ticket_id_status ON support_access_grants(ticket_id, status);
CREATE INDEX support_access_grants_org_id ON support_access_grants(org_id);

-- source: db.supportAccessGrants[].accessLog[]  ({at, what:'org-records'}, enterprise.mjs:409)
-- owner/writer: m13/enterprise.mjs   lifecycle: append-only audit of every admin read under the grant
-- mapping: array index -> access_no (1-based); at -> accessed_at; what -> what
-- notes: no id in source; natural PK (grant_id, access_no). Audit: RESTRICT.
CREATE TABLE support_access_log (
  grant_id    TEXT NOT NULL REFERENCES support_access_grants(id) ON DELETE RESTRICT,
  access_no   INTEGER NOT NULL CHECK (access_no >= 1),
  accessed_at INTEGER NOT NULL,
  what        TEXT NOT NULL,
  PRIMARY KEY (grant_id, access_no)
) STRICT;


-- ---------------------------------------------------------------------
-- import_batches
-- source: db.importBatches  created at m13/shared.mjs:10; rows minted at m13/imports.mjs:112-127
-- owner/writer: m13/imports.mjs   lifecycle: validated -> committed -> reversed; never deleted
-- mapping: id -> id (imp-N); orgId -> org_id; kind -> kind; createdBy -> created_by_user_id (user id);
--          createdByName -> created_by_name; createdAt -> created_at;
--          header[] -> header_json (the uploaded CSV's header row — free-form by design, user-supplied column names);
--          mapping{} -> mapping_json (csvColumn -> prospect field, or null — free-form by design, keyed by user column names);
--          rows[] -> import_batch_rows child table; status -> status;
--          summary.total -> summary_total; summary.creatable -> summary_creatable; summary.errors -> summary_errors;
--          summary.duplicatesInFile -> summary_duplicates_in_file; summary.alreadyImported -> summary_already_imported;
--          summary.linkedExisting -> summary_linked_existing; summary.ambiguous -> summary_ambiguous;
--          committedAt -> committed_at; reversedAt -> reversed_at;
--          createdProspectIds[] -> import_batch_created_prospects child table;
--          history[] -> import_batches_history
-- notes: summary is a stored snapshot of counts over rows (kept as columns: it is what the list endpoint
--        serves without loading rows). Read patterns: by org newest first (imports.mjs:136); by id+org;
--        by org+status='committed' (enterprise.mjs:135 onboarding); admin last 50; support view by id.
--        The batch (not its rows) is the unit of the dry run: POST /imports writes only this record.
-- ---------------------------------------------------------------------
CREATE TABLE import_batches (
  id                          TEXT PRIMARY KEY,
  org_id                      TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  kind                        TEXT NOT NULL CHECK (kind IN ('prospects')),
  created_by_user_id          TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name             TEXT NOT NULL,           -- snapshot
  created_at                  INTEGER NOT NULL,
  header_json                 TEXT NOT NULL CHECK (json_valid(header_json)),      -- CSV header row, free-form by design
  mapping_json                TEXT CHECK (mapping_json IS NULL OR json_valid(mapping_json)),  -- user column map, free-form by design
  status                      TEXT NOT NULL CHECK (status IN ('validated', 'committed', 'reversed')),
  summary_total               INTEGER NOT NULL,
  summary_creatable           INTEGER NOT NULL,
  summary_errors              INTEGER NOT NULL,
  summary_duplicates_in_file  INTEGER NOT NULL,
  summary_already_imported    INTEGER NOT NULL,
  summary_linked_existing     INTEGER NOT NULL,
  summary_ambiguous           INTEGER NOT NULL,
  committed_at                INTEGER,
  reversed_at                 INTEGER
) STRICT;
CREATE INDEX import_batches_org_id_created_at ON import_batches(org_id, created_at);
CREATE INDEX import_batches_org_id_status ON import_batches(org_id, status);

-- source: db.importBatches[].rows[]  ({row, record{...}, errors[], disposition, matchPlayerId}, imports.mjs:99)
-- owner/writer: m13/imports.mjs validateRows   lifecycle: written once at validation; NEVER mutated or pruned
-- mapping: row (CSV line number, header = 1) -> row_no (natural key within the batch);
--          record.name -> record_name; record.dob -> record_dob (raw text: on 'error' rows it may be
--          malformed, so no length CHECK here); record.position -> record_position; record.foot -> record_foot;
--          record.heightCm -> record_height_cm_raw (raw string, validated only on non-error rows);
--          record.provider -> record_provider; record.externalId -> record_external_id; record.notes -> record_notes;
--          errors[] -> errors_json (array of validation messages — free-form by design, human text);
--          disposition -> disposition; matchPlayerId -> match_player_id
-- notes: PII — name + dob of people who may be minors and have no platform account, up to 2000 per batch,
--        never deleted (not even on reversal). Retention policy needed. match_player_id has no FK: players
--        are hard-deleted and the id stays as a tombstone. Absent record fields are '' in source -> NULL here.
CREATE TABLE import_batch_rows (
  batch_id             TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_no               INTEGER NOT NULL CHECK (row_no >= 2),
  record_name          TEXT,                           -- personal data
  record_dob           TEXT,                           -- personal data (minor); raw, may be malformed on error rows
  record_position      TEXT,
  record_foot          TEXT,
  record_height_cm_raw TEXT,
  record_provider      TEXT,
  record_external_id   TEXT,
  record_notes         TEXT,
  errors_json          TEXT NOT NULL CHECK (json_valid(errors_json)),  -- free-form validation messages
  disposition          TEXT NOT NULL CHECK (disposition IN ('create', 'error', 'duplicate_in_file', 'already_imported', 'linked_player_exists', 'ambiguous_identity')),
  match_player_id      TEXT,                           -- no FK: tombstone survives player deletion
  PRIMARY KEY (batch_id, row_no)
) STRICT;

-- source: db.importBatches[].history[]  (histAppend, m13/shared.mjs:206-209: {id aud-N, at, byKind, byId, byName, action, detail})
-- owner/writer: m13/imports.mjs   lifecycle: append-only (actions: validated, committed, reversed)
-- mapping: id -> id; at -> at; byKind -> by_kind; byId -> by_id; byName -> by_name; action -> action; detail -> detail_json
-- notes: exported in the org audit export (enterprise.mjs:333). detail is the summary object / counts.
CREATE TABLE import_batches_history (
  id          TEXT PRIMARY KEY,
  batch_id    TEXT NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT,
  at          INTEGER NOT NULL,
  by_kind     TEXT NOT NULL CHECK (by_kind IN ('player', 'guardian', 'org', 'org_user', 'admin', 'system')),
  by_id       TEXT,
  by_name     TEXT,                                    -- snapshot
  action      TEXT NOT NULL,
  detail_json TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX import_batches_history_batch_id_at ON import_batches_history(batch_id, at);


-- ---------------------------------------------------------------------
-- prospects
-- source: db.prospects  created at m13/shared.mjs:11; rows minted at m13/imports.mjs:155-160 (commit) and 227-231 (review 'separate')
-- owner/writer: m13/imports.mjs   lifecycle: live until reversed_at set (soft delete by batch reversal); never hard-deleted
-- mapping: id -> id (prs-N); orgId -> org_id; batchId -> batch_id; name -> name; dob -> dob ('' in source -> NULL);
--          position -> position; foot -> foot; heightCm -> height_cm; provider -> provider; externalId -> external_id;
--          notes -> notes; minor -> minor (tri-state: null when no dob, and ABSENT on the review-'separate' path -> NULL);
--          linkedPlayerId -> linked_player_id (-- dead field, never written (only read at imports.mjs:188,299); kept nullable, not migrated beyond NULL);
--          createdAt -> created_at; modifiedAt -> modified_at (-- dead field, never written; read at imports.mjs:188; kept nullable);
--          reversedAt -> reversed_at
-- notes: ORG-PRIVATE records; never platform accounts; minors possible (dob) — tenant isolation is the
--        privacy control. Natural key (org_id, provider, external_id) among non-reversed rows is enforced by
--        code at validation ('already_imported', imports.mjs:88) BUT the review-'separate' path does not
--        re-check it — the partial unique index below is therefore stricter than today; dedupe before migrating.
--        Read patterns: by org where reversed_at IS NULL newest first (imports.mjs:201,298); by org for
--        onboarding (enterprise.mjs:135); by id on reversal; natural-key lookup on validation.
-- ---------------------------------------------------------------------
CREATE TABLE prospects (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  batch_id          TEXT NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT,
  name              TEXT NOT NULL,                     -- personal data
  dob               TEXT CHECK (dob IS NULL OR length(dob) = 10),   -- personal data (minor)
  position          TEXT,
  foot              TEXT,
  height_cm         INTEGER,
  provider          TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  notes             TEXT,
  minor             INTEGER CHECK (minor IS NULL OR minor IN (0, 1)),   -- conservative UI flag, tri-state
  linked_player_id  TEXT,                              -- dead field, never written; no FK
  created_at        INTEGER NOT NULL,
  modified_at       INTEGER,                           -- dead field, never written
  reversed_at       INTEGER
) STRICT;
CREATE UNIQUE INDEX prospects_org_id_provider_external_id ON prospects(org_id, provider, external_id) WHERE reversed_at IS NULL;
CREATE INDEX prospects_org_id_created_at ON prospects(org_id, created_at);
CREATE INDEX prospects_batch_id ON prospects(batch_id);

-- source: db.importBatches[].createdProspectIds[]  (imports.mjs:162)
-- owner/writer: m13/imports.mjs commit   lifecycle: append at commit; read by reverse (imports.mjs:185)
-- mapping: each id -> one row (batch_id, prospect_id)
-- notes: NOT derivable from prospects.batch_id — prospects created via identity-review 'separate'
--        (imports.mjs:227-232) carry batch_id but are NOT in this list and are NOT reversed with the batch.
--        Created after prospects (not next to import_batches) so the FK can be declared.
CREATE TABLE import_batch_created_prospects (
  batch_id    TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  prospect_id TEXT NOT NULL REFERENCES prospects(id) ON DELETE RESTRICT,
  PRIMARY KEY (batch_id, prospect_id)
) STRICT;


-- ---------------------------------------------------------------------
-- identity_reviews
-- source: db.identityReviews  created at m13/shared.mjs:12; rows minted at m13/imports.mjs:164-168
-- owner/writer: m13/imports.mjs   lifecycle: open -> resolved; never deleted
-- mapping: id -> id (idr-N); orgId -> org_id; batchId -> batch_id; row -> row_no;
--          record -> NOT duplicated: it is the same object as import_batch_rows(batch_id,row_no).record_*
--          (imports.mjs:166 passes r.record of that row; rows are immutable) — read through the composite FK;
--          candidatePlayerId -> candidate_player_id; status -> status; resolvedBy -> resolved_by_name (name string, imports.mjs:238);
--          resolvedAt -> resolved_at; resolution -> resolution; createdAt -> created_at
-- notes: candidate_player_id has no FK (player may be hard-deleted; the review then fails 'NOT_VISIBLE').
--        Read patterns: by org+status='open' (imports.mjs:207); by id+org.
-- ---------------------------------------------------------------------
CREATE TABLE identity_reviews (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  batch_id            TEXT NOT NULL,
  row_no              INTEGER NOT NULL,
  candidate_player_id TEXT NOT NULL,                   -- no FK: tombstone survives player deletion
  status              TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  resolved_by_name    TEXT,                            -- snapshot
  resolved_at         INTEGER,
  resolution          TEXT CHECK (resolution IS NULL OR resolution IN ('linked', 'kept_separate')),
  created_at          INTEGER NOT NULL,
  FOREIGN KEY (batch_id, row_no) REFERENCES import_batch_rows(batch_id, row_no) ON DELETE RESTRICT
) STRICT;
CREATE INDEX identity_reviews_org_id_status ON identity_reviews(org_id, status);


-- ---------------------------------------------------------------------
-- groups
-- source: db.groups  created at m13/shared.mjs:25; rows minted at m13/groups.mjs:23-28 (admin only)
-- owner/writer: m13/groups.mjs   lifecycle: never deleted; membership arrays mutate
-- mapping: id -> id (grp-N); name -> name (<=100); adminOrgIds[] -> group_admins; memberOrgIds[] -> group_members;
--          pendingInvites[] -> group_pending_invites; sharedTemplateIds[] -> group_shared_templates;
--          programmes[] -> group_programmes; createdAt -> created_at
-- notes: read patterns: groups containing an org (groups.mjs:15 groupsOf; shared.mjs:202 sameGroupLive =
--        two orgs share a group) -> group_members(org_id); pending invites by org (groups.mjs:43); by id.
-- ---------------------------------------------------------------------
CREATE TABLE groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- source: db.groups[].adminOrgIds[]  (groups.mjs:25; removed on leave, groups.mjs:80)
-- mapping: each org id -> (group_id, org_id). An admin is always also a member (code invariant, not enforced here).
CREATE TABLE group_admins (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  org_id   TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, org_id)
) STRICT;

-- source: db.groups[].memberOrgIds[]  (groups.mjs:25,70; removed on leave, groups.mjs:79)
-- mapping: each org id -> (group_id, org_id)
-- notes: agencies are refused at invite time (groups.mjs:55). Index by org serves groupsOf/sameGroupLive.
CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  org_id   TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, org_id)
) STRICT;
CREATE INDEX group_members_org_id ON group_members(org_id);

-- source: db.groups[].pendingInvites[]  ({orgId, invitedBy (org id), at}, groups.mjs:57; removed on accept, groups.mjs:69)
-- mapping: orgId -> org_id; invitedBy -> invited_by_org_id; at -> invited_at
-- notes: no id in source; natural PK (group_id, org_id) — code refuses a second invite (groups.mjs:56).
--        Hard-deleted on accept (there is no decline route).
CREATE TABLE group_pending_invites (
  group_id          TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  invited_by_org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  invited_at        INTEGER NOT NULL,
  PRIMARY KEY (group_id, org_id)
) STRICT;
CREATE INDEX group_pending_invites_org_id ON group_pending_invites(org_id);

-- source: db.groups[].sharedTemplateIds[]  (groups.mjs:99)
-- mapping: each template id -> (group_id, template_id)
-- notes: the code stores ONLY the template id, and assessment template ids are reused across versions
--        (key is (id, version)); the lookup at groups.mjs:97 resolves to the first (v1) row — known defect.
--        No FK to assessment_templates(id, version) is possible without a version; template_id kept bare.
--        Nothing reads this list today beyond echoing the group (dead-end feature).
CREATE TABLE group_shared_templates (
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,                           -- assessment_templates.id without version (see notes)
  PRIMARY KEY (group_id, template_id)
) STRICT;

-- source: db.groups[].programmes[]  ({id pgm-N, name<=100, region<=80|null, createdAt}, groups.mjs:108)
-- owner/writer: m13/groups.mjs   lifecycle: append-only; never read back except with the group
-- mapping: id -> id; name -> name; region -> region; createdAt -> created_at
CREATE TABLE group_programmes (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  region     TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX group_programmes_group_id ON group_programmes(group_id);


-- ---------------------------------------------------------------------
-- group_grants
-- source: db.groupGrants  created at m13/shared.mjs:26; rows minted at m13/groups.mjs:180-185
-- owner/writer: m13/groups.mjs (create, revoke, departure revoke)   lifecycle: live until revoked_at or expires_at; never deleted
-- mapping: id -> id (gnt-N); groupId -> group_id; fromOrgId -> from_org_id; fromOrgName -> from_org_name;
--          toOrgIds[] -> group_grant_recipients child table; resourceKind -> resource_kind; resourceId -> resource_id;
--          expiresAt -> expires_at; revokedAt -> revoked_at; revokeReason (added on revoke, groups.mjs:86,209) -> revoke_reason;
--          createdBy -> created_by_name (name string); createdAt -> created_at
-- notes: resource_id is polymorphic: '*' for shortlist (the org's whole shortlist, derived from the ledger),
--        a recruitment_cases(id) for 'case', an assessments(id) for 'assessment' — no FK. Ownership and
--        liveness are re-checked on every read (activeGrant, shared.mjs:194-200). Read patterns: by from_org
--        (groups.mjs:199,207); by recipient org (junction) + live + sameGroupLive (groups.mjs:200); by id
--        (groups.mjs:215); by group (groups.mjs:233); activeGrant = from+kind+resource+recipient+live.
--        Departure revoke (groups.mjs:83-87) tests sameGroupLive against toOrgIds[0] only — known quirk.
-- ---------------------------------------------------------------------
CREATE TABLE group_grants (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  from_org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  from_org_name   TEXT NOT NULL,                       -- snapshot
  resource_kind   TEXT NOT NULL CHECK (resource_kind IN ('shortlist', 'case', 'assessment')),
  resource_id     TEXT NOT NULL,                       -- polymorphic: '*' | recruitment_cases.id | assessments.id
  expires_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  revoke_reason   TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN ('group_departure', 'revoked_by_owner')),
  created_by_name TEXT NOT NULL,                       -- snapshot
  created_at      INTEGER NOT NULL
) STRICT;
CREATE INDEX group_grants_from_org_id ON group_grants(from_org_id);
CREATE INDEX group_grants_group_id ON group_grants(group_id);
CREATE INDEX group_grants_from_org_id_resource_kind_resource_id ON group_grants(from_org_id, resource_kind, resource_id);

-- source: db.groupGrants[].toOrgIds[]  (filtered recipients, groups.mjs:178)
-- mapping: each org id -> (grant_id, org_id)
-- notes: received-grants query (groups.mjs:200; enterprise.mjs:335) -> index by org_id.
CREATE TABLE group_grant_recipients (
  grant_id TEXT NOT NULL REFERENCES group_grants(id) ON DELETE CASCADE,
  org_id   TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  PRIMARY KEY (grant_id, org_id)
) STRICT;
CREATE INDEX group_grant_recipients_org_id ON group_grant_recipients(org_id);


-- ---------------------------------------------------------------------
-- upload_sessions
-- source: db.uploadSessions  created at m12/shared.mjs:27; rows minted at m12/operations.mjs:167-172
-- owner/writer: m12/operations.mjs   lifecycle: open -> finalised | aborted | abandoned (sweep after 24h, operations.mjs:382-387); never deleted
-- mapping: id -> id (upl-N); playerId -> player_id; size -> size_bytes; mime -> mime; title -> title (<=120);
--          sha256 -> declared_sha256 (client-declared checksum, not a secret, nullable); chunkSize -> chunk_size;
--          totalChunks -> total_chunks; received[] -> upload_session_chunks child table; status -> status;
--          createdAt -> created_at; finalisedMediaId -> finalised_media_id
-- notes: chunk BYTES live on disk under DATA_DIR/upload-tmp/<id>/ — not schema. finalised_media_id names the
--        player media item created at finalise (player media table in 01_identity); no FK: media rows are
--        deleted with the player while upload sessions are NOT touched by deletePlayerData (orphan defect) —
--        hence ON DELETE CASCADE here so the migration fixes it. Read patterns: by id+player
--        (operations.mjs:179); sweep status='open' AND created_at < now-24h (operations.mjs:383).
-- ---------------------------------------------------------------------
CREATE TABLE upload_sessions (
  id                 TEXT PRIMARY KEY,
  player_id          TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  size_bytes         INTEGER NOT NULL CHECK (size_bytes > 0),
  mime               TEXT NOT NULL,
  title              TEXT NOT NULL,
  declared_sha256    TEXT,
  chunk_size         INTEGER NOT NULL,
  total_chunks       INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('open', 'finalised', 'aborted', 'abandoned')),
  created_at         INTEGER NOT NULL,
  finalised_media_id TEXT                              -- player media id (01_identity); no FK, see notes
) STRICT;
CREATE INDEX upload_sessions_player_id ON upload_sessions(player_id);
CREATE INDEX upload_sessions_status_created_at ON upload_sessions(status, created_at);

-- source: db.uploadSessions[].received[]  (chunk indices, operations.mjs:197)
-- mapping: each index -> (upload_session_id, chunk_index)
-- notes: idempotent re-upload of the same index is a no-op (PK).
CREATE TABLE upload_session_chunks (
  upload_session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  chunk_index       INTEGER NOT NULL CHECK (chunk_index >= 0),
  PRIMARY KEY (upload_session_id, chunk_index)
) STRICT;


-- ---------------------------------------------------------------------
-- saved_searches
-- source: db.savedSearches  created at server.mjs:215; rows minted at server.mjs:2424
-- owner/writer: server.mjs   lifecycle: HARD delete by owner org (server.mjs:2429-2434); untouched by player deletion (4017)
-- mapping: id -> id (ss-N); orgId -> org_id; userId -> user_id; scoutName -> scout_name; name -> name (<=120);
--          filters{} -> filters_json; createdAt -> created_at
-- notes: filters_json stays JSON — free-form by design: an arbitrary object the client sends, matched key by key
--        by matchesSearch (server.mjs:~2380-2402: q, position, foot, ageGroup, availability, ...); unknown keys
--        are ignored, none are queried server-side. Read patterns: by org (server.mjs:2417); by id+org on delete;
--        FULL SCAN of every saved search on every player signup (checkSavedSearches, server.mjs:2405) — the
--        notify target is user_id, which is why it is kept even though the user may have been removed.
--        POST /searches does not call persist() (server.mjs:2420-2427) — rows could be lost before the next save.
-- ---------------------------------------------------------------------
CREATE TABLE saved_searches (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  scout_name   TEXT NOT NULL,                          -- snapshot
  name         TEXT NOT NULL,
  filters_json TEXT NOT NULL CHECK (json_valid(filters_json)),  -- free-form search filters by design
  created_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX saved_searches_org_id ON saved_searches(org_id);


-- ---------------------------------------------------------------------
-- open_trials
-- source: db.openTrials  created at server.mjs:224; rows minted at server.mjs:2664-2669 (grassroots orgs only)
-- owner/writer: server.mjs   lifecycle: HARD delete by owner org (server.mjs:2691-2699) — registrations go with it
-- mapping: id -> id (open-N); orgId -> org_id; orgName -> org_name; title -> title (<=160); date -> trial_date;
--          venue -> venue (<=160); ageGroup -> age_group (default 'open', <=40); positions[] -> open_trial_positions child table;
--          notes -> notes (<=2000, '' when absent); createdByUserId -> created_by_user_id; createdAt -> created_at;
--          registrations[] -> open_trial_registrations child table
-- notes: trial_date gates the no-ghosting rule (date < today with unresolved registrations blocks posting,
--        server.mjs:2645-2653) and the upcoming lists (date >= today: 3645, 3800, journeys.mjs:844) by string
--        comparison — validated as a real day since M23 P5.7. Read patterns: by org (2681, 2900); by org+date;
--        by id (3656, 3817); full scan by date>=today joined to orgs.location for radius (3636-3647, 3800-3810,
--        journeys.mjs:844); full scan for the coverage fixture union (planning.mjs:89, synthetic id 'tr-'||id).
-- ---------------------------------------------------------------------
CREATE TABLE open_trials (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  org_name           TEXT NOT NULL,                    -- snapshot
  title              TEXT NOT NULL,
  trial_date         TEXT NOT NULL CHECK (length(trial_date) = 10),
  venue              TEXT NOT NULL,
  age_group          TEXT NOT NULL DEFAULT 'open',
  notes              TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT REFERENCES org_users(id) ON DELETE SET NULL,   -- code tolerates null (server.mjs:3665)
  created_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX open_trials_org_id_trial_date ON open_trials(org_id, trial_date);
CREATE INDEX open_trials_trial_date ON open_trials(trial_date);

-- source: db.openTrials[].positions[]  (string list, max 20, server.mjs:2667; not validated against POSITIONS)
-- mapping: each string -> (open_trial_id, position); natural PK dedupes (source array could repeat)
CREATE TABLE open_trial_positions (
  open_trial_id TEXT NOT NULL REFERENCES open_trials(id) ON DELETE CASCADE,
  position      TEXT NOT NULL,
  PRIMARY KEY (open_trial_id, position)
) STRICT;

-- source: db.openTrials[].registrations[]  (server.mjs:3664 player self-register; 3825 guardian register; outcome 2723-2725)
-- owner/writer: server.mjs   lifecycle: outcome NULL -> invite_trial | declined; player_name nulled on player deletion (server.mjs:4000-4002)
-- mapping: id -> id (otr-N); playerId -> player_id; playerName -> player_name; byGuardian -> by_guardian;
--          guardianId (only on guardian path) -> guardian_id; ts -> registered_at (source field is literally `ts`);
--          outcome -> outcome; outcomeNote -> outcome_note (<=200); outcomeAt -> outcome_at
-- notes: player_id has NO FK: the deletion route hard-deletes the player row and keeps this id as a tombstone
--        (only the name is redacted). One registration per (open_trial_id, player_id) enforced by code
--        ('ALREADY_REGISTERED', 3663/3824) — unique index. Minors register only via the guardian path to
--        clubs that may see them (visibleToOrg, 3820). Read patterns: by trial; by player across trials
--        (registered flag 3646/3808/journeys.mjs:851; pathway record 2883-2888); unresolved = outcome IS NULL.
CREATE TABLE open_trial_registrations (
  id            TEXT PRIMARY KEY,
  open_trial_id TEXT NOT NULL REFERENCES open_trials(id) ON DELETE CASCADE,
  player_id     TEXT NOT NULL,                         -- no FK: tombstone survives player deletion
  player_name   TEXT,                                  -- snapshot; personal data; NULL after player deletion
  by_guardian   INTEGER NOT NULL DEFAULT 0 CHECK (by_guardian IN (0, 1)),
  guardian_id   TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  registered_at INTEGER NOT NULL,
  outcome       TEXT CHECK (outcome IS NULL OR outcome IN ('invite_trial', 'declined')),
  outcome_note  TEXT,
  outcome_at    INTEGER
) STRICT;
CREATE UNIQUE INDEX open_trial_registrations_open_trial_id_player_id ON open_trial_registrations(open_trial_id, player_id);
CREATE INDEX open_trial_registrations_player_id ON open_trial_registrations(player_id);


-- ---------------------------------------------------------------------
-- matchdays
-- source: db.matchdays  created at server.mjs:226; rows minted at server.mjs:2862-2866 (grassroots orgs only)
-- owner/writer: server.mjs   lifecycle: append-only; never deleted or edited
-- mapping: id -> id (md-N — prefix SHARED with players.medical.records md-*; the global counter keeps values distinct);
--          orgId -> org_id; fixture -> fixture; venue -> venue ('' when absent); date -> match_date; result -> result (<=20, nullable);
--          playerIds[] -> matchday_players child table; loggedByUserId -> logged_by_user_id; ts -> created_at (source field is literally `ts`)
-- notes: the same request also appends an att-* row to each credited player's attendance (01_identity) and a
--        'matchday_logged' ledger row — those live in their own tables; this row is the squad-wide log.
--        Read patterns: by org newest first (server.mjs:2874); count by org (2869, 2901).
-- ---------------------------------------------------------------------
CREATE TABLE matchdays (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  fixture           TEXT NOT NULL,
  venue             TEXT NOT NULL DEFAULT '',
  match_date        TEXT NOT NULL CHECK (length(match_date) = 10),
  result            TEXT,
  logged_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_at        INTEGER NOT NULL
) STRICT;
CREATE INDEX matchdays_org_id_created_at ON matchdays(org_id, created_at);

-- source: db.matchdays[].playerIds[]  (credited rostered players, server.mjs:2859)
-- mapping: each id -> (matchday_id, player_id)
-- notes: no FK on player_id — survives player deletion as a tombstone (deletePlayerData leaves matchdays untouched).
CREATE TABLE matchday_players (
  matchday_id TEXT NOT NULL REFERENCES matchdays(id) ON DELETE CASCADE,
  player_id   TEXT NOT NULL,                           -- no FK: tombstone survives player deletion
  PRIMARY KEY (matchday_id, player_id)
) STRICT;


-- ---------------------------------------------------------------------
-- friendlies
-- source: db.friendlies  created at server.mjs:227; rows minted at server.mjs:2936-2940 (grassroots orgs only)
-- owner/writer: server.mjs   lifecycle: status is only ever 'open' (no close/accept route exists); never deleted
-- mapping: id -> id (fr-N); orgId -> org_id; orgName -> org_name; postedByUserId -> posted_by_user_id;
--          ageGroup -> age_group (default 'open'); date -> match_date; venue -> venue (falls back to org city, '' if none);
--          notes -> notes; status -> status; responses[] -> friendly_responses child table; createdAt -> created_at
-- notes: planning.mjs:85 reads status === 'open' ? 'open invitation' : 'confirmed opponent' but nothing writes
--        another value — CHECK lists only what is written. planning.mjs:85 also builds synthetic ids 'fr-'||id
--        (i.e. 'fr-fr-N') for the coverage union — read-time only. Read patterns: FULL SCAN filtered by
--        haversine distance between orgs.location of poster and reader (server.mjs:2949-2952) — needs a join
--        to orgs; by id (2969).
-- ---------------------------------------------------------------------
CREATE TABLE friendlies (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  org_name          TEXT NOT NULL,                     -- snapshot
  posted_by_user_id TEXT REFERENCES org_users(id) ON DELETE SET NULL,   -- code tolerates null (server.mjs:2976)
  age_group         TEXT NOT NULL DEFAULT 'open',
  match_date        TEXT NOT NULL CHECK (length(match_date) = 10),
  venue             TEXT NOT NULL DEFAULT '',
  notes             TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open')),
  created_at        INTEGER NOT NULL
) STRICT;
CREATE INDEX friendlies_org_id ON friendlies(org_id);
CREATE INDEX friendlies_match_date ON friendlies(match_date);

-- source: db.friendlies[].responses[]  ({orgId, orgName, message<=200, respondedByUserId, ts}, server.mjs:2975)
-- owner/writer: server.mjs   lifecycle: append-only; one per responding org ('ALREADY_RESPONDED', 2974)
-- mapping: orgId -> org_id; orgName -> org_name; message -> message ('' when absent); respondedByUserId -> responded_by_user_id;
--          ts -> responded_at (source field is literally `ts`)
-- notes: no id in source; natural PK (friendly_id, org_id) is exactly the uniqueness the code enforces.
--        message is shown only to the poster (2961) — a read-side rule, not a column.
CREATE TABLE friendly_responses (
  friendly_id          TEXT NOT NULL REFERENCES friendlies(id) ON DELETE CASCADE,
  org_id               TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  org_name             TEXT NOT NULL,                  -- snapshot
  message              TEXT NOT NULL DEFAULT '',
  responded_by_user_id TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  responded_at         INTEGER NOT NULL,
  PRIMARY KEY (friendly_id, org_id)
) STRICT;


-- ---------------------------------------------------------------------
-- invoices
-- source: db.invoices  created at server.mjs:222 (and seed.mjs:488); rows minted at adapters.mjs:164-176 (createBilling.invoiceForSigning)
-- owner/writer: adapters.mjs billing seam, called from m29/index.mjs:275   lifecycle: status only ever 'issued'; never
--               deleted except the in-request rollback at m29/index.mjs:619 (array truncated to its pre-request length)
-- mapping: id -> id (inv-N — prefix shared with org_invites); ts -> created_at (source field is literally `ts`);
--          orgId -> org_id; orgName -> org_name; signingId -> signing_id; playerName -> player_name; description -> description;
--          amount (MAJOR units, e.g. 1500) -> amount_minor (= amount * 100); currency -> currency (always 'EUR' today);
--          status -> status; provider -> provider
-- notes: one invoice per signing enforced by code before issuing (m29/index.mjs:275 `.some(i.signingId === signing.id)`)
--        -> unique index. player_name is retained after player deletion (deletePlayerData leaves invoices alone) —
--        billing record; retention justified but flagged. Read patterns: by org newest first (server.mjs:2627);
--        admin all (4153); existence by signing_id.
-- ---------------------------------------------------------------------
CREATE TABLE invoices (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name     TEXT NOT NULL,                          -- snapshot
  signing_id   TEXT NOT NULL REFERENCES signings(id) ON DELETE RESTRICT,
  player_name  TEXT NOT NULL,                          -- snapshot; personal data retained after deletion (billing)
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency     TEXT NOT NULL CHECK (length(currency) = 3),
  status       TEXT NOT NULL CHECK (status IN ('issued')),
  provider     TEXT NOT NULL CHECK (provider IN ('stripe', 'dev-ledger'))
) STRICT;
CREATE UNIQUE INDEX invoices_signing_id ON invoices(signing_id);
CREATE INDEX invoices_org_id_created_at ON invoices(org_id, created_at);


-- ---------------------------------------------------------------------
-- plans  (catalogue, keyed by name)
-- source: db.plans  object keyed by plan name; seeded from catalogue.mjs PLANS (seed.mjs:444) and restored by
--         m182/migrations.mjs:257 (`db.plans ??= planCatalogue()`); never written by a route
-- owner/writer: catalogue.mjs (constants) via seed/migration   lifecycle: static product configuration
-- mapping: object key -> name (PRIMARY KEY); name -> name (identical to the key); pricePerMonthGBP (major GBP) ->
--          price_per_month_minor (= value * 100) + currency 'GBP'; seats -> seats; attributionWindowMonths -> attribution_window_months;
--          antiCircumvention -> anti_circumvention
-- notes: read by name = orgs.plan (server.mjs:1112 /meta full dump; 3064, 3078 and m29/index.mjs:260 by key with
--        `?? 18` fallback). orgs.plan (01_identity) should REFERENCE plans(name) — declared there, not here.
--        An EMPTY table reproduces the M23-D2 billing bug (catalogue.mjs:24-29): the migration must insert the
--        four rows. `customised` seen in scripts/m23Persistence.mjs:84 is a test fixture, not a product field.
-- ---------------------------------------------------------------------
CREATE TABLE plans (
  name                      TEXT PRIMARY KEY CHECK (name IN ('Grassroots', 'Academy', 'Pro', 'Agency')),
  price_per_month_minor     INTEGER NOT NULL CHECK (price_per_month_minor >= 0),
  currency                  TEXT NOT NULL DEFAULT 'GBP' CHECK (length(currency) = 3),
  seats                     INTEGER NOT NULL CHECK (seats >= 1),
  attribution_window_months INTEGER NOT NULL CHECK (attribution_window_months >= 1),
  anti_circumvention        TEXT NOT NULL
) STRICT;


-- ---------------------------------------------------------------------
-- archetypes  (catalogue)
-- source: db.archetypes  seeded from catalogue.mjs ARCHETYPES (seed.mjs:435) and restored by m182/migrations.mjs:258; never written by a route
-- owner/writer: catalogue.mjs via seed/migration   lifecycle: static; exactly 5 rows
-- mapping: id -> id (arch-*); label -> label; position -> position; foot -> foot; dob -> dob (synthetic yardstick date);
--          heightCm -> height_cm; weightKg -> weight_kg; stats.appearances -> stat_appearances; stats.goals -> stat_goals;
--          stats.assists -> stat_assists
-- notes: not people — never counted or ranked as a person (catalogue.mjs:76-78). Read: full scan for the
--        similarity lead (server.mjs:1965). Shape mirrors the player fields similarityScore reads.
-- ---------------------------------------------------------------------
CREATE TABLE archetypes (
  id               TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  position         TEXT NOT NULL,
  foot             TEXT NOT NULL CHECK (foot IN ('left', 'right')),
  dob              TEXT NOT NULL CHECK (length(dob) = 10),
  height_cm        INTEGER NOT NULL,
  weight_kg        INTEGER NOT NULL,
  stat_appearances INTEGER NOT NULL,
  stat_goals       INTEGER NOT NULL,
  stat_assists     INTEGER NOT NULL
) STRICT;


-- ---------------------------------------------------------------------
-- reputation_seed  -- DEMO ONLY
-- source: db.reputationSeed  seeded at seed.mjs:438-442; m182/migrations.mjs:254 restores it as [] (empty is the
--         correct production value, storeContract.mjs:155); never written by a route
-- owner/writer: seed.mjs   lifecycle: static demo rows; EMPTY in production
-- mapping: scoutName -> scout_name; orgName -> org_name; discoveries -> discoveries; successRatePct -> success_rate_pct;
--          avgResaleMultiple -> avg_resale_multiple; seeded -> derived, not stored: always true for these rows —
--          the /reputation response (server.mjs:3102) returns them under `seeded` and computes live rows from the ledger with seeded:false
-- notes: no id in source; natural PK (scout_name, org_name) matches the live-row key `${scoutName}|${orgName}`.
--        Table exists only so demo snapshots migrate; a production migration inserts nothing.
-- ---------------------------------------------------------------------
CREATE TABLE reputation_seed (
  scout_name          TEXT NOT NULL,                   -- demo data; personal-looking names of fictional scouts
  org_name            TEXT NOT NULL,
  discoveries         INTEGER NOT NULL,
  success_rate_pct    INTEGER NOT NULL,
  avg_resale_multiple REAL NOT NULL,
  PRIMARY KEY (scout_name, org_name)
) STRICT;


-- ---------------------------------------------------------------------
-- delivery_callbacks_seen
-- source: db.deliveryCallbacksSeen  string[] created at m13/shared.mjs:28; appended at m13/delivery.mjs:185;
--         FIFO-capped at 5000 (oldest 1000 spliced, delivery.mjs:186)
-- owner/writer: m13/delivery.mjs /callbacks/delivery   lifecycle: idempotency ledger of processed provider callback ids
-- mapping: each string -> callback_id (PRIMARY KEY); seen_at -> NEW column (the array had only insertion order;
--          the migration assigns migration_time + array_index so the FIFO prune can keep working on seen_at)
-- notes: read pattern is membership test by id (delivery.mjs:184) — the PK. The cap becomes
--        `DELETE ... ORDER BY seen_at LIMIT 1000` when COUNT > 5000.
-- ---------------------------------------------------------------------
CREATE TABLE delivery_callbacks_seen (
  callback_id TEXT PRIMARY KEY,
  seen_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX delivery_callbacks_seen_seen_at ON delivery_callbacks_seen(seen_at);


-- ---------------------------------------------------------------------
-- ops_settings  (key/value singletons)
-- source: db.deliveryFailInject (object {email, push, contact?, trial?, decision?} of pending injected failures,
--         m13/delivery.mjs:20, incremented at 250, decremented at 29 and m23/{trialRoutes:391,628,830;
--         contactRoutes:461; decisionRoutes:360}) and db.deliveryCentreSince (number, m13/delivery.mjs:21, read at 82)
-- owner/writer: m13/delivery.mjs (+ m23 route files decrement)   lifecycle: persistent singletons; never deleted
-- mapping: deliveryCentreSince -> row key 'delivery_centre_since', value_json = epoch-ms integer;
--          deliveryFailInject.<channel> -> row key 'delivery_fail_inject.<channel>' for channel in
--          email | push | contact | trial | decision, value_json = non-negative integer
-- notes: DECISION — a table, not "not a table": both values are persisted on purpose and read after restart.
--        delivery_centre_since is the high-water mark that stops a retroactive email blast to every historical
--        notification when the delivery centre is first enabled (delivery.mjs:21,82-84) — losing it on restart
--        would re-send history. The fail-inject counters are decremented across separate requests and persisted
--        with persistNow() each time (delivery.mjs:251; trialRoutes.mjs:392) so a restart mid-test keeps the
--        remaining count. Neither is a collection, so one key/value table holds both; JSON value keeps the
--        column typeless for future singletons. updated_at is NEW (audit of admin injections).
-- ---------------------------------------------------------------------
CREATE TABLE ops_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL
) STRICT;


-- =====================================================================
-- not tables:
--   db.secrets.mediaSign (server.mjs:345-347) — MOVES TO ENVIRONMENT, no table. Justification: the code already
--     prefers process.env.MEDIA_SECRET and only falls back to the persisted value; OPERATIONS.md:4 and :11 state
--     secrets live in the environment and media-URL signing keys are per boot, and enterprise.mjs:454 promises
--     backups contain no signing secrets — persisting it contradicts all three and puts the key in every backup.
--     The only effect of dropping it is that signed media URLs (15-minute TTL, server.mjs:354) stop verifying
--     after a restart without MEDIA_SECRET set, which the clients already tolerate (links are re-minted on every
--     SSE tick). Deployment requirement: set MEDIA_SECRET; the migration does not copy the old value.
--   CONNECTORS registry (m13/imports.mjs:432-436) — code registry, status derived from env keys.
--   API_SCOPES, WEBHOOK_EVENTS, RETRY_MS ladders, MAX_ATTEMPTS, EXPORT_CONTRACT_VERSION (imports.mjs) — code constants
--     (the enum values appear as CHECKs above).
--   metrics counters, exposureHook, mfaAttempts map, IDP_SECRET, signToken/verifyToken (m13/enterprise.mjs) — in-memory / env.
--   PROVIDER 'local-fake', CALLBACK_SECRET (m13/delivery.mjs:25-26) — code constant / env DELIVERY_CALLBACK_SECRET.
--   Upload chunk files under DATA_DIR/upload-tmp/<id>/ (m12/operations.mjs:153-158) — filesystem, swept with the session.
--   Backups directory + manifest.json (m13/enterprise.mjs:428-484) — filesystem artefacts, listed from disk.
--   Derived at read time, never stored: grant liveness (revoked_at/expires_at), support-grant expiry, upload
--     `complete` flag, import rowCount, group `members`/`youAdmin` views, friendlies `mine`/`distanceKm`,
--     open-trial `registered`, pathway record, invoice existence check, reputation live rows (from ledger),
--     onboarding task completion (enterprise.mjs:127-144).
-- =====================================================================
