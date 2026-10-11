// TEST SUPPORT ONLY — synthetic fixtures and temporary-database helpers shared
// by scripts/testCoreIdentityMigration.mjs and scripts/testCoreIdentityRollback.mjs.
// Nothing here is reached by server boot. Every database is a throwaway file
// under the OS temp directory (or in memory); every record is invented.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { DATA_MIGRATIONS } from '../repositories/index.mjs';

/** The registered steps up to S3 (0001–0004): what an S3-shaped file has applied before migration 0005 runs. */
export const S3_MIGRATIONS = Object.freeze(DATA_MIGRATIONS.filter((m) => /^000[1-4]_/.test(m.id)));
/** The ids 0005 and later add on a cutover, in order. */
export const S4_MIGRATION_IDS = Object.freeze(DATA_MIGRATIONS.filter((m) => !S3_MIGRATIONS.includes(m)).map((m) => m.id));

export const DAY = 86_400_000;
export const TTL = 30 * DAY;
/** The migration instant every test evaluates age at (injectable: `migrate(s, { now })`). */
export const NOW = Date.UTC(2026, 9, 11, 12);
export const T0 = NOW - 400 * DAY;
export const tempDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `sb-${tag}-`));
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const clone = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------------ records (the shapes the application writes today)
export const adult = () => ({
  id: 'pl-adult', name: 'Adult Signup', dob: '2001-05-20', country: 'GB', city: 'Leeds', position: 'ST', foot: 'right', heightCm: 182, weightKg: 77,
  stats: null, academyPlus: false, badges: [], availability: 'not_seeking', contractStatus: 'unknown', identityVerified: false,
  attendance: [], timeline: [], media: [], trialReports: [], drills: [], guardianId: null, squadNumber: null, contractUntil: null,
  marketValueRange: null, agentName: null, createdAt: T0, password: 'scrypt$aa$bb', level: 'amateur', location: { lat: 53.8, lng: -1.5 },
  medical: { shared: false, records: [], conditionStatus: 'unknown' }, notificationPrefs: null, seasonHistory: [], firstTeamSeeker: false, programme: null,
});
export const child = (id, guardianId, dob) => ({
  id, name: `Child ${id}`, dob, country: 'GB', city: '', guardianId, position: null, foot: null, heightCm: null, weightKg: null,
  stats: null, academyPlus: false, badges: [], availability: 'not_seeking', contractStatus: 'unknown', identityVerified: false,
  attendance: [], timeline: [], media: [], trialReports: [], drills: [], squadNumber: null, contractUntil: null, marketValueRange: null,
  agentName: null, createdAt: T0 + DAY, password: null, level: 'amateur', location: null, medical: { shared: false, records: [], conditionStatus: 'unknown' },
  notificationPrefs: null, seasonHistory: [], firstTeamSeeker: false, programme: null,
});
/** A seeded adult with every S5 array, split composites with remainders and prototype-named own keys (built from JSON, as a snapshot arrives). */
export const seeded = () => JSON.parse(JSON.stringify({
  id: 'pl-seeded', name: 'Seeded Adult', dob: '2004-03-14', country: 'GB', city: 'Manchester', position: 'ST', foot: 'right', heightCm: 184, weightKg: 79,
  badges: ['Finisher'], attendance: [{ id: 'att-1', fixture: 'Cup Final', venue: 'Hough End', date: '2026-06-01', gps: { lat: 53.43, lng: -2.26 }, verified: true }],
  timeline: [{ year: '2019', event: 'Joined academy' }], media: [{ id: 'med-1', title: 'Highlights', kind: 'video', uploadedAt: '2026-05-01T10:00:00.000Z', url: null, views: 3, tags: { pace: 2 }, verifiedClip: null }],
  trialReports: [], medical: { shared: true, records: [{ id: 'md-1', type: 'injury', title: 'Hamstring', date: '2025-11-02', layoffWeeks: 3, cleared: true }], conditionStatus: 'fully_fit' },
  identityVerified: true, academyPlus: true, guardianId: null, squadNumber: 22, contractUntil: '2026-06-30', marketValueRange: '€250K – €450K', agentName: 'Team Elevate',
  availability: 'available_now', contractStatus: 'expiring_summer', drills: ['drill-sprint'], drillResults: [{ id: 'dr-1', drillId: 'drill-sprint', metric: 'time', unit: 's', value: 4.2, verified: false, ts: T0 }],
  activityLog: [T0], createdAt: null, password: null, level: 'semi_pro', location: { lat: 53.483, lng: -2.244 }, seasonHistory: [{ season: '2024/25', appearances: 27, goals: 14, assists: 4 }],
  stats: { appearances: 31, goals: 22, assists: 6, paceKmh: 34.1, passCompletionPct: 78, duelSuccessPct: 61 }, notificationPrefs: { quietStart: '21:00', quietEnd: '07:00', schoolHoursMute: null, timezone: 'Europe/London' },
  programme: { track: 'ST', startedAt: T0, completed: [{ sessionId: 's1', ts: T0 + DAY }] }, firstTeamSeeker: true, futureField: { nested: [1, 2] },
}).replace('"futureField"', '"constructor":"own-constructor","toString":"own-toString","__proto__":{"polluted":true},"futureField"'));
export const gPrimary = () => ({
  id: 'gd-primary', name: 'Primary Parent', email: 'primary@example.test', password: null, emailVerified: true, emailCode: null, idVerified: true, idvReference: 'idv-1',
  disclaimerAccepted: true, childIds: ['pl-child1', 'pl-child2'], coGuardians: [{ id: 'gd-co', name: 'Co Parent', email: 'co@example.test' }],
  notificationPrefs: { quietStart: '20:00', quietEnd: '06:30', schoolHoursMute: true, timezone: 'Europe/London' }, createdAt: T0,
});
export const gCo = () => ({ id: 'gd-co', name: 'Co Parent', email: 'co@example.test', idVerified: false, disclaimerAccepted: false, childIds: ['pl-child1', 'pl-child2'], coGuardianOf: 'gd-primary' });
/** A guardian who signed up and has not verified yet: the outstanding e-mail code is plain, as the server stores it today. */
export const gSignup = () => ({ id: 'gd-signup', name: 'Signup Parent', email: 'signup@example.test', password: 'scrypt$cc$dd', emailVerified: false, emailCode: 'K7Q2ZP', idVerified: false, disclaimerAccepted: false, childIds: [] });
/** An adult who is still linked to a guardian (a counted finding, imported unchanged). */
export const linkedAdult = () => ({ ...child('pl-grown', 'gd-primary', '2007-01-01'), name: 'Grown Up' });
export const FIXTURE = () => ({
  players: [adult(), child('pl-child1', 'gd-primary', '2014-03-03'), seeded(), child('pl-child2', 'gd-primary', '2016-08-08'), linkedAdult()],
  guardians: [{ ...gPrimary(), childIds: ['pl-child1', 'pl-child2', 'pl-grown'] }, gCo(), gSignup()],
});
export const ORGS = () => [{ id: 'org-pro', name: 'Eastport FC', type: 'club', level: 'pro', plan: 'Pro', country: 'GB', squad: [{ id: 'sq-1', name: 'Kid', position: 'ST', playerId: null, source: 'manual', addedAt: 5 }] }];
export const USERS = () => [{ id: 'usr-1', orgId: 'org-pro', name: 'Maria', role: 'Head of Recruitment', createdAt: 1 }];
/** Legacy (plain-token) sessions the way a pre-S2 blob held them; migration 0003 hashes them. One per kind. */
export const SESSIONS = (now = NOW) => [
  { token: 'legacy-guardian-token-0000000000000000000000000', sid: 'sid-guardian', kind: 'guardian', refId: 'gd-primary', createdAt: now - DAY },
  { token: 'legacy-player-token-000000000000000000000000000', sid: 'sid-player', kind: 'player', refId: 'pl-adult', createdAt: now - DAY },
  { token: 'legacy-staff-token-0000000000000000000000000000', sid: 'sid-staff', kind: 'org', refId: 'org-pro', userId: 'usr-1', createdAt: now - DAY },
];
export const EXTRA = () => ({ requests: [{ id: 'req-1', playerId: 'pl-adult', status: 'pending', history: [] }], ledger: [] });

// ------------------------------------------------------------------ databases
const BASE_DDL = 'CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);';

/**
 * An S3-shaped database file: a saved snapshot (blobs for every collection,
 * players and guardians included), migrations 0001–0004 applied by the real
 * runner (staff, sessions and organisations live; the identity tables the S1
 * shadow). `omit: ['players']` leaves that blob out; `rawBlobs` writes a
 * collection's text verbatim (not-JSON, an object, …); `shadowRows` fills the
 * shadow tables with stale rows the way a validation run would have.
 */
export function s3File(dir, { players = FIXTURE().players, guardians = FIXTURE().guardians, users = USERS(), sessions = SESSIONS(), orgs = ORGS(), extra = EXTRA(), omit = [], rawBlobs = {}, shadowRows = null, saveSeq = 3 } = {}) {
  const s = new DatabaseSync(path.join(dir, 'scoutbox.db'));
  s.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  s.exec(BASE_DDL);
  const put = s.prepare('INSERT INTO collections (name, value) VALUES (?, ?)');
  for (const [name, value] of Object.entries({ users, sessions, orgs, players, guardians, ...extra })) if (!omit.includes(name)) put.run(name, JSON.stringify(value));
  for (const [name, text] of Object.entries(rawBlobs)) s.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, text);
  s.prepare("INSERT INTO meta (key, value) VALUES ('idCounter', '1000'), ('savedAt', ?), ('saveSeq', ?)").run(String(T0), String(saveSeq));
  runDataMigrations(s, S3_MIGRATIONS, { now: T0, context: { sessionTtlMs: TTL } });
  if (shadowRows) {
    for (const g of shadowRows.guardians ?? []) s.prepare('INSERT INTO guardians (id, name, email) VALUES (?, ?, ?)').run(g.id, g.name, g.email);
    for (const p of shadowRows.players ?? []) s.prepare('INSERT INTO players (id, name, birth_date, country, guardian_id) VALUES (?, ?, ?, ?, ?)').run(p.id, p.name, p.dob, p.country, p.guardianId ?? null);
    for (const l of shadowRows.links ?? []) s.prepare('INSERT INTO guardian_children (guardian_id, player_id, role) VALUES (?, ?, ?)').run(l.guardianId, l.playerId, l.role ?? 'primary');
  }
  s.close();
}

/** A genuinely new database: the store's tables and migrations 0001–0004, nothing ever saved. */
export function freshFile(dir) {
  const s = new DatabaseSync(path.join(dir, 'scoutbox.db'));
  s.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  s.exec(BASE_DDL);
  runDataMigrations(s, S3_MIGRATIONS, { now: T0, context: { sessionTtlMs: TTL } });
  s.close();
}

export const openRaw = (dir) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db')); s.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;'); return s; };
/** Run the REGISTERED migrations through the real runner: on an S3-shaped file that is 0005 (the cutover) and 0006 (the media-deletion queue). */
export const migrate = (sqlite, { now = NOW } = {}) => runDataMigrations(sqlite, DATA_MIGRATIONS, { now, context: { sessionTtlMs: TTL } });
export const applied = (sqlite) => sqlite.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id);
export const tableCols = (sqlite, t) => sqlite.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
export const isLive = (sqlite, t) => tableCols(sqlite, t).includes('facets_json');
export const blob = (sqlite, name) => { const r = sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name); return r ? JSON.parse(r.value) : undefined; };
export const blobText = (sqlite, name) => sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name)?.value;
export const meta = (sqlite, key) => sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
export const sessionRows = (sqlite) => sqlite.prepare('SELECT token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at FROM sessions ORDER BY sid').all().map((r) => ({ ...r }));
export const links = (sqlite) => sqlite.prepare('SELECT guardian_id, player_id, role FROM guardian_children ORDER BY rowid').all().map((l) => ({ guardian_id: l.guardian_id, player_id: l.player_id, role: l.role }));

/** The whole logical content of a database: every table's rows in rowid order (meta/data_migrations included), as one canonical JSON string. */
export function dump(sqlite, { except = [] } = {}) {
  const out = {};
  for (const t of sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name)) {
    if (except.includes(t)) continue;
    out[t] = sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }));
  }
  return JSON.stringify(out);
}
/** The identity tables' content keyed and ordered by id (the way a round trip must agree, whatever the rowids). */
export function identityDump(sqlite) {
  const by = (sql, key) => sqlite.prepare(sql).all().map((r) => ({ ...r })).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return JSON.stringify({
    players: by('SELECT * FROM players', (r) => r.id),
    guardians: by('SELECT * FROM guardians', (r) => r.id),
    links: by('SELECT guardian_id, player_id, role FROM guardian_children', (r) => `${r.guardian_id}/${r.player_id}`),
  });
}

/**
 * Digest of the files a data directory holds: the main file's sha256 plus the
 * presence and size of the WAL side files. Taken WITHOUT checkpointing, so it
 * says exactly what is on disk; a tool that opened the source read-only must
 * leave the main file's digest unchanged and must not have checkpointed the WAL.
 */
export function filesDigest(dir) {
  const out = {};
  for (const name of ['scoutbox.db', 'scoutbox.db-wal', 'scoutbox.db-shm']) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) { out[name] = 'absent'; continue; }
    const data = fs.readFileSync(f);
    out[name] = `${data.length} bytes, sha256 ${sha256(data)}`;
  }
  return out;
}

// ------------------------------------------------------------------ failure injection (the failure must really happen: every probe counts)
/** Make `exec` throw once for the first statement `predicate` accepts. */
export function failExecOnce(sqlite, predicate, message) {
  const exec = sqlite.exec.bind(sqlite);
  const probe = { fired: 0, restore: () => { sqlite.exec = exec; } };
  sqlite.exec = (sql) => { if (!probe.fired && predicate(sql)) { probe.fired += 1; throw new Error(message); } return exec(sql); };
  return probe;
}
/** Make the Nth `run` of every statement whose SQL `sqlPredicate` accepts throw (counted across statements). */
export function failRunAt(sqlite, sqlPredicate, nth, message) {
  const prepare = sqlite.prepare.bind(sqlite);
  const probe = { fired: 0, runs: 0, restore: () => { sqlite.prepare = prepare; } };
  sqlite.prepare = (sql) => {
    const st = prepare(sql);
    if (sqlPredicate(sql)) {
      const run = st.run.bind(st);
      Object.defineProperty(st, 'run', { value: (...args) => { probe.runs += 1; if (probe.runs === nth) { probe.fired += 1; throw new Error(message); } return run(...args); }, configurable: true, writable: true });
    }
    return st;
  };
  return probe;
}
