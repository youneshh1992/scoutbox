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
import { createIdentityRepositories, IDENTITY_SNAPSHOT, IDENTITY_COLLECTIONS } from './identity.mjs';
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
import { trialReportsFor } from './playerSubrecords.mjs';
import { createOneTimeCodesRepository, EMAIL_CHALLENGES_TABLE, PAIRING_CODES_TABLE, ONE_TIME_CODES_MIGRATION, ONE_TIME_CODES_CUTOVER_META, assertPairingCodesConsistent } from './oneTimeCodes.mjs';
import { createNotificationsRepository, NOTIFICATIONS_TABLE, NOTIFICATION_PREFS_TABLE, NOTIFICATIONS_MIGRATION, NOTIFICATIONS_CUTOVER_META } from './notifications.mjs';

export const DATA_MIGRATIONS = Object.freeze([m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009]);

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
 * (repositories/notifications.mjs).
 */
export const TABLE_BACKED = Object.freeze(['orgs', ...IDENTITY_COLLECTIONS, 'users', 'sessions', MEDIA_DELETIONS_TABLE.name, EMAIL_CHALLENGES_TABLE.name, PAIRING_CODES_TABLE.name, NOTIFICATIONS_TABLE.name, NOTIFICATION_PREFS_TABLE.name]);
/** The one-time-code tables, dispatched after the organisations are pruned (the challenge references its organisation) and after the identity pair (the final-state check reads the players). */
const CODE_TABLES = Object.freeze([EMAIL_CHALLENGES_TABLE, PAIRING_CODES_TABLE]);
/** The notification tables: no reference to any other table (polymorphic audiences), dispatched last. */
const NOTIFICATION_TABLE_DISPATCH = Object.freeze([NOTIFICATIONS_TABLE, NOTIFICATION_PREFS_TABLE]);

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
  const queue = MEDIA_DELETIONS_TABLE.read(sqlite);
  if (queue) out[MEDIA_DELETIONS_TABLE.name] = queue;
  for (const table of [...CODE_TABLES, ...NOTIFICATION_TABLE_DISPATCH]) {
    const rows = table.read(sqlite);
    if (rows) out[table.name] = rows;
  }
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
  for (const name of ['users', 'sessions']) if (present.includes(name) && single(name).replace(sqlite, db[name])) written.push(name);
  // The media-removal queue: validated entry by entry and rewritten (false before migration 0006, so the caller writes the blob the migration imports).
  if (present.includes(MEDIA_DELETIONS_TABLE.name) && MEDIA_DELETIONS_TABLE.replace(sqlite, db[MEDIA_DELETIONS_TABLE.name])) written.push(MEDIA_DELETIONS_TABLE.name);
  // Rows the snapshot no longer lists go last, children before parents, so a
  // parent that is still referenced makes the foreign key refuse the save
  // instead of the row disappearing under its dependants. (The identity pair
  // prunes inside its own replace, players before guardians.)
  for (const name of ['sessions', 'users', 'orgs']) {
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
  // S7a: the notification tables reference nothing (polymorphic audiences, no
  // cascade with a person), so a snapshot that carries one collection and
  // omits the other leaves the omitted table alone; each entry is validated
  // (never coerced) and one refusal rolls the whole save back.
  for (const table of NOTIFICATION_TABLE_DISPATCH) if (present.includes(table.name) && table.replace(sqlite, db[table.name])) written.push(table.name);
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
  // `trialReports` is derived from the trials collection, read live (`db.trials`
  // is a blob collection the modules replace and mutate; it is read at access).
  const identity = createIdentityRepositories({ sqlite, log, warn, unit: store.unit, now, trialReports: (playerId) => trialReportsFor(db.trials, playerId) });
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
  const notifications = createNotificationsRepository({ sqlite, log, warn, now, nextId, unit: store.unit, staged: true });
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
    migrations,
    boot: { orgs: orgsBoot, identity: identityBoot, users: usersBoot, sessions: sessionsBoot, codes: codesBoot, notifications: notificationsBoot },
    /** `details: true` is accepted for the admin report; the report carries counts and states, never rows. */
    report: () => ({
      ...dataSchemaReport(sqlite, DATA_MIGRATIONS),
      domains: {
        orgs: { rows: orgs.count(), mode: 'live', transitional: 'facets_json (tactical, squad, lookingFor, federationCheck, agencySettings, verification, unknown fields)' },
        players: { rows: identity.players.count(), mode: 'live', transitional: 'facets_json (unknown fields and shape metadata)', subrecords: { mode: 'live', tables: identity.players.subrecordRows(), trialReports: 'derived from trials' } },
        guardians: { rows: identity.guardians.count(), mode: 'live', links: identity.report().links, transitional: 'facets_json (coGuardians, emailCode, unknown fields)' },
        users: { rows: users.count(), mode: 'live' },
        sessions: { rows: sessions.count(), mode: 'live', lifetimeMs: sessions.ttlMs },
        oneTimeCodes: { mode: 'live', rows: codes.counts(), outstanding: codes.outstanding(), lifetimesMs: { emailChallenge: codes.emailChallengeTtlMs, pairingCode: codes.pairingCodeTtlMs }, maxEmailAttempts: codes.maxEmailAttempts },
        notifications: { mode: 'live', rows: notifications.counts(), pendingWrites: notifications.pending(), coalesceMs: notifications.coalesceMs, writeMode: 'staged: a standalone write lands in the next snapshot save with the blobs it announces; a write inside a unit of work lands in its commit' },
      },
      identity: { initState: identity.initState(), uncommittedFacets: identity.report().uncommittedFacets },
      mediaDeletions: { queued: mediaDeletions.count(), conflicts: mediaDeletions.conflicts().length },
    }),
  };
}
