/**
 * Organisation staff (`org_users`, `org_user_recovery_codes`).
 *
 * Record: { id, orgId, name, role, email, ssoSubject, createdAt, removedAt, removedById, provenance,
 *   mfa: null | { enabledAt },                       enabledAt null: set up but not yet confirmed
 *   deliveryPrefs: { quietStart, quietEnd, channels: { email } } }
 * The TOTP secret and the recovery-code hashes are never on a record: `mfaSecretOf` gives the secret to the code
 * checks and `useRecoveryCode` spends a code. Responses are allowlists, never the record.
 *
 * Staff are removed softly (`removed_at`), never deleted by a route. Staff sign in by name, so a name is unique in its
 * organisation (case-insensitive, removed staff included; the repository writes `name_key`); an e-mail is unique among
 * an organisation's current staff, an SSO subject within an organisation. `org_id` and `removed_by_id` are RESTRICT
 * keys; `(id, org_id)` is unique so an org session can name its staff member and organisation together.
 *
 * Refusals carry a code and name the id and the field, never a value.
 */
import { transaction, migrationApplied } from './database.mjs';
import { deepFreeze } from './scoutingEvidence.mjs';

export const USERS_MIGRATION = '0001_org_users';
export const STAFF_LIMITS = Object.freeze({ id: 80, name: 120, role: 60, email: 254, ssoSubject: 255, secret: 128 });
export const STAFF_PROVENANCES = Object.freeze(['org_password_bootstrap']);
const L = STAFF_LIMITS;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HHMM_CHECK = (c) => `CHECK (${c} IS NULL OR ${c} GLOB '[01][0-9]:[0-5][0-9]' OR ${c} GLOB '2[0-3]:[0-5][0-9]')`;

export const ORG_USERS_DDL = `
CREATE TABLE org_users (
  id             TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND ${L.id}),
  org_id         TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${L.name}),
  name_key       TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND ${L.role}),
  email          TEXT CHECK (email IS NULL OR length(email) BETWEEN 3 AND ${L.email}),
  sso_subject    TEXT CHECK (sso_subject IS NULL OR length(sso_subject) BETWEEN 1 AND ${L.ssoSubject}),
  created_at     INTEGER NOT NULL,
  removed_at     INTEGER,
  removed_by_id  TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  provenance     TEXT CHECK (provenance IS NULL OR provenance IN (${STAFF_PROVENANCES.map((p) => `'${p}'`).join(', ')})),
  mfa_secret     TEXT CHECK (mfa_secret IS NULL OR length(mfa_secret) BETWEEN 16 AND ${L.secret}),
  mfa_enabled_at INTEGER,
  quiet_start    TEXT ${HHMM_CHECK('quiet_start')},
  quiet_end      TEXT ${HHMM_CHECK('quiet_end')},
  email_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (email_enabled IN (0, 1)),
  UNIQUE (id, org_id),
  CHECK (removed_by_id IS NULL OR removed_at IS NOT NULL),
  CHECK (mfa_enabled_at IS NULL OR mfa_secret IS NOT NULL)
) STRICT;
CREATE INDEX org_users_org ON org_users (org_id);
CREATE UNIQUE INDEX org_users_org_name ON org_users (org_id, name_key);
CREATE UNIQUE INDEX org_users_org_email ON org_users (org_id, lower(email)) WHERE email IS NOT NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX org_users_sso ON org_users (org_id, sso_subject) WHERE sso_subject IS NOT NULL;
CREATE INDEX org_users_removed_by ON org_users (removed_by_id) WHERE removed_by_id IS NOT NULL;
CREATE TABLE org_user_recovery_codes (
  org_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL CHECK (length(code_hash) = 64),
  PRIMARY KEY (org_user_id, code_hash)
) STRICT;`;

export const usersLive = (sqlite) => migrationApplied(sqlite, USERS_MIGRATION);
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isClock = (v) => Number.isSafeInteger(v) && v >= 0;
const isHash = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
const textOk = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max && v === v.trim();
/** The key a name is unique by in its organisation (and looked up by at sign-in). */
export const staffNameKey = (name) => String(name ?? '').trim().toLowerCase();

const DEFAULT_PREFS = Object.freeze({ quietStart: null, quietEnd: null, channels: Object.freeze({ email: true }) });
const RECORD_KEYS = Object.freeze(['id', 'orgId', 'name', 'role', 'email', 'ssoSubject', 'createdAt', 'removedAt', 'removedById', 'provenance', 'mfa', 'deliveryPrefs']);
/** The fields an update's draft may change (the rest never change, or change through their own operation). */
const EDITABLE = Object.freeze(['name', 'role', 'email', 'ssoSubject', 'removedAt', 'removedById', 'deliveryPrefs']);

/** Why a delivery-preference value cannot be stored, or null. */
function prefsProblem(p) {
  if (!isPlainObject(p)) return `deliveryPrefs must be { quietStart, quietEnd, channels: { email } } (got ${describe(p)})`;
  const unknown = Object.keys(p).filter((k) => !['quietStart', 'quietEnd', 'channels'].includes(k));
  if (unknown.length) return `deliveryPrefs carries unknown field(s) ${unknown.join(', ')}`;
  for (const k of ['quietStart', 'quietEnd']) if (p[k] != null && !(typeof p[k] === 'string' && HHMM.test(p[k]))) return `deliveryPrefs.${k} is a time written HH:MM or null`;
  const ch = p.channels ?? { email: true };
  if (!isPlainObject(ch) || Object.keys(ch).some((k) => k !== 'email')) return 'deliveryPrefs.channels must be { email }';
  if (ch.email !== undefined && typeof ch.email !== 'boolean') return 'deliveryPrefs.channels.email must be a boolean';
  return null;
}
const prefsOf = (p) => (p == null ? DEFAULT_PREFS : { quietStart: p.quietStart ?? null, quietEnd: p.quietEnd ?? null, channels: { email: p.channels?.email ?? true } });

/** The problems with a record's scalar fields (a staff record, or a draft after an update), by field name. */
function recordProblems(r) {
  const out = [];
  if (!textOk(r.id, L.id)) out.push(`id must be text of 1 to ${L.id} characters`);
  if (typeof r.orgId !== 'string' || !r.orgId) out.push('orgId must name an organisation');
  if (!textOk(r.name, L.name)) out.push(`name must be text of 1 to ${L.name} characters without surrounding spaces`);
  if (!textOk(r.role, L.role)) out.push(`role must be text of 1 to ${L.role} characters without surrounding spaces`);
  if (r.email !== null && !textOk(r.email, L.email, 3)) out.push(`email must be text of 3 to ${L.email} characters or null`);
  if (r.ssoSubject !== null && !textOk(r.ssoSubject, L.ssoSubject)) out.push(`ssoSubject must be text of 1 to ${L.ssoSubject} characters or null`);
  if (!isClock(r.createdAt)) out.push('createdAt must be an integer timestamp');
  if (r.removedAt !== null && !isClock(r.removedAt)) out.push('removedAt must be an integer timestamp or null');
  if (r.removedById !== null && (typeof r.removedById !== 'string' || !r.removedById)) out.push('removedById must name a staff member or null');
  if (r.removedById !== null && r.removedAt === null) out.push('removedById is set only on a removed account');
  if (r.provenance !== null && !STAFF_PROVENANCES.includes(r.provenance)) out.push(`provenance must be one of ${STAFF_PROVENANCES.join(', ')} or null`);
  const p = prefsProblem(r.deliveryPrefs); if (p) out.push(p);
  return out;
}

const COLS = 'id, org_id, name, name_key, role, email, sso_subject, created_at, removed_at, removed_by_id, provenance, mfa_secret, mfa_enabled_at, quiet_start, quiet_end, email_enabled';
const SELECT = `SELECT ${COLS} FROM org_users`;
const INSERT = `INSERT INTO org_users (${COLS}) VALUES (${COLS.split(', ').map((c) => `@${c}`).join(', ')})`;
const params = (r, { secret = null, enabledAt = null } = {}) => ({
  id: r.id, org_id: r.orgId, name: r.name, name_key: staffNameKey(r.name), role: r.role, email: r.email, sso_subject: r.ssoSubject,
  created_at: r.createdAt, removed_at: r.removedAt, removed_by_id: r.removedById, provenance: r.provenance,
  mfa_secret: secret, mfa_enabled_at: enabledAt,
  quiet_start: r.deliveryPrefs.quietStart, quiet_end: r.deliveryPrefs.quietEnd, email_enabled: r.deliveryPrefs.channels.email ? 1 : 0,
});
/** The record for a table row (plain; the repository freezes what it hands out). */
function fromDb(d) {
  return {
    id: d.id, orgId: d.org_id, name: d.name, role: d.role, email: d.email, ssoSubject: d.sso_subject, createdAt: d.created_at,
    removedAt: d.removed_at, removedById: d.removed_by_id, provenance: d.provenance,
    mfa: d.mfa_secret === null ? null : { enabledAt: d.mfa_enabled_at },
    deliveryPrefs: { quietStart: d.quiet_start, quietEnd: d.quiet_end, channels: { email: d.email_enabled === 1 } },
  };
}

/** The uniqueness rules, named before the engine would refuse them (`except`: the row being updated). */
function clashOf(q, r) {
  if (q('SELECT 1 FROM org_users WHERE org_id = ? AND name_key = ? AND id <> ?').get(r.orgId, staffNameKey(r.name), r.id)) {
    return refusal('STAFF_NAME_TAKEN', `org_users ${r.id}: another staff account of organisation ${r.orgId} has this name`, { field: 'name' });
  }
  if (r.email !== null && r.removedAt === null && q('SELECT 1 FROM org_users WHERE org_id = ? AND lower(email) = lower(?) AND removed_at IS NULL AND id <> ?').get(r.orgId, r.email, r.id)) {
    return refusal('STAFF_EMAIL_TAKEN', `org_users ${r.id}: another current staff member of organisation ${r.orgId} has this e-mail`, { field: 'email' });
  }
  if (r.ssoSubject !== null && q('SELECT 1 FROM org_users WHERE org_id = ? AND sso_subject = ? AND id <> ?').get(r.orgId, r.ssoSubject, r.id)) {
    return refusal('STAFF_SSO_TAKEN', `org_users ${r.id}: another staff account of organisation ${r.orgId} is linked to this sign-in subject`, { field: 'ssoSubject' });
  }
  return null;
}


function readSnapshot(sqlite) {
  const codes = new Map();
  for (const c of sqlite.prepare('SELECT org_user_id, code_hash FROM org_user_recovery_codes ORDER BY rowid').all()) {
    if (!codes.has(c.org_user_id)) codes.set(c.org_user_id, []);
    codes.get(c.org_user_id).push(c.code_hash);
  }
  return sqlite.prepare(`${SELECT} ORDER BY rowid`).all().map((d) => ({
    ...fromDb(d),
    mfa: d.mfa_secret === null ? null : { secretB32: d.mfa_secret, enabledAt: d.mfa_enabled_at, recoveryHashes: codes.get(d.id) ?? [] },
  }));
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const USERS_TABLE = {
  name: 'users',
  read(sqlite) { return usersLive(sqlite) ? readSnapshot(sqlite) : null; },
};

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'update', 'startMfa', 'enableMfa', 'disableMfa', 'useRecoveryCode']);

/** `createUsersRepository({ sqlite, nextId, unit, now, log })`: the staff writes and queries, plus `reads` (the queries alone). */
export function createUsersRepository({ sqlite, nextId, unit = null, now = Date.now, log = () => {} }) {
  if (!sqlite) throw new TypeError('the staff repository needs a SQLite connection (node:sqlite); staff have no in-memory fallback');
  if (typeof nextId !== 'function') throw new TypeError('the staff repository needs nextId');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const dec = (rows) => rows.map((d) => deepFreeze(fromDb(d)));
  const byId = (id) => (typeof id === 'string' && id ? dec(q(`${SELECT} WHERE id = ?`).all(id))[0] ?? null : null);
  const invalid = (id, problems) => refusal('STAFF_RECORD_INVALID', `org_users ${id}: ${problems.join('; ')}`, { problems });
  const mustExist = (id) => { const r = q('SELECT id, mfa_secret, mfa_enabled_at FROM org_users WHERE id = ?').get(id); if (!r) throw refusal('STAFF_NOT_FOUND', `org_users ${id} does not exist`); return r; };
  const checkRemover = (r) => {
    if (r.removedById === null) return;
    const by = byId(r.removedById);
    if (!by || by.orgId !== r.orgId) throw invalid(r.id, ['removedById must name a staff member of the same organisation']);
  };
  let updating = null;

  const repo = {
    // ---------------------------------------------------------- writes
    /** Create a staff account (the id is minted here). Refuses junk by field and a name, e-mail or SSO subject already taken. Returns the stored record. */
    create: ({ id = null, orgId, name, role, email = null, ssoSubject = null, provenance = null, deliveryPrefs = null, createdAt = now() } = {}) => operation(() => {
      const r = { id: id ?? nextId('usr'), orgId, name, role, email, ssoSubject, createdAt, removedAt: null, removedById: null, provenance, deliveryPrefs: deliveryPrefs ?? DEFAULT_PREFS };
      const problems = recordProblems(r);
      if (problems.length) throw invalid(r.id, problems);
      if (!q('SELECT 1 FROM orgs WHERE id = ?').get(orgId)) throw refusal('STAFF_ORG_MISSING', `org_users ${r.id}: organisation ${orgId} does not exist`);
      const clash = clashOf(q, r); if (clash) throw clash;
      q(INSERT).run(params({ ...r, deliveryPrefs: prefsOf(r.deliveryPrefs) }));
      return byId(r.id);
    }),
    /**
     * `update(id, (draft) => …)`: the draft is a plain copy of the record; the change is typed whole and written at
     * once. Only name, role, email, ssoSubject, removedAt, removedById and deliveryPrefs change here (MFA has its
     * own operations); any other change, or an unknown field, is refused. Returns the stored record.
     */
    update: (id, edit) => operation(() => {
      if (typeof edit !== 'function') throw new TypeError('users.update(id, (draft) => …) takes a function');
      if (updating === id) throw refusal('STAFF_UPDATE_REENTRANT', `org_users ${id} is already being updated`);
      const before = byId(id);
      if (!before) throw refusal('STAFF_NOT_FOUND', `org_users ${id} does not exist`);
      const draft = JSON.parse(JSON.stringify(before));
      updating = id;
      try { edit(draft); } finally { updating = null; }
      const unknown = Object.keys(draft).filter((k) => !RECORD_KEYS.includes(k));
      if (unknown.length) throw invalid(id, [`unknown field(s) ${unknown.join(', ')}`]);
      for (const k of RECORD_KEYS) {
        if (EDITABLE.includes(k)) continue;
        if (JSON.stringify(draft[k]) !== JSON.stringify(before[k])) throw invalid(id, [`${k} does not change through update`]);
      }
      const problems = recordProblems(draft);
      if (problems.length) throw invalid(id, problems);
      checkRemover(draft);
      const clash = clashOf(q, draft); if (clash) throw clash;
      const m = mustExist(id);
      q(`UPDATE org_users SET ${COLS.split(', ').filter((c) => c !== 'id').map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`)
        .run(params({ ...draft, deliveryPrefs: prefsOf(draft.deliveryPrefs) }, { secret: m.mfa_secret, enabledAt: m.mfa_enabled_at }));
      return byId(id);
    }),
    /** Begin MFA set-up with a new secret (replacing an unconfirmed one); refused once MFA is enabled. Returns the stored record. */
    startMfa: (id, secretB32) => operation(() => {
      const m = mustExist(id);
      if (m.mfa_enabled_at !== null) throw refusal('STAFF_MFA_ENABLED', `org_users ${id}: MFA is already enabled`);
      if (!textOk(secretB32, L.secret, 16)) throw invalid(id, [`the MFA secret must be text of 16 to ${L.secret} characters`]);
      q('UPDATE org_users SET mfa_secret = ?, mfa_enabled_at = NULL WHERE id = ?').run(secretB32, id);
      q('DELETE FROM org_user_recovery_codes WHERE org_user_id = ?').run(id);
      return byId(id);
    }),
    /** Confirm MFA: enabled from `at`, with these recovery-code hashes (each usable once). Returns the stored record. */
    enableMfa: (id, { at = now(), recoveryHashes = [] } = {}) => operation(() => {
      const m = mustExist(id);
      if (m.mfa_secret === null || m.mfa_enabled_at !== null) throw refusal('STAFF_MFA_NOT_PENDING', `org_users ${id}: MFA is not awaiting confirmation`);
      if (!isClock(at)) throw invalid(id, ['at must be an integer timestamp']);
      if (!Array.isArray(recoveryHashes) || !recoveryHashes.every(isHash) || new Set(recoveryHashes).size !== recoveryHashes.length) throw invalid(id, ['recovery codes are distinct sha256 hex hashes']);
      q('UPDATE org_users SET mfa_enabled_at = ? WHERE id = ?').run(at, id);
      const add = q('INSERT INTO org_user_recovery_codes (org_user_id, code_hash) VALUES (?, ?)');
      for (const h of recoveryHashes) add.run(id, h);
      return byId(id);
    }),
    /** Turn MFA off: the secret and the unused recovery codes go. Returns the stored record. */
    disableMfa: (id) => operation(() => {
      mustExist(id);
      q('DELETE FROM org_user_recovery_codes WHERE org_user_id = ?').run(id);
      q('UPDATE org_users SET mfa_secret = NULL, mfa_enabled_at = NULL WHERE id = ?').run(id);
      return byId(id);
    }),
    /** Spend one recovery code (by its hash). True when it existed and is now gone: a code works exactly once. */
    useRecoveryCode: (id, codeHash) => operation(() => (isHash(codeHash) ? q('DELETE FROM org_user_recovery_codes WHERE org_user_id = ? AND code_hash = ?').run(id, codeHash).changes === 1 : false)),

    // ---------------------------------------------------------- reads
    byId,
    /** The account with this name in the organisation (case-insensitive; removed accounts included), or null. */
    byOrgAndName: (orgId, name) => { const key = staffNameKey(name); return key ? dec(q(`${SELECT} WHERE org_id = ? AND name_key = ?`).all(orgId, key))[0] ?? null : null; },
    /** The organisation's staff in creation order; `active: true` leaves out removed accounts. */
    forOrg: (orgId, { active = false } = {}) => dec(q(`${SELECT} WHERE org_id = ?${active ? ' AND removed_at IS NULL' : ''} ORDER BY rowid`).all(orgId)),
    /** The organisation's first current staff member (creation order), or null. */
    firstActive: (orgId) => dec(q(`${SELECT} WHERE org_id = ? AND removed_at IS NULL ORDER BY rowid LIMIT 1`).all(orgId))[0] ?? null,
    /** The current staff member with this e-mail (case-insensitive), or null. */
    activeByEmail: (orgId, email) => (typeof email === 'string' && email ? dec(q(`${SELECT} WHERE org_id = ? AND lower(email) = lower(?) AND removed_at IS NULL`).all(orgId, email))[0] ?? null : null),
    /** The account linked to this SSO subject in the organisation, or null. */
    bySsoSubject: (orgId, subject) => (typeof subject === 'string' && subject ? dec(q(`${SELECT} WHERE org_id = ? AND sso_subject = ?`).all(orgId, subject))[0] ?? null : null),
    /** The TOTP secret for the code checks (never on a record), or null. */
    mfaSecretOf: (id) => q('SELECT mfa_secret FROM org_users WHERE id = ?').get(id)?.mfa_secret ?? null,
    /** How many unused recovery codes a staff member has. */
    recoveryCodesLeft: (id) => q('SELECT COUNT(*) AS n FROM org_user_recovery_codes WHERE org_user_id = ?').get(id).n,
    count: () => q('SELECT COUNT(*) AS n FROM org_users').get().n,
    attach() {
      if (!usersLive(sqlite)) throw new Error(`the staff repository needs ${USERS_MIGRATION} recorded`);
      const rows = repo.count();
      log(`org_users: ${rows} staff account(s) in the table`);
      return { engine: 'sqlite', rows };
    },
  };
  repo.reads = Object.freeze(Object.fromEntries(Object.entries(repo).filter(([k, v]) => typeof v === 'function' && !WRITES.has(k) && k !== 'attach')));
  return repo;
}
