/**
 * The data layer: real tables in the same SQLite file as the snapshot store,
 * one domain at a time. `attachDataLayer` runs the table migrations, attaches
 * each domain repository, and replaces that domain's `db.<collection>` with
 * the repository's read-only view. Everything else in `db` is still the blob
 * snapshot until its domain moves here.
 *
 * LIVE tables, owned by repositories (docs/architecture/sqlite-migration-plan.md):
 *   org_users (step S0), sessions (S2, hashed tokens), orgs (S3), and since
 *   S4a players, guardians and guardian_children (repositories/identity.mjs,
 *   migration 0005). Writes go through the repositories and the blobs are
 *   never written again. The S1 shadow projection is retired: every table it
 *   shadowed is live, so there is nothing left to project or to validate.
 *   media_deletions (migration 0006) is the crash-safe queue of media files
 *   to remove after a player deletion commits (repositories/mediaDeletions.mjs).
 *
 * Order at boot (server.mjs): seed → loadSnapshot → snapshot migrations →
 * attachDataLayer → module registration → listen. A migrated collection is
 * therefore a plain array (seed or legacy blob) while the snapshot migrations
 * run, and a repository view from this point on. Inside attachDataLayer the
 * order is organisations → identity (guardians before players: the FK) →
 * staff → sessions, so every repository that references another finds its
 * rows in place on a first installation.
 *
 * This directory is `repositories/`, not `data/`: `data/` is the server's
 * runtime data directory (DATA_DIR), which tests delete between runs.
 */
import { runDataMigrations, dataSchemaReport } from './database.mjs';
import { createUsersRepository, USERS_TABLE } from './users.mjs';
import { createSessionsRepository, SESSIONS_TABLE } from './sessions.mjs';
import { createOrgsRepository, ORGS_TABLE } from './orgs.mjs';
import { createIdentityRepositories, IDENTITY_SNAPSHOT, IDENTITY_COLLECTIONS, PLAYERS_RETAINED, PLAYER_ERASURE_MIGRATION, PLAYER_ERASURE_CUTOVER_META } from './identity.mjs';
import { createMediaDeletionsQueue, MEDIA_DELETIONS_TABLE, MEDIA_DELETIONS_MIGRATION, assertMediaQueueConsistent } from './mediaDeletions.mjs';
import * as m0001 from './migrations/0001_org_users.mjs';
import * as m0002 from './migrations/0002_core_identity_shadow.mjs';
import * as m0003 from './migrations/0003_sessions_live.mjs';
import * as m0004 from './migrations/0004_orgs_live.mjs';
import * as m0005 from './migrations/0005_core_identity_live.mjs';
import * as m0006 from './migrations/0006_media_deletions.mjs';
import * as m0007 from './migrations/0007_player_subrecords.mjs';
import * as m0008 from './migrations/0008_one_time_codes.mjs';
import * as m0009 from './migrations/0009_notifications.mjs';
import * as m0010 from './migrations/0010_dispatches.mjs';
import * as m0011 from './migrations/0011_outbox_push.mjs';
import * as m0012 from './migrations/0012_channels.mjs';
import * as m0013 from './migrations/0013_safety_audit.mjs';
import * as m0014 from './migrations/0014_player_erasure.mjs';
import * as m0015 from './migrations/0015_recruitment.mjs';
import * as m0016 from './migrations/0016_recruitment_cases.mjs';
import { trialReportsFor } from './playerSubrecords.mjs';
import { createRecruitmentRepository, RECRUITMENT_SNAPSHOT, RECRUITMENT_COLLECTIONS, RECRUITMENT_MIGRATION, RECRUITMENT_CUTOVER_META, CASES_COLLECTION, assertRecruitmentConsistent, unresolvedPlayerReferences as unresolvedRecruitmentPlayers, retainedPlayerReferences as retainedRecruitmentPlayers } from './recruitment.mjs';
import { createRecruitmentCasesRepository, RECRUITMENT_CASES_SNAPSHOT, RECRUITMENT_CASES_COLLECTIONS, RECRUITMENT_CASES_MIGRATION, RECRUITMENT_CASES_CUTOVER_META, unresolvedPlayerReferences as unresolvedCasePlayers, retainedPlayerReferences as retainedCasePlayers } from './recruitmentCases.mjs';
import { createOneTimeCodesRepository, EMAIL_CHALLENGES_TABLE, PAIRING_CODES_TABLE, ONE_TIME_CODES_MIGRATION, ONE_TIME_CODES_CUTOVER_META, assertPairingCodesConsistent } from './oneTimeCodes.mjs';
import { createNotificationsRepository, NOTIFICATIONS_TABLE, NOTIFICATION_PREFS_TABLE, NOTIFICATIONS_MIGRATION, NOTIFICATIONS_CUTOVER_META } from './notifications.mjs';
import { createDispatchesRepository, DISPATCHES_TABLE, DISPATCHES_MIGRATION, DISPATCHES_CUTOVER_META } from './dispatches.mjs';
import { createOutboxPushRepository, OUTBOX_PUSH_SNAPSHOT_TABLES, OUTBOX_PUSH_MIGRATION, OUTBOX_PUSH_CUTOVER_META } from './outboxPush.mjs';
import { createChannelsRepository, CHANNELS_TABLE, CHANNELS_MIGRATION, CHANNELS_CUTOVER_META, assertChannelReferencesConsistent } from './channels.mjs';
import { createSafetyAuditRepository, AUDIT_COLLECTIONS, AUDIT_SNAPSHOT_TABLES, SAFETY_AUDIT_MIGRATION, SAFETY_AUDIT_CUTOVER_META, assertIdvQueueGuardiansConsistent, unresolvedPlayerReferences, retainedPlayerReferences } from './safetyAudit.mjs';

export const DATA_MIGRATIONS = Object.freeze([m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0014, m0015, m0016]);

// Single-collection dispatchers, in snapshot-write order: organisations first
// (staff reference them), then staff (sessions reference them), then
// sessions. Deletions of rows a snapshot no longer lists (`prune`) run
// afterwards in reverse order. The identity pair (players + guardians, coupled
// through the link rows) is dispatched as ONE unit between organisations and
// staff (see `writeTableBacked`).
const TABLES = Object.freeze([ORGS_TABLE, USERS_TABLE, SESSIONS_TABLE]);

/**
 * Collections the data layer owns; the server's store never writes these blobs
 * again. `mediaDeletions` is the media-removal queue: not a record collection
 * the server holds in memory, but part of every whole-database snapshot
 * (backups, restores) in its stored row form, so a restored server keeps the
 * intent to remove a file (review of 9656a4b, finding 2). `emailChallenges`
 * and `pairingCodes` (S6a, migration 0008) are the one-time-code tables in
 * their stored, hashed row form (repositories/oneTimeCodes.mjs).
 * `notifications` and `notificationPrefs` (S7a, migration 0009) are the
 * notification tables in the legacy collection shape, in insertion order
 * (repositories/notifications.mjs). `dispatches` (S7b, migration 0010) is the
 * delivery dispatch table with its attempts nested, in the eighteen-key shape
 * every build since M13 wrote, in insertion order (repositories/dispatches.mjs).
 * `outbox`, `pushLog` and `pushTokens` (S7c, migration 0011) are the mail
 * outbox (two writer literals, told apart structurally), the push log and the
 * device push tokens (any JSON token value, stored losslessly), each in its
 * legacy shape, in insertion order (repositories/outboxPush.mjs). `channels`
 * (S7d, migration 0012) are the message threads — the openChannel literal with
 * its messages nested in the postMessage literal and their attachments — in
 * insertion order, with legacy and unknown fields kept at every level
 * (repositories/channels.mjs). The eight audit collections `blocks`, `reports`,
 * `moderationLog`, `orgNotes`, `ledger`, `opsEvents`, `sourceChanges` and `idvQueue`
 * (S6b, migration 0013) are the audit tables in their writers' literals, in insertion
 * order, with unknown fields, absent keys and off-type values kept
 * (repositories/safetyAudit.mjs). `requests` and `trials` (S8a-core, migration
 * 0015) are the recruitment requests with their slots and the accepted trials
 * with their eleven owned child tables and the idempotency keys, each record in
 * its writer's literal, in insertion order, children in list order, with absence,
 * null, off-type and unknown fields kept losslessly (repositories/recruitment.mjs).
 * `recruitmentCases`, `roomComments`, `roomSnapshots`, `roomDecisions` and
 * `roomEvidenceState` (S8b, migration 0016) are the recruitment cases — the M12
 * case with its M17 Room facet, M23 decision draft, M27 transaction handoff and
 * M13 budget — and the four room collections, twenty-five tables, each record in
 * its writer's literal, in insertion order, children in list order, absence,
 * null, off-type and unknown fields kept losslessly (repositories/recruitmentCases.mjs).
 */
export const TABLE_BACKED = Object.freeze(['orgs', ...IDENTITY_COLLECTIONS, PLAYERS_RETAINED.name, 'users', 'sessions', MEDIA_DELETIONS_TABLE.name, EMAIL_CHALLENGES_TABLE.name, PAIRING_CODES_TABLE.name, NOTIFICATIONS_TABLE.name, NOTIFICATION_PREFS_TABLE.name, DISPATCHES_TABLE.name, ...OUTBOX_PUSH_SNAPSHOT_TABLES.map((t) => t.name), CHANNELS_TABLE.name, ...AUDIT_COLLECTIONS, ...RECRUITMENT_COLLECTIONS, ...RECRUITMENT_CASES_COLLECTIONS]);
/** The one-time-code tables, dispatched after the organisations are pruned (the challenge references its organisation) and after the identity pair (the final-state check reads the players). */
const CODE_TABLES = Object.freeze([EMAIL_CHALLENGES_TABLE, PAIRING_CODES_TABLE]);
/** The notification, dispatch, outbox and push tables: no reference to any other table (polymorphic audiences; the dispatch's notification reference is indexed, not a foreign key; the outbox and push rows reference nothing), dispatched last. */
const NOTIFICATION_TABLE_DISPATCH = Object.freeze([NOTIFICATIONS_TABLE, NOTIFICATION_PREFS_TABLE, DISPATCHES_TABLE, ...OUTBOX_PUSH_SNAPSHOT_TABLES]);

/**
 * Whole-snapshot access for tools that read or write the database file as one
 * unit: backups, restores and the persistence suites. `readTableBacked` returns
 * every table-backed collection whose table is authoritative, as plain arrays
 * in the shape the server sees; `writeTableBacked` replaces the contents of
 * every such table from `db` and returns the names it wrote, so the caller
 * writes the remaining collections as blobs. The caller owns the transaction.
 */
export function readTableBacked(sqlite) {
  const out = {};
  for (const table of TABLES) {
    const rows = table.read(sqlite);
    if (rows) out[table.name] = rows;
  }
  const identity = IDENTITY_SNAPSHOT.read(sqlite);
  if (identity) Object.assign(out, identity);
  const retained = PLAYERS_RETAINED.read(sqlite); // S4b-R: the retained records, under their own name, never inside `players`
  if (retained) out[PLAYERS_RETAINED.name] = retained;
  const queue = MEDIA_DELETIONS_TABLE.read(sqlite);
  if (queue) out[MEDIA_DELETIONS_TABLE.name] = queue;
  for (const table of [...CODE_TABLES, ...NOTIFICATION_TABLE_DISPATCH, CHANNELS_TABLE, ...AUDIT_SNAPSHOT_TABLES]) {
    const rows = table.read(sqlite);
    if (rows) out[table.name] = rows;
  }
  const recruitment = RECRUITMENT_SNAPSHOT.read(sqlite); // S8a-core: requests and trials from their tables (null before the 0015 record: the blobs stay)
  if (recruitment) Object.assign(out, recruitment);
  const cases = RECRUITMENT_CASES_SNAPSHOT.read(sqlite); // S8b: the five collections from their tables (null before the 0016 record)
  if (cases) Object.assign(out, cases);
  return out;
}
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

/**
 * Check the shape of every table-backed collection a snapshot carries, before
 * anything is dispatched to a table or written as a blob. A collection that
 * is absent (or `undefined`, which JSON cannot carry) is OMITTED: a partial
 * snapshot that leaves that domain alone. A collection that is present but
 * not an array — an object, null, a string, a number — is an explicitly
 * supplied invalid value and THROWS, so the caller's transaction rolls back
 * with nothing written: no table row, and no blob that could carry whatever
 * the value held (a plaintext token, say). The identity pair is coupled: a
 * snapshot that carries `players` must carry `guardians` and vice versa (the
 * link rows derive from both), so one without the other THROWS too. Returns
 * the names that are present.
 */
export function checkTableBackedShapes(db) {
  const present = [];
  for (const name of TABLE_BACKED) {
    const value = db?.[name];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new TypeError(`${name}: the snapshot collection must be an array of records (got ${describe(value)}); the save was rolled back and nothing was written`);
    present.push(name);
  }
  const identityPresent = IDENTITY_COLLECTIONS.filter((n) => present.includes(n));
  if (identityPresent.length === 1) throw new TypeError(`${identityPresent[0]}: a snapshot that carries ${identityPresent[0]} must carry ${IDENTITY_COLLECTIONS.find((n) => n !== identityPresent[0])} too (the guardian–child links derive from both collections); the save was rolled back and nothing was written`);
  return present;
}

export function writeTableBacked(sqlite, db, { now = Date.now() } = {}) {
  const written = [];
  const present = checkTableBackedShapes(db);
  const single = (name) => TABLES.find((t) => t.name === name);
  // `replace` is false before the domain's cutover record exists (the blob
  // is still authoritative, so the caller writes it) and THROWS on a row the
  // table refuses, which rolls the caller's whole transaction back.
  if (present.includes('orgs') && single('orgs').replace(sqlite, db.orgs)) written.push('orgs');
  // S5: the `trials` the snapshot carries (written as a blob below, in the same transaction) judge every `trialReports` claim on its players; a snapshot without them is judged by the retained blob.
  if (IDENTITY_COLLECTIONS.every((n) => present.includes(n)) && IDENTITY_SNAPSHOT.replace(sqlite, { players: db.players, guardians: db.guardians }, { now, trials: Object.hasOwn(db, 'trials') && db.trials !== undefined ? db.trials : undefined })) written.push(...IDENTITY_COLLECTIONS);
  // S4b-R: the retained records go right after the identity pair (which carried the
  // existing ones through its rewrite). PROTECTED (review of 6d66655, F1): a supplied
  // collection may only ADD records — every stored record must be listed unchanged or
  // the whole save is refused (ids only); new records are checked against the live rows
  // as they now stand; an omitted collection keeps the rows.
  if (present.includes(PLAYERS_RETAINED.name) && PLAYERS_RETAINED.replace(sqlite, db[PLAYERS_RETAINED.name])) written.push(PLAYERS_RETAINED.name);
  // The staff rows are upserted here and pruned below, after the requests that name them
  // (S8a-core: recruitment_requests.user_id is a RESTRICT key); the sessions, which name
  // the staff, are written after that prune so a session of a staff member the snapshot
  // no longer lists is refused with its id, as before.
  if (present.includes('users') && single('users').replace(sqlite, db.users, { prune: false })) written.push('users');
  // The media-removal queue: validated entry by entry and rewritten (false before migration 0006, so the caller writes the blob the migration imports).
  if (present.includes(MEDIA_DELETIONS_TABLE.name) && MEDIA_DELETIONS_TABLE.replace(sqlite, db[MEDIA_DELETIONS_TABLE.name])) written.push(MEDIA_DELETIONS_TABLE.name);
  // S7d: the message threads are dispatched after the identity pair and the staff
  // (their guardians and organisations are then the snapshot's) and BEFORE the
  // organisation prune, so an organisation the snapshot removed while a thread
  // still names it is refused by the org foreign key at the prune (below) rather
  // than vanishing under its thread. The incoming rows' request references are
  // checked against the snapshot's `requests` when it carries them, the retained
  // blob otherwise (false before the 0012 record exists: the caller writes the blob).
  const requestsSupplied = Object.hasOwn(db, 'requests') && db.requests !== undefined;
  const trialsSupplied = Object.hasOwn(db, 'trials') && db.trials !== undefined;
  const casesSupplied = Object.hasOwn(db, CASES_COLLECTION) && db[CASES_COLLECTION] !== undefined;
  // S8b (readiness review §6, P A R | B | C D | E | F1 F2 F3 | G): the preflight
  // of the five case collections against the FINAL combined graph (the supplied
  // requests/trials included), A the supplied cases with their owned children,
  // R the release of the link rows the S8a phases or the request prune would
  // hit — BEFORE the S8a phases (the recruitment_requests/trials case key is
  // satisfied because the cases are in place). `null` before the 0016 record:
  // the caller writes the five blobs.
  const casesPlan = RECRUITMENT_CASES_SNAPSHOT.begin(sqlite, db, { requests: requestsSupplied ? db.requests : undefined, trials: trialsSupplied ? db.trials : undefined, orgs: present.includes('orgs') ? db.orgs : undefined, users: present.includes('users') ? db.users : undefined, label: 'the snapshot (cases, rooms, requests and trials)' });
  if (casesPlan) written.push(...casesPlan.written);
  // S8a-core (plan §D.7.5): phases 1–3 of the recruitment write — the supplied
  // requests upserted with the back-reference parked, the trials' departures,
  // releases and arrivals, the final trial_id assigned — go after the identity
  // pair and the staff (the organisation and staff keys) and BEFORE the channels
  // (phase 4: a thread's request_id is a real key now) and the prunes. An omitted
  // collection is retained: a case-only change persists what the same change
  // with the unchanged requests persists. The strict case references resolve
  // against the recruitmentCases collection the snapshot supplies, or the retained
  // table rows (since 0016; the blob before, Q7b); false before the 0015 record:
  // the caller writes the blobs.
  if (requestsSupplied || trialsSupplied) written.push(...RECRUITMENT_SNAPSHOT.replace(sqlite, { requests: requestsSupplied ? db.requests : undefined, trials: trialsSupplied ? db.trials : undefined }, { cases: casesSupplied ? db[CASES_COLLECTION] : undefined, orgs: present.includes('orgs') ? db.orgs : undefined, users: present.includes('users') ? db.users : undefined, label: 'the snapshot (requests and trials)' }));
  // S8b C and D: the supplied cases' link rows (their request/trial keys are
  // satisfied now) with the released rows of the retained cases back verbatim;
  // the supplied room collections.
  RECRUITMENT_CASES_SNAPSHOT.links(sqlite, casesPlan);
  RECRUITMENT_CASES_SNAPSHOT.rooms(sqlite, casesPlan);
  if (present.includes(CHANNELS_TABLE.name) && CHANNELS_TABLE.replace(sqlite, db[CHANNELS_TABLE.name], { requests: requestsSupplied ? db.requests : undefined })) written.push(CHANNELS_TABLE.name);
  // Rows the snapshot no longer lists go last, children before parents, so a
  // parent that is still referenced makes the foreign key refuse the save
  // instead of the row disappearing under its dependants. (The identity pair
  // prunes inside its own replace, players before guardians.) S8b F1: the room
  // rows a supplied room collection no longer lists go first (before their
  // case). S8a-core phase 5 (S8b F2): the requests no longer listed — after the
  // channels (a thread still naming one refuses the save; an intentional removal
  // removes the thread in the same snapshot) and before the staff and
  // organisations they reference. S8b F3: the cases no longer listed (each
  // departing owner's history and key rows explicitly, then the parent) — after
  // every request, trial and room row that named them, before the staff.
  RECRUITMENT_CASES_SNAPSHOT.pruneRooms(sqlite, casesPlan);
  if (written.includes('requests')) RECRUITMENT_SNAPSHOT.prune(sqlite, { requests: db.requests, label: 'the snapshot (requests and channels together)' });
  RECRUITMENT_CASES_SNAPSHOT.pruneCases(sqlite, casesPlan);
  if (written.includes('users')) single('users').prune(sqlite, db.users); // the staff no longer listed (their sessions cascade), after the requests and cases that named them
  if (present.includes('sessions') && single('sessions').replace(sqlite, db.sessions)) written.push('sessions'); // against the FINAL staff rows
  for (const name of ['sessions', 'orgs']) {
    if (written.includes(name)) single(name).prune?.(sqlite, db[name]);
  }
  // The ownership invariant on the FINAL combined state (review of 4ef9345):
  // whichever side this snapshot wrote — the identity pair, the queue, or both —
  // no queued removal may name a clip a live player still carries. A refusal
  // throws inside the caller's transaction, so the whole save rolls back,
  // unrelated changes included.
  if (written.some((n) => IDENTITY_COLLECTIONS.includes(n) || n === MEDIA_DELETIONS_TABLE.name)) assertMediaQueueConsistent(sqlite, { label: 'the snapshot (players and mediaDeletions together)' });
  // S6a: the one-time codes go after the prunes (a challenge of an organisation
  // the snapshot removed is refused by its foreign key, never cascaded away
  // after being written) and after the identity pair (the players table is the
  // snapshot's). A snapshot that rewrote the players but omitted the pairing
  // codes keeps the retained codes, which must still name existing players —
  // the FINAL combined state is checked whichever side was written.
  for (const table of CODE_TABLES) if (present.includes(table.name) && table.replace(sqlite, db[table.name])) written.push(table.name);
  if (written.some((n) => IDENTITY_COLLECTIONS.includes(n))) assertPairingCodesConsistent(sqlite, { label: 'the snapshot (players and pairingCodes together)' });
  // S7a/S7b/S7c: the notification, dispatch, outbox and push tables reference
  // nothing (polymorphic audiences, no cascade with a person; a dispatch's
  // notification reference is indexed but not a foreign key — an orphan is
  // legal; an outbox or push row references nothing at all), so a snapshot
  // that carries one collection and omits another leaves the omitted table
  // alone; each entry is validated (never coerced) and one refusal rolls the
  // whole save back.
  for (const table of NOTIFICATION_TABLE_DISPATCH) if (present.includes(table.name) && table.replace(sqlite, db[table.name])) written.push(table.name);
  // S7d: the FINAL combined state of the threads (review §11.5, corrected by the
  // review of 8330f08): whenever this snapshot wrote the channels, carries the
  // requests, or rewrote the identity pair, every thread row the file now holds
  // must name a request in the final requests (the supplied collection, or the
  // retained blob when omitted — never an empty set for an omission), an existing
  // guardian when it names one (the code-validated reference: the guardians table
  // was rewritten above and carries no foreign key from channels) and an existing
  // organisation. A miss throws inside the caller's transaction: the whole save
  // rolls back, unrelated collections and the save revision included.
  if (written.includes(CHANNELS_TABLE.name) || requestsSupplied || written.some((n) => IDENTITY_COLLECTIONS.includes(n))) {
    assertChannelReferencesConsistent(sqlite, { requests: requestsSupplied ? db.requests : undefined, label: 'the snapshot (channels, requests and guardians together)' });
  }
  // S6b: the eight audit tables go after the identity pair and the prunes. They carry
  // no foreign key. Domain P (the five player references): a snapshot that rewrites
  // the players and omits an audit collection keeps every audit row as it is, and a
  // supplied audit collection may name players that are absent — tolerated and
  // counted, never refused (Q4). Domain G (the IDV guardian reference, Q4b): an
  // incoming queue is checked against the guardians table as it stands (the identity
  // pair was dispatched above), and the FINAL combined state is asserted whenever this
  // snapshot wrote the queue OR rewrote the identity pair — the queue omitted
  // included — so a guardian removed under a retained entry refuses the whole save.
  for (const table of AUDIT_SNAPSHOT_TABLES) if (present.includes(table.name) && table.replace(sqlite, db[table.name])) written.push(table.name);
  if (written.includes('idvQueue') || written.some((n) => IDENTITY_COLLECTIONS.includes(n))) {
    assertIdvQueueGuardiansConsistent(sqlite, { label: 'the snapshot (idvQueue and guardians together)' });
  }
  // S8a-core phase 6: the FINAL combined state of the recruitment graph whenever
  // this snapshot wrote the requests or the trials, carries the recruitmentCases
  // collection, or rewrote the identity pair (the guardians): every request/trial
  // pair agrees (the pre-P4B legacy pair tolerated), every case id is in the final
  // recruitmentCases (Q7b), every guardian id in the final guardians table (Q7c).
  // A miss throws inside the caller's transaction: the whole save rolls back.
  if (written.some((n) => RECRUITMENT_COLLECTIONS.includes(n)) || casesSupplied || written.some((n) => IDENTITY_COLLECTIONS.includes(n))) {
    assertRecruitmentConsistent(sqlite, { cases: casesSupplied ? db[CASES_COLLECTION] : undefined, label: 'the snapshot (requests, trials, recruitmentCases and guardians together)' });
  }
  // S8b G: whenever this snapshot touched the case graph — every link target in
  // the final tables, the decision chain, foreign_key_check empty.
  if (casesPlan) RECRUITMENT_CASES_SNAPSHOT.assert(sqlite, { label: 'the snapshot (cases, rooms, requests and trials together)' });
  return written;
}

export function attachDataLayer({ db, store, nextId, sessionTtlMs, now = Date.now, log = () => {}, warn = (m) => console.warn(m) }) {
  const sqlite = store?.sqlite ?? null;
  if (!sqlite) throw new TypeError('the data layer needs a store with a SQLite connection (node:sqlite); there is no in-memory or JSON fallback');
  const migrations = runDataMigrations(sqlite, DATA_MIGRATIONS, { now: now(), log, context: { sessionTtlMs } });

  // Organisations (S3) attach before staff: `org_users.org_id` references
  // `orgs`, so a first installation must have its organisations in the table
  // before a staff row can be inserted. Initialisation is explicit state the
  // cutover migration recorded: only while it is `pending` (a database that
  // had never been saved to) are the in-memory records — the seed — imported,
  // once, atomically with the state change. Every other boot attaches to the
  // table as it is, empty or not; the array in memory is never imported.
  // Facet changes made on the records between saves are flushed inside every
  // save transaction and counted as persisted only once it committed.
  // `unit` is the store's participant API ({ active(), join(work) }): inside a
  // unit of work a repository's row writes join its transaction through the
  // poisoning boundary and its bookkeeping is staged; the staff repository
  // refuses (not integrated yet).
  const orgs = createOrgsRepository({ sqlite, log, warn, unit: store.unit });
  const orgsBoot = orgs.initState() === 'pending' ? orgs.initialize(db.orgs) : orgs.attach(db.orgs);
  Object.defineProperty(db, 'orgs', { value: orgs.view, writable: false, configurable: false, enumerable: true });
  store.setSaveHook?.(orgs.saveHook());

  // Players and guardians (S4a): one repository pair, one unit-of-work
  // participant. The same explicit initialisation state as the organisations
  // (`meta.coreIdentityInit`, written by migration 0005): `pending` only for a
  // genuinely new database, whose seed is imported once through the reviewed
  // preflight (a refused seed — the Founder's legacy-minor rule included —
  // aborts the boot and the next boot retries); `done` attaches to the tables
  // as they are and never imports an array, so a stale blob or seed can never
  // replace live data. Guardians load before players (the foreign key) inside
  // the repositories.
  // S5: the player arrays are rows of the `player_*` tables (migration 0007) and
  // `trialReports` is derived from the trials collection, read live: since
  // S8a-core from the recruitment repository's mirror (attached below; the
  // accessor is late-bound), before it from the `db.trials` array as it stands.
  let recruitment = null;
  const identity = createIdentityRepositories({ sqlite, log, warn, unit: store.unit, now, trialReports: (playerId) => (recruitment ? recruitment.trialReportsFor(playerId) : trialReportsFor(db.trials, playerId)) });
  const identityBoot = identity.initState() === 'pending'
    ? identity.initialize({ players: db.players, guardians: db.guardians }, { now: now() })
    : identity.attach(db.players, db.guardians);
  Object.defineProperty(db, 'players', { value: identity.players.view, writable: false, configurable: false, enumerable: true });
  Object.defineProperty(db, 'guardians', { value: identity.guardians.view, writable: false, configurable: false, enumerable: true });
  store.setSaveHook?.(identity.saveHook());

  const users = createUsersRepository({ sqlite, nextId, log, warn, unit: store.unit });
  const usersBoot = users.attach(db.users);
  Object.defineProperty(db, 'users', { value: users.view, writable: false, configurable: false, enumerable: true });

  // Sessions (S2): live table, hashed tokens. The in-memory blob copy loaded
  // before the migrations ran is discarded here; the migration imported the
  // authoritative blob from the file inside its own transaction.
  const sessions = createSessionsRepository({ sqlite, sessionTtlMs, log });
  const sessionsBoot = sessions.attach();
  Object.defineProperty(db, 'sessions', { value: sessions.view, writable: false, configurable: false, enumerable: true });

  // The media-deletion queue (migration 0006): rows are written inside the
  // deletion's unit of work; the server processes them after commit and at boot.
  // The live records the server holds count as references too (an upload whose facet is not flushed yet).
  const mediaDeletions = createMediaDeletionsQueue({ sqlite, log, warn, now, liveRecords: () => identity.players.view });
  // The queue is its table and nothing else. A `mediaDeletions` array the
  // caller holds in memory is either the blob migration 0006 just imported
  // from the file (a restored backup: the array is dropped, the table is the
  // queue) or a stale copy (reported, dropped, and its blob row deleted so no
  // save can bring it back). The queue never imports from memory.
  if (Object.hasOwn(db, MEDIA_DELETIONS_TABLE.name)) {
    const given = db[MEDIA_DELETIONS_TABLE.name];
    if (!migrations.ran.includes(MEDIA_DELETIONS_MIGRATION) && Array.isArray(given) && given.length) warn(`media deletions: an in-memory array with ${given.length} entr${given.length === 1 ? 'y' : 'ies'} was ignored; the media_deletions table is authoritative`);
    delete db[MEDIA_DELETIONS_TABLE.name];
    sqlite.prepare('DELETE FROM collections WHERE name = ?').run(MEDIA_DELETIONS_TABLE.name);
  }

  // One-time codes (S6a, migration 0008): the two tables are the codes and
  // nothing else. An `emailChallenges` / `pairingCodes` array the caller holds
  // in memory is either the blob the migration just imported from the file (a
  // restored backup, a pre-S6a file: the array is dropped, the table is the
  // record) or a stale copy — the seed's empty containers, a server-side
  // `??= []` — which is reported when it is not empty, dropped, and its blob
  // row deleted so no save can bring it back. The repository never imports
  // from memory. From here on `db.emailChallenges` / `db.pairingCodes` are
  // hash-free read-only views. The repository takes part in the store's unit
  // of work through the participant API: inside a unit its mutations join the
  // unit (a failure poisons it even when caught); outside one they run in a
  // transaction of their own.
  const codes = createOneTimeCodesRepository({ sqlite, log, now, unit: store.unit });
  const codesBoot = codes.attach({ at: now() });
  if (migrations.ran.includes(ONE_TIME_CODES_MIGRATION)) {
    const record = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(ONE_TIME_CODES_CUTOVER_META)?.value;
    if (record) { const c = JSON.parse(record); log(`one-time codes: cutover imported ${c.emailChallenges.imported} e-mail challenge(s) (${c.emailChallenges.droppedExpired} expired, not imported) and ${c.pairingCodes.imported} pairing code(s) (${c.pairingCodes.droppedExpired} expired, not imported)`); }
  }
  for (const [name, view] of [[EMAIL_CHALLENGES_TABLE.name, codes.emailChallengesView], [PAIRING_CODES_TABLE.name, codes.pairingCodesView]]) {
    if (Object.hasOwn(db, name)) {
      const given = db[name];
      if (!migrations.ran.includes(ONE_TIME_CODES_MIGRATION) && Array.isArray(given) && given.length) warn(`one-time codes: an in-memory ${name} array with ${given.length} entr${given.length === 1 ? 'y' : 'ies'} was ignored; the ${name === 'pairingCodes' ? 'pairing_codes' : 'email_challenges'} table is authoritative`);
      delete db[name];
      sqlite.prepare('DELETE FROM collections WHERE name = ?').run(name);
    }
    Object.defineProperty(db, name, { value: view, writable: false, configurable: false, enumerable: true });
  }

  // Notifications and category preferences (S7a, migration 0009): the three
  // tables are the record. The repository runs in its STAGED mode here (see
  // repositories/notifications.mjs): a standalone write lands inside the next
  // snapshot save together with the blob edits made alongside it, a write
  // inside a unit of work lands in the unit's commit, and the save hook
  // registered below is how both happen. A `notifications` /
  // `notificationPrefs` array the caller holds in memory is either the blob the
  // migration just imported from the file (a restored backup, a pre-S7a file:
  // dropped, the table is the record) or a stale copy — the seed's empty
  // container, the snapshot migrations' `??= []` — which is reported when it is
  // not empty, dropped, and its blob row deleted so no save can bring it back.
  // The repository never imports from memory and never infers initialisation
  // from row counts. From here on `db.notifications` / `db.notificationPrefs`
  // are read-only views over the mirror the repository keeps current.
  // `runEffect` is the store's afterCommit: at the moment the repository runs an
  // effect no unit is open (the store closes the unit before it reports the
  // commit), so the effect runs at once, counted and logged, never thrown.
  const notifications = createNotificationsRepository({ sqlite, log, warn, now, nextId, unit: store.unit, staged: true, runEffect: (fn) => store.afterCommit(fn) });
  const notificationsBoot = notifications.attach();
  store.setSaveHook?.(notifications.saveHook());
  if (migrations.ran.includes(NOTIFICATIONS_MIGRATION)) {
    const record = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(NOTIFICATIONS_CUTOVER_META)?.value;
    if (record) { const c = JSON.parse(record); log(`notifications: cutover imported ${c.notifications.imported} notification(s) (${Object.values(c.notifications.normalised).reduce((a, b) => a + b, 0)} field normalisation(s), ${c.notifications.withExtraFields} with unknown fields kept) and ${c.notificationPrefs.imported} preference record(s) (${c.notificationPrefs.categories} category settings)`); }
  }
  for (const [name, view] of [[NOTIFICATIONS_TABLE.name, notifications.view], [NOTIFICATION_PREFS_TABLE.name, notifications.prefsView]]) {
    if (Object.hasOwn(db, name)) {
      const given = db[name];
      if (!migrations.ran.includes(NOTIFICATIONS_MIGRATION) && Array.isArray(given) && given.length) warn(`notifications: an in-memory ${name} array with ${given.length} entr${given.length === 1 ? 'y' : 'ies'} was ignored; the ${name === 'notifications' ? 'notifications' : 'notification_prefs'} table is authoritative`);
      delete db[name];
      sqlite.prepare('DELETE FROM collections WHERE name = ?').run(name);
    }
    Object.defineProperty(db, name, { value: view, writable: false, configurable: false, enumerable: true });
  }

  // Delivery dispatches (S7b, migration 0010): the two tables are the record.
  // The repository runs in its STAGED mode here (see repositories/dispatches.mjs):
  // a sweep's rows, attempts and status changes land inside the next snapshot
  // save together with the blob edits made alongside them (the outbox row, the
  // failure-injection counter, the ops event, the webhook delivery intent); an
  // acknowledgment's changes land in the unit's commit with the notification's
  // contract. A `dispatches` array the caller holds in memory is either the
  // blob the migration just imported from the file (a restored backup, a
  // pre-S7b file: dropped, the table is the record) or a stale copy
  // (migrateM13's `??= []`), reported when it is not empty, dropped, and its
  // blob row deleted so no save can bring it back. The repository never imports
  // from memory. From here on `db.dispatches` is a read-only view over the
  // mirror. There is no effects queue: a dispatch has no push and no live event.
  const dispatches = createDispatchesRepository({ sqlite, log, now, unit: store.unit, staged: true });
  const dispatchesBoot = dispatches.attach();
  store.setSaveHook?.(dispatches.saveHook());
  if (migrations.ran.includes(DISPATCHES_MIGRATION)) {
    const record = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(DISPATCHES_CUTOVER_META)?.value;
    if (record) { const c = JSON.parse(record).dispatches; log(`dispatches: cutover imported ${c.imported} dispatch record(s) with ${c.attempts} attempt(s) (${c.withExtraFields} with unknown fields kept, ${c.orphanReferences} referencing a notification that no longer exists — retained as they were)`); }
  }
  if (Object.hasOwn(db, DISPATCHES_TABLE.name)) {
    const given = db[DISPATCHES_TABLE.name];
    if (!migrations.ran.includes(DISPATCHES_MIGRATION) && Array.isArray(given) && given.length) warn(`dispatches: an in-memory dispatches array with ${given.length} entr${given.length === 1 ? 'y' : 'ies'} was ignored; the dispatches table is authoritative`);
    delete db[DISPATCHES_TABLE.name];
    sqlite.prepare('DELETE FROM collections WHERE name = ?').run(DISPATCHES_TABLE.name);
  }
  Object.defineProperty(db, DISPATCHES_TABLE.name, { value: dispatches.view, writable: false, configurable: false, enumerable: true });

  // The mail outbox, the push log and the device push tokens (S7c, migration
  // 0011): the three tables are the record, one participant. STAGED mode here
  // (see repositories/outboxPush.mjs): a mailer record lands in the save the
  // route's persistNow() or the debounced save would have carried its blob
  // entry in; a delivery record in the sweep's save with the dispatch rows of
  // the pass; a push record — written by the after-durable effect AFTER the
  // notification's save committed — in the later save the sender's nextId()
  // already schedules (nothing new is scheduled here); a token in the route's
  // persist(). An `outbox` / `pushLog` / `pushTokens` array the caller holds
  // in memory is either the blob the migration just imported from the file (a
  // restored backup, a pre-S7c file: dropped, the table is the record) or a
  // stale copy (the seed's empty containers, server.mjs's `??= []`), reported
  // when it is not empty, dropped, and its blob row deleted so no save can
  // bring it back. The repository never imports from memory. From here on the
  // three `db.*` names are read-only views over the mirrors.
  const outboxPush = createOutboxPushRepository({ sqlite, log, now, unit: store.unit, staged: true });
  const outboxPushBoot = outboxPush.attach();
  store.setSaveHook?.(outboxPush.saveHook());
  if (migrations.ran.includes(OUTBOX_PUSH_MIGRATION)) {
    const record = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(OUTBOX_PUSH_CUTOVER_META)?.value;
    if (record) { const c = JSON.parse(record); log(`outbox/push: cutover imported ${c.outbox.imported} outbox record(s) (${c.outbox.bySource?.mailer ?? 0} mailer, ${c.outbox.bySource?.delivery ?? 0} delivery; ${c.outbox.withExtraFields} with unknown fields kept), ${c.pushLog.imported} push log record(s) and ${c.pushTokens.imported} device token(s) (${Object.entries(c.pushTokens.byTokenType ?? {}).map(([t, n]) => `${n} ${t}`).join(', ') || 'none'})`); }
  }
  for (const [name, view] of [['outbox', outboxPush.outbox.view], ['pushLog', outboxPush.pushLog.view], ['pushTokens', outboxPush.pushTokens.view]]) {
    if (Object.hasOwn(db, name)) {
      const given = db[name];
      if (!migrations.ran.includes(OUTBOX_PUSH_MIGRATION) && Array.isArray(given) && given.length) warn(`outbox/push: an in-memory ${name} array with ${given.length} entr${given.length === 1 ? 'y' : 'ies'} was ignored; the ${name === 'outbox' ? 'outbox' : name === 'pushLog' ? 'push_log' : 'push_tokens'} table is authoritative`);
      delete db[name];
      sqlite.prepare('DELETE FROM collections WHERE name = ?').run(name);
    }
    Object.defineProperty(db, name, { value: view, writable: false, configurable: false, enumerable: true });
  }

  // Message threads (S7d, migration 0012): the three tables are the record, one
  // participant. STAGED mode here (see repositories/channels.mjs): a thread lands
  // in the acceptance route's own save with the request's answer, a message in
  // postMessage's persistNow() before the sender hears 201, a receipt in its
  // route's save; a deletion joins the account-deletion unit (D-B). The
  // TRANSITIONAL CHECKED REFERENCE (D-A): `open` checks the request against the
  // live `requests` blob, read at the call (the modules replace that array). A
  // `channels` array the caller holds in memory is either the blob the migration
  // just imported from the file (a restored backup, a pre-S7d file: dropped, the
  // tables are the record) or a stale copy (the seed's empty container, the
  // snapshot migrations' `??= []`), reported when it is not empty, dropped, and
  // its blob row deleted so no save can bring it back. The repository never
  // imports from memory. From here on `db.channels` is a read-only view over the
  // mirror; the message arrays inside it are read-only too.
  //
  // S8a-core (migration 0015) attaches FIRST: the sixteen recruitment tables are the
  // record (recruitment_requests and request_trial_slots; trials and its eleven
  // owned child tables; idempotency_keys) and `channels.request_id` is a real
  // foreign key now, so the recruitment repository's save hook is registered
  // before the channels' — a thread's request row lands in the same save before
  // the thread row. STAGED mode (see repositories/recruitment.mjs): the two views
  // are read-only ARRAYS of plain, mutable records; every in-place change a route
  // makes (a status, a schedule, a pushed attendance row, a day container, a
  // report) lands in the next save's flush, a new record enters through
  // `addRequest` / `addTrial`, the deletion unit's tombstones through
  // `tombstoneForPlayer`. The strict case references (Q7b) resolve against the
  // live `recruitmentCases` blob, read at the call; the guardian references (Q7c)
  // against the guardians table; the player references are tolerant (Q7a). A
  // `requests` / `trials` array the caller holds in memory is either the blob the
  // migration just imported from the file (a restored backup, a pre-S8a file:
  // dropped, the tables are the record) or a stale copy (the seed's empty
  // containers, the snapshot migrations' `??= []`), reported when it is not empty,
  // dropped, and its blob row deleted so no save can bring it back. The
  // repository never imports from memory.
  // S8b (migration 0016) — the recruitment cases and the four room collections,
  // twenty-five tables, one participant with FOUR save hooks placed around the
  // recruitment and channels hooks (readiness review §5–§6): hook 1 (the
  // preflight against the mirrors, A the changed cases, R the release of the
  // link rows the S8a phases would hit) BEFORE the recruitment hook — a case
  // row is in place before a request or trial names it through the real key;
  // hook 2 (C, the link rows back) AFTER it — their request/trial keys are
  // satisfied; hook 3 (D the changed room rows, F1 the removed ones) before the
  // channels; hook 4 (F3 the removed cases, G the final assertions) after the
  // channels and the request prune the recruitment hook runs internally. STAGED
  // mode (see repositories/recruitmentCases.mjs): the five views are read-only
  // ARRAYS of plain, mutable records; every in-place change a route makes (a
  // status move, a history entry, a task, a budget scenario, the draft, the
  // handoff, a comment edit or tombstone, an evidence state, a superseded
  // decision) lands in the next save's flush; a new record enters through
  // addCase / addComment / addSnapshot / addDecision / addEvidenceState, the
  // finalize route's transport-failure splice through removeDecision; the
  // deletion unit's tombstones are in-place edits landing in the unit's commit.
  // The player references are tolerant (Q8a); the organisation and staff keys
  // are real. A `recruitmentCases` / `room*` array the caller holds in memory
  // is either the blob the migration just imported from the file (a restored
  // backup, a pre-S8b file: dropped, the tables are the record) or a stale copy
  // (the seed's empty containers, the snapshot migrations' `??= []`), reported
  // when it is not empty, dropped, and its blob row deleted so no save can bring
  // it back. The repository never imports from memory.
  const recruitmentCases = createRecruitmentCasesRepository({ sqlite, log, now, unit: store.unit, staged: true, recruitment: () => recruitment });
  const recruitmentCasesBoot = recruitmentCases.attach();
  store.setSaveHook?.(recruitmentCases.coreHook());
  recruitment = createRecruitmentRepository({ sqlite, log, now, unit: store.unit, staged: true, cases: () => db[CASES_COLLECTION] });
  const recruitmentBoot = recruitment.attach();
  store.setSaveHook?.(recruitment.saveHook());
  store.setSaveHook?.(recruitmentCases.linksHook());
  store.setSaveHook?.(recruitmentCases.roomsHook());
  if (migrations.ran.includes(RECRUITMENT_CASES_MIGRATION)) {
    const record = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(RECRUITMENT_CASES_CUTOVER_META)?.value;
    if (record) { const c = JSON.parse(record); log(`recruitment cases: cutover imported ${RECRUITMENT_CASES_COLLECTIONS.map((n) => `${c[n]?.imported ?? 0} ${n}`).join(', ')} (${c.recruitmentCases?.roomless ?? 0} case(s) without a room facet; ${RECRUITMENT_CASES_COLLECTIONS.reduce((a, n) => a + (c[n]?.withExtraFields ?? 0), 0)} with unknown fields kept, ${RECRUITMENT_CASES_COLLECTIONS.reduce((a, n) => a + (c[n]?.withAbsentKeys ?? 0), 0)} with absent keys preserved, ${RECRUITMENT_CASES_COLLECTIONS.reduce((a, n) => a + (c[n]?.withOfftypeValues ?? 0), 0)} with off-type values kept); player references: ${c.players?.live ?? 0} live, ${c.players?.retained ?? 0} retained, ${c.players?.missing ?? 0} not in the players table (counted, never refused — Q8a); recruitment_requests and trials rebuilt with the real case key (${c.rebuilt?.requests ?? 0} request(s), ${c.rebuilt?.trials ?? 0} trial(s)), idempotency_keys rebuilt with the broadened owner CHECK (${c.rebuilt?.idempotencyKeys ?? 0} S8a key row(s))`); }
  }
  for (const name of RECRUITMENT_CASES_COLLECTIONS) {
    if (Object.hasOwn(db, name)) {
      const given = db[name];
      if (!migrations.ran.includes(RECRUITMENT_CASES_MIGRATION) && Array.isArray(given) && given.length) warn(`recruitment cases: an in-memory ${name} array with ${given.length} entr${given.length === 1 ? 'y' : 'ies'} was ignored; the ${{ recruitmentCases: 'recruitment_cases', roomComments: 'room_comments', roomSnapshots: 'room_snapshots', roomDecisions: 'room_decisions', roomEvidenceState: 'room_evidence_states' }[name]} table is authoritative`);
      delete db[name];
      sqlite.prepare('DELETE FROM collections WHERE name = ?').run(name);
    }
    Object.defineProperty(db, name, { value: recruitmentCases.views[name], writable: false, configurable: false, enumerable: true });
  }
  if (migrations.ran.includes(RECRUITMENT_MIGRATION)) {
    const record = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(RECRUITMENT_CUTOVER_META)?.value;
    if (record) { const c = JSON.parse(record); log(`recruitment: cutover imported ${c.requests.imported} request(s) (${c.requests.withExtraFields} with unknown fields kept, ${c.requests.withAbsentKeys} with absent keys preserved, ${c.requests.withOfftypeValues} with off-type values kept) and ${c.trials.imported} trial(s) (${c.trials.withExtraFields} with unknown fields kept, ${c.trials.withAbsentKeys} with absent keys preserved, ${c.trials.withOfftypeValues} with off-type values kept; ${c.trials.legacyPairs} pre-P4B legacy pair(s) whose request carries no trialId key, kept as they are; ${c.trials.preP4bShape} trial(s) without the P4B containers, kept as they are); player references: ${c.players.live} live, ${c.players.retained} retained, ${c.players.missing} not in the players table (counted, never refused); channels rebuilt with the real request key (${c.channels.channels} thread(s), ${c.channels.messages} message(s), ${c.channels.attachments} attachment(s))`); }
  }
  for (const [name, view] of [['requests', recruitment.requestsView], ['trials', recruitment.trialsView]]) {
    if (Object.hasOwn(db, name)) {
      const given = db[name];
      if (!migrations.ran.includes(RECRUITMENT_MIGRATION) && Array.isArray(given) && given.length) warn(`recruitment: an in-memory ${name} array with ${given.length} entr${given.length === 1 ? 'y' : 'ies'} was ignored; the ${name === 'requests' ? 'recruitment_requests' : 'trials'} table is authoritative`);
      delete db[name];
      sqlite.prepare('DELETE FROM collections WHERE name = ?').run(name);
    }
    Object.defineProperty(db, name, { value: view, writable: false, configurable: false, enumerable: true });
  }

  const channels = createChannelsRepository({ sqlite, log, now, unit: store.unit, staged: true, requests: () => db.requests });
  const channelsBoot = channels.attach();
  store.setSaveHook?.(channels.saveHook());
  store.setSaveHook?.(recruitmentCases.pruneHook()); // S8b hook 4: F3 and G, after the channels and the request prune
  if (migrations.ran.includes(CHANNELS_MIGRATION)) {
    const record = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(CHANNELS_CUTOVER_META)?.value;
    if (record) { const c = JSON.parse(record); log(`channels: cutover imported ${c.imported} thread(s) (${c.byCounterparty?.player ?? 0} with a player, ${c.byCounterparty?.guardian ?? 0} with a guardian) with ${c.messages} message(s) and ${c.attachments} attachment(s); ${c.withExtraFields} with legacy or unknown fields kept, ${c.withAbsentKeys} with absent optional keys preserved`); }
  }
  if (Object.hasOwn(db, CHANNELS_TABLE.name)) {
    const given = db[CHANNELS_TABLE.name];
    if (!migrations.ran.includes(CHANNELS_MIGRATION) && Array.isArray(given) && given.length) warn(`channels: an in-memory channels array with ${given.length} entr${given.length === 1 ? 'y' : 'ies'} was ignored; the channels table is authoritative`);
    delete db[CHANNELS_TABLE.name];
    sqlite.prepare('DELETE FROM collections WHERE name = ?').run(CHANNELS_TABLE.name);
  }
  Object.defineProperty(db, CHANNELS_TABLE.name, { value: channels.view, writable: false, configurable: false, enumerable: true });

  // The eight audit collections (S6b, migration 0013): the tables are the record, one
  // participant. STAGED mode here (see repositories/safetyAudit.mjs): a block and its
  // ledger row land in the next save, a moderation hit in moderateOrRefuse's persist(),
  // a report in the next save with its suspension blocks and frozen requests, a note
  // in the next save, a source change in m181's persistNow(), an ops event in its
  // caller's save; the IDV entry and the admin toggle join their units of work. An
  // audit array the caller holds in memory is either the blob the migration just
  // imported from the file (a restored backup, a pre-S6b file: dropped, the tables are
  // the record) or a stale copy (the seed's empty containers, the snapshot migrations'
  // `??= []`), reported when it is not empty, dropped, and its blob row deleted so no
  // save can bring it back. The repository never imports from memory. From here on the
  // eight `db.*` names are read-only views over the mirrors.
  const safetyAudit = createSafetyAuditRepository({ sqlite, log, unit: store.unit, staged: true });
  const safetyAuditBoot = safetyAudit.attach();
  store.setSaveHook?.(safetyAudit.saveHook());
  if (migrations.ran.includes(SAFETY_AUDIT_MIGRATION)) {
    const record = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(SAFETY_AUDIT_CUTOVER_META)?.value;
    if (record) {
      const c = JSON.parse(record);
      const unresolved = Object.entries(c).filter(([, v]) => v && typeof v === 'object' && 'unresolvedPlayerIds' in v).map(([n, v]) => `${v.unresolvedPlayerIds} ${n}`).join(', ');
      log(`safety audit: cutover imported ${AUDIT_COLLECTIONS.map((n) => `${c[n]?.imported ?? 0} ${n}`).join(', ')}; ${AUDIT_COLLECTIONS.reduce((a, n) => a + (c[n]?.withExtraFields ?? 0), 0)} with unknown fields kept, ${AUDIT_COLLECTIONS.reduce((a, n) => a + (c[n]?.withOfftypeValues ?? 0), 0)} with off-type values kept; rows naming a player that is not in the players table (counted, imported as they are): ${unresolved}`);
    }
  }
  // S4b-R (migration 0014): the retained player records. A `playersRetained` array the
  // caller holds in memory is the blob the migration just imported (a restored backup, a
  // rollback copy re-upgraded) or stale; dropped, its blob row deleted; the rows are the record.
  if (migrations.ran.includes(PLAYER_ERASURE_MIGRATION)) {
    const record = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(PLAYER_ERASURE_CUTOVER_META)?.value;
    log(`players: migration ${PLAYER_ERASURE_MIGRATION} recorded — an account deletion keeps the retained record from here on (${record ? JSON.parse(record).imported : 0} retained record(s) imported from a backup)`);
  }
  if (Object.hasOwn(db, PLAYERS_RETAINED.name)) {
    const given = db[PLAYERS_RETAINED.name];
    if (!migrations.ran.includes(PLAYER_ERASURE_MIGRATION) && Array.isArray(given) && given.length) warn(`players: an in-memory playersRetained array with ${given.length} entr${given.length === 1 ? 'y' : 'ies'} was ignored; the players table is authoritative`);
    delete db[PLAYERS_RETAINED.name];
    sqlite.prepare('DELETE FROM collections WHERE name = ?').run(PLAYERS_RETAINED.name);
  }
  for (const name of AUDIT_COLLECTIONS) {
    if (Object.hasOwn(db, name)) {
      const given = db[name];
      if (!migrations.ran.includes(SAFETY_AUDIT_MIGRATION) && Array.isArray(given) && given.length) warn(`safety audit: an in-memory ${name} array with ${given.length} entr${given.length === 1 ? 'y' : 'ies'} was ignored; the ${AUDIT_SNAPSHOT_TABLES.find((t) => t.name === name).table} table is authoritative`);
      delete db[name];
      sqlite.prepare('DELETE FROM collections WHERE name = ?').run(name);
    }
    Object.defineProperty(db, name, { value: safetyAudit.views[name], writable: false, configurable: false, enumerable: true });
  }

  return {
    orgs,
    identity,
    players: identity.players,
    guardians: identity.guardians,
    users,
    sessions,
    mediaDeletions,
    codes,
    notifications,
    dispatches,
    outboxPush,
    outbox: outboxPush.outbox,
    pushLog: outboxPush.pushLog,
    pushTokens: outboxPush.pushTokens,
    channels,
    safetyAudit,
    recruitment,
    recruitmentCases,
    migrations,
    boot: { orgs: orgsBoot, identity: identityBoot, users: usersBoot, sessions: sessionsBoot, codes: codesBoot, notifications: notificationsBoot, dispatches: dispatchesBoot, outboxPush: outboxPushBoot, channels: channelsBoot, safetyAudit: safetyAuditBoot, recruitment: recruitmentBoot, recruitmentCases: recruitmentCasesBoot },
    /** `details: true` is accepted for the admin report; the report carries counts and states, never rows. */
    report: () => ({
      ...dataSchemaReport(sqlite, DATA_MIGRATIONS),
      domains: {
        orgs: { rows: orgs.count(), mode: 'live', transitional: 'facets_json (tactical, squad, lookingFor, federationCheck, agencySettings, verification, unknown fields)' },
        players: { rows: identity.players.count(), retained: identity.players.retainedCount(), mode: 'live', transitional: 'facets_json (unknown fields and shape metadata)', subrecords: { mode: 'live', tables: identity.players.subrecordRows(), trialReports: 'derived from trials' }, deletion: 'S4b-R (migration 0014): an account deletion keeps the row as a retained record — id, deleted_at, birth_date, country; placeholders and NULL elsewhere; owned rows and links removed — served by no account reader; retained records travel in backups as playersRetained' },
        guardians: { rows: identity.guardians.count(), mode: 'live', links: identity.report().links, transitional: 'facets_json (coGuardians, emailCode, unknown fields)' },
        users: { rows: users.count(), mode: 'live' },
        sessions: { rows: sessions.count(), mode: 'live', lifetimeMs: sessions.ttlMs },
        oneTimeCodes: { mode: 'live', rows: codes.counts(), outstanding: codes.outstanding(), lifetimesMs: { emailChallenge: codes.emailChallengeTtlMs, pairingCode: codes.pairingCodeTtlMs }, maxEmailAttempts: codes.maxEmailAttempts },
        notifications: { mode: 'live', rows: notifications.counts(), pendingWrites: notifications.pending(), pendingEffects: notifications.pendingEffects(), coalesceMs: notifications.coalesceMs, writeMode: 'staged: a standalone write lands in the next snapshot save with the blobs it announces; a write inside a unit of work lands in its commit; its push and live event run only once that save committed' },
        dispatches: { mode: 'live', rows: dispatches.count(), byStatus: dispatches.countsByStatus(), backlog: dispatches.backlogCount(), pendingWrites: dispatches.pending(), writeMode: 'staged: a sweep\'s rows, attempts and status changes land in the next snapshot save with the outbox row, the injection counter and the ops/webhook rows written alongside; an acknowledgment lands in its unit\'s commit', notificationReference: 'indexed, no foreign key, no cascade (orphans after an ordinary deletion are retained; retention is an open decision)' },
        outboxPush: { mode: 'live', rows: outboxPush.counts(), pendingWrites: outboxPush.pending(), writeMode: 'staged: a mailer record lands in the save its route would have carried the blob in; a delivery record in the sweep\'s save with the dispatch rows; a push record — written after the notification\'s save committed — in the later save the sender\'s nextId() already schedules; a token in the route\'s persist()', tokens: 'any JSON value the route accepted, stored losslessly as JSON text; no uniqueness constraint (primitives collapse by strict equality on the live value, objects never — the route\'s rule); a non-finite number (JSON 1e400) is kept live and persists as null, as before', destinations: 'a string in to_address, null, or any other JSON value in to_json (what a coercing route handed the mailer: an array), decoded on read' },
        channels: { mode: 'live', rows: channels.counts(), pendingWrites: channels.pending(), writeMode: 'staged: a thread lands in the acceptance route\'s save with the request\'s answer; a message in postMessage\'s save before the sender hears 201; a receipt in its route\'s save; a deletion in the account-deletion unit', references: 'request_id unique and, since migration 0015 (S8a-core), a real foreign key to recruitment_requests (RESTRICT) — the D-A conversion — still checked in code at open; guardian_id checked in code at open and on every snapshot\'s final state (no foreign key, by bounded choice); org_id a foreign key (RESTRICT); player_id no lifecycle clause — the deleted player\'s threads are deleted explicitly, as before (D-B); messages and attachments cascade with their thread' },
        recruitment: { mode: 'live', rows: recruitment.counts(), pendingWrites: recruitment.pending(), unresolvedPlayerReferences: unresolvedRecruitmentPlayers(sqlite), retainedPlayerReferences: retainedRecruitmentPlayers(sqlite), writeMode: 'staged: a record\'s in-place changes land in the next save\'s flush (the same save that carried its blob before: an invitation in its route\'s persistNow(), the answer, the thread and the trial in the respond route\'s save, a report, a schedule, an attendance row or a day change in its route\'s save); a new record through addRequest / addTrial; the deletion unit\'s tombstones in the unit\'s commit. Six phases per write (plan §D.7.5): requests with the back-reference parked, trials\' departures, releases and arrivals, the final trial_id, the channels, the prune, the final-state assertions', references: 'player_id (both tables) no foreign key, TOLERANT (Q7a): live, retained and historically missing ids resolve, are counted here and never refused, fabricated or deleted. case_id (both tables): since migration 0016 (S8b) a REAL foreign key to recruitment_cases (RESTRICT) — Q7b\'s conversion — still checked in code at every write and on every snapshot\'s final state. guardian_id and recipient_guardian_id no foreign key, STRICT in code (Q7c): checked at every write and on every snapshot\'s final state. trials.request_id NOT NULL UNIQUE → recruitment_requests (RESTRICT); recruitment_requests.trial_id → trials (SET NULL); org_id and user_id → orgs / org_users (RESTRICT); the child tables cascade with their owner except trial_reports and trial_history (RESTRICT, deleted explicitly first). The recruitment_requests_one_pending index is withdrawn (D2): the direct route keeps its REQUEST_PENDING rule, the open-day route its several pending invitations' },
        recruitmentCases: { mode: 'live', rows: recruitmentCases.counts(), pendingWrites: recruitmentCases.pending(), unresolvedPlayerReferences: unresolvedCasePlayers(sqlite), retainedPlayerReferences: retainedCasePlayers(sqlite), writeMode: 'staged: a record\'s in-place changes land in the next save\'s flush (the same save that carried its blob before: a room creation, a status move with its snapshot, a comment, a task, a decision draft, a formal decision, an evidence review, a budget scenario or a handoff in its route\'s persistNow(); an M12 case change in its route\'s save); a new record through addCase / addComment / addSnapshot / addDecision / addEvidenceState; the finalize route\'s transport-failure splice through removeDecision; the deletion unit\'s tombstones in the unit\'s commit. The write order of the readiness review §6 (P A R | the S8a phases | C D | the channels | F1 F2 F3 | G) through four save hooks placed around the recruitment and channels hooks', references: 'player_id (recruitment_cases, room_snapshots, room_decisions, case_transaction_handoffs) no foreign key, TOLERANT (Q8a, 23 October 2026): live, retained and historically missing ids resolve, are counted here and never refused, fabricated or deleted. org_id → orgs (RESTRICT) on every table that carries one; owner_user_id, room_lead_scout_user_id, decision_by_user_id, case_assignments.user_id and room_comments.author_user_id → org_users (RESTRICT). room_id (the four room tables) → recruitment_cases (RESTRICT): a retained room row names a case at the preflight with its table (CASE_STILL_REFERENCED), a supplied collection removes its rows before the case. recruitment_requests.case_id and trials.case_id → recruitment_cases (RESTRICT, rebuilt by 0016); case_request_links.request_id → recruitment_requests and case_trial_links.trial_id → trials (RESTRICT; released before the S8a phases and reinserted after them, never detached). case_history → recruitment_cases (RESTRICT, owned: removed explicitly before its owner); every other child cascades. The decision chain (supersedes / supersededById / supersession.of), client keys, vacancy, evidence, assessment, signing, transaction and agency ids are plain ids checked in code. The drafted recruitment_cases_one_open_room index is withdrawn: the routes keep their one-open-room rule' },
        safetyAudit: { mode: 'live', rows: safetyAudit.counts(), pendingWrites: safetyAudit.pending(), unresolvedPlayerReferences: unresolvedPlayerReferences(sqlite), retainedPlayerReferences: retainedPlayerReferences(sqlite), writeMode: 'staged: a block with its ledger row, a report with its suspension blocks, a note and a moderation hit land in the next save; a source change in its writer\'s save; an ops event in its caller\'s save; the IDV entry and the admin toggle land in their units\' commits', references: 'no foreign key on any of the eight tables. The five player references (blocks, reports, org_notes, ledger, source_changes) are tolerant historical references (Q4): an id that resolves to no player is counted here, never refused, never given a fabricated parent, never deleted; a count, not a claim about why it is absent. idv_queue.guardian_id is strict (Q4b): a write or import naming a missing guardian is refused and every snapshot that touches the queue or the identity pair is checked against the FINAL guardians table. A lifted block is deleted, as before (Q5). Organisation and staff references are historical pointers the routes never checked' },
      },
      identity: { initState: identity.initState(), uncommittedFacets: identity.report().uncommittedFacets },
      mediaDeletions: { queued: mediaDeletions.count(), conflicts: mediaDeletions.conflicts().length },
    }),
  };
}
