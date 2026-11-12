/**
 * Organisations: the `orgs` table.
 *
 * Record (the keys every reader sees, all always present):
 *   { id, name, type, level, plan, country,
 *     location: null | { lat, lng, city },              city null when the club gave none
 *     federationRef: null | { federation, registrationId },
 *     trustedPartner, verified, verifiedDomain, safeguardingContractSigned, suspended,
 *     emailDomain, emailDomainVerified, mfaRequiredForLeads, verificationRevokedAt, createdAt }
 * The password hash is never on a record: `passwordHashOf` gives it to the sign-in check and `setPasswordHash`
 * writes it. Responses are allowlists, never the record.
 *
 * An organisation's club setup (tactical, squad, lookingFor, federationCheck), verification and agency settings live
 * in their own repositories (clubSetup, verification, agentCore); a write naming one of those fields is refused,
 * naming where it lives (RETIRED_FACET_OWNER). Any other unknown field is refused too.
 *
 * Refusals carry a code and name the id and the field, never a value.
 *
 * A first installation's organisations (the seed) are imported once by `initialize`, while `meta.orgsInit` is
 * `pending` (set by the migration).
 */
import { PLANS } from '../catalogue.mjs';
import { transaction, migrationApplied, operationOn } from './database.mjs';
import { pageOf } from '../domains/platform/paging.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';

export const ORGS_TABLE_MIGRATION = '0004_orgs_live';
/** `meta` key holding the initialisation state (`pending` | `done`). */
export const ORGS_INIT_META = 'orgsInit';
export const ORG_TYPES = Object.freeze(['club', 'agency']);
export const ORG_LEVELS = Object.freeze(['pro', 'academy', 'agency', 'grassroots']);
/** The plans an organisation can be on: the catalogue's (one definition; the orgs table's CHECK lists the same four). */
export const ORG_PLANS = Object.freeze(Object.keys(PLANS));
export const ORG_LIMITS = Object.freeze({
  id: 80,
  name: 120,
  country: 40,
  city: 80,
  federation: 120,
  registrationId: 60,
  domain: 253,
  passwordHash: 512,
});
const L = ORG_LIMITS;
const list = (xs) => xs.map((x) => `'${x}'`).join(', ');

export const ORGS_DDL = `
CREATE TABLE orgs (
  id                           TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND ${L.id}),
  name                         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${L.name}),
  type                         TEXT NOT NULL CHECK (type IN (${list(ORG_TYPES)})),
  level                        TEXT CHECK (level IS NULL OR level IN (${list(ORG_LEVELS)})),
  plan                         TEXT NOT NULL CHECK (plan IN (${list(ORG_PLANS)})),
  country                      TEXT CHECK (country IS NULL OR length(country) BETWEEN 1 AND ${L.country}),
  city                         TEXT CHECK (city IS NULL OR length(city) BETWEEN 1 AND ${L.city}),
  lat                          REAL CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng                          REAL CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  federation                   TEXT CHECK (federation IS NULL OR length(federation) BETWEEN 1 AND ${L.federation}),
  federation_registration_id   TEXT CHECK (federation_registration_id IS NULL OR length(federation_registration_id) BETWEEN 1 AND ${L.registrationId}),
  trusted_partner              INTEGER NOT NULL DEFAULT 0 CHECK (trusted_partner IN (0,1)),
  verified                     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  verified_domain              TEXT CHECK (verified_domain IS NULL OR length(verified_domain) BETWEEN 1 AND ${L.domain}),
  safeguarding_contract_signed INTEGER NOT NULL DEFAULT 0 CHECK (safeguarding_contract_signed IN (0,1)),
  suspended                    INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
  password_hash                TEXT CHECK (password_hash IS NULL OR length(password_hash) BETWEEN 1 AND ${L.passwordHash}),
  email_domain                 TEXT CHECK (email_domain IS NULL OR length(email_domain) BETWEEN 1 AND ${L.domain}),
  email_domain_verified        INTEGER NOT NULL DEFAULT 0 CHECK (email_domain_verified IN (0,1)),
  mfa_required_for_leads       INTEGER NOT NULL DEFAULT 0 CHECK (mfa_required_for_leads IN (0,1)),
  verification_revoked_at      INTEGER,
  created_at                   INTEGER NOT NULL,
  CHECK ((lat IS NULL) = (lng IS NULL)),
  CHECK (city IS NULL OR lat IS NOT NULL),
  CHECK ((federation IS NULL) = (federation_registration_id IS NULL))
) STRICT;
CREATE INDEX orgs_type_level ON orgs (type, level);
`;

// Local (not scoutingEvidence's): recruitment.mjs imports this module, and scoutingEvidence.mjs imports recruitment.mjs.
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isClock = (v) => Number.isSafeInteger(v) && v >= 0;
const describe = (v) =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;
const textOk = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max && v === v.trim();

export const ORG_RECORD_KEYS = Object.freeze([
  'id',
  'name',
  'type',
  'level',
  'plan',
  'country',
  'location',
  'federationRef',
  'trustedPartner',
  'verified',
  'verifiedDomain',
  'safeguardingContractSigned',
  'suspended',
  'emailDomain',
  'emailDomainVerified',
  'mfaRequiredForLeads',
  'verificationRevokedAt',
  'createdAt',
]);
const BOOLEANS = Object.freeze([
  'trustedPartner',
  'verified',
  'safeguardingContractSigned',
  'suspended',
  'emailDomainVerified',
  'mfaRequiredForLeads',
]);
/** Fields another repository owns, named in the refusal so a misdirected writer learns where they live. */
const RETIRED_FACET_OWNER = Object.freeze({
  tactical: 'clubSetup',
  squad: 'clubSetup',
  lookingFor: 'clubSetup',
  federationCheck: 'clubSetup',
  verification: 'verification',
  agencySettings: 'agentCore',
});

/** Fill the optional fields of an incoming record with their defaults (null, or false for a flag). */
const withDefaults = (raw, createdAt) => {
  const given = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)); // an undefined field is an absent one
  const r = {
    level: null,
    country: null,
    location: null,
    federationRef: null,
    verifiedDomain: null,
    emailDomain: null,
    verificationRevokedAt: null,
    createdAt,
    ...given,
  };
  for (const k of BOOLEANS) if (r[k] === undefined) r[k] = false;
  if (isPlainObject(r.location))
    r.location = {
      lat: r.location.lat,
      lng: r.location.lng,
      city: r.location.city === undefined || r.location.city === '' ? null : r.location.city,
      ...Object.fromEntries(Object.entries(r.location).filter(([k]) => !['lat', 'lng', 'city'].includes(k))),
    };
  // The record's fields in their one order; anything else after them (and refused by the typing).
  return Object.fromEntries([
    ...ORG_RECORD_KEYS.map((k) => [k, r[k]]),
    ...Object.entries(r).filter(([k]) => !ORG_RECORD_KEYS.includes(k)),
  ]);
};

/** The problems with a record (an incoming one after its defaults, or a draft after an update), by field. */
export function orgRecordProblems(r) {
  const out = [];
  const unknown = Object.keys(r).filter((k) => !ORG_RECORD_KEYS.includes(k));
  for (const k of unknown)
    out.push(
      RETIRED_FACET_OWNER[k]
        ? `${k} is no longer an organisation field: write it through the ${RETIRED_FACET_OWNER[k]} repository`
        : `unknown field ${k}`,
    );
  if (!textOk(r.id, L.id)) out.push(`id must be text of 1 to ${L.id} characters`);
  if (!textOk(r.name, L.name)) out.push(`name must be text of 1 to ${L.name} characters without surrounding spaces`);
  if (!ORG_TYPES.includes(r.type)) out.push(`type must be one of ${ORG_TYPES.join(', ')}`);
  if (r.level !== null && !ORG_LEVELS.includes(r.level))
    out.push(`level must be one of ${ORG_LEVELS.join(', ')} or null`);
  if (!ORG_PLANS.includes(r.plan)) out.push(`plan must be one of ${ORG_PLANS.join(', ')}`);
  if (r.country !== null && !textOk(r.country, L.country))
    out.push(`country must be text of 1 to ${L.country} characters or null`);
  for (const k of ['verifiedDomain', 'emailDomain'])
    if (r[k] !== null && !textOk(r[k], L.domain)) out.push(`${k} must be text of 1 to ${L.domain} characters or null`);
  for (const k of BOOLEANS) if (typeof r[k] !== 'boolean') out.push(`${k} must be a boolean`);
  if (r.verificationRevokedAt !== null && !isClock(r.verificationRevokedAt))
    out.push('verificationRevokedAt must be an integer timestamp or null');
  if (!isClock(r.createdAt)) out.push('createdAt must be an integer timestamp');
  if (r.location !== null) {
    const loc = r.location;
    if (!isPlainObject(loc) || Object.keys(loc).some((k) => !['lat', 'lng', 'city'].includes(k)))
      out.push(`location must be { lat, lng, city } or null (got ${describe(loc)})`);
    else {
      if (
        !(Number.isFinite(loc.lat) && Math.abs(loc.lat) <= 90 && Number.isFinite(loc.lng) && Math.abs(loc.lng) <= 180)
      )
        out.push('location.lat and location.lng must be a latitude (-90 to 90) and a longitude (-180 to 180)');
      if (loc.city !== null && !textOk(loc.city, L.city))
        out.push(`location.city must be text of 1 to ${L.city} characters or null`);
    }
  }
  if (r.federationRef !== null) {
    const f = r.federationRef;
    if (!isPlainObject(f) || Object.keys(f).some((k) => !['federation', 'registrationId'].includes(k)))
      out.push(`federationRef must be { federation, registrationId } or null (got ${describe(f)})`);
    else {
      if (!textOk(f.federation, L.federation))
        out.push(`federationRef.federation must be text of 1 to ${L.federation} characters`);
      if (!textOk(f.registrationId, L.registrationId))
        out.push(`federationRef.registrationId must be text of 1 to ${L.registrationId} characters`);
    }
  }
  return out;
}

const COLS =
  'id, name, type, level, plan, country, city, lat, lng, federation, federation_registration_id, trusted_partner, verified, verified_domain, safeguarding_contract_signed, suspended, password_hash, email_domain, email_domain_verified, mfa_required_for_leads, verification_revoked_at, created_at';
const COL_LIST = COLS.split(', ');
const SELECT = `SELECT ${COLS} FROM orgs`;
const INSERT = `INSERT INTO orgs (${COLS}) VALUES (${COL_LIST.map((c) => `@${c}`).join(', ')})`;
const b = (v) => (v ? 1 : 0);
const params = (r, passwordHash = null) => ({
  id: r.id,
  name: r.name,
  type: r.type,
  level: r.level,
  plan: r.plan,
  country: r.country,
  city: r.location?.city ?? null,
  lat: r.location?.lat ?? null,
  lng: r.location?.lng ?? null,
  federation: r.federationRef?.federation ?? null,
  federation_registration_id: r.federationRef?.registrationId ?? null,
  trusted_partner: b(r.trustedPartner),
  verified: b(r.verified),
  verified_domain: r.verifiedDomain,
  safeguarding_contract_signed: b(r.safeguardingContractSigned),
  suspended: b(r.suspended),
  password_hash: passwordHash,
  email_domain: r.emailDomain,
  email_domain_verified: b(r.emailDomainVerified),
  mfa_required_for_leads: b(r.mfaRequiredForLeads),
  verification_revoked_at: r.verificationRevokedAt,
  created_at: r.createdAt,
});
/** The record for a table row (plain; the repository freezes what it hands out). */
function fromDb(d) {
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    level: d.level,
    plan: d.plan,
    country: d.country,
    location: d.lat === null ? null : { lat: d.lat, lng: d.lng, city: d.city },
    federationRef:
      d.federation === null ? null : { federation: d.federation, registrationId: d.federation_registration_id },
    trustedPartner: d.trusted_partner === 1,
    verified: d.verified === 1,
    verifiedDomain: d.verified_domain,
    safeguardingContractSigned: d.safeguarding_contract_signed === 1,
    suspended: d.suspended === 1,
    emailDomain: d.email_domain,
    emailDomainVerified: d.email_domain_verified === 1,
    mfaRequiredForLeads: d.mfa_required_for_leads === 1,
    verificationRevokedAt: d.verification_revoked_at,
    createdAt: d.created_at,
  };
}
const passwordProblem = (h) =>
  h === null || textOk(h, L.passwordHash)
    ? null
    : `the password hash must be text of 1 to ${L.passwordHash} characters or null`;

const cutOver = (sqlite) => migrationApplied(sqlite, ORGS_TABLE_MIGRATION);

// ------------------------------------------------------------------ the whole-domain read
/**
 * Type one organisation to import (the seed): `{ ok: true, row, passwordHash }` or `{ ok: false, reason }`. A row is
 * a record plus `password` (the hash, or null); absent optional fields take their defaults (`createdAt` the import's
 * time); an unknown field is refused.
 */
export function typeOrgSnapshotRow(raw, { now = Date.now() } = {}) {
  if (!isPlainObject(raw)) return { ok: false, reason: `not an object (${describe(raw)})` };
  const at = `organisation ${typeof raw.id === 'string' ? raw.id : '(no id)'}`;
  const { password = null, ...rest } = raw;
  const r = withDefaults(rest, now);
  const problems = orgRecordProblems(r);
  const pw = passwordProblem(password);
  if (pw) problems.push(pw);
  if (problems.length) return { ok: false, reason: `${at}: ${problems.join('; ')}` };
  return { ok: true, row: r, passwordHash: password };
}

const readSnapshot = (sqlite) =>
  sqlite
    .prepare(`${SELECT} ORDER BY rowid`)
    .all()
    .map((d) => ({ ...fromDb(d), password: d.password_hash }));

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const ORGS_TABLE = {
  name: 'orgs',
  read(sqlite) {
    return cutOver(sqlite) ? readSnapshot(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the repository
const WRITES = new Set([
  'create',
  'setStanding',
  'verifyEmailDomain',
  'setMfaRequiredForLeads',
  'revokeVerification',
  'clearVerificationRevocation',
  'setPasswordHash',
  'initialize',
]);

/** `createOrgsRepository({ sqlite, nextId, unit, now, log })`: the organisation writes and queries, plus `reads` (the queries alone). */
export function createOrgsRepository({ sqlite, nextId = null, unit = null, now = Date.now, log = () => {} }) {
  if (!sqlite)
    throw new TypeError(
      'the organisations repository needs a SQLite connection (node:sqlite); organisations have no in-memory fallback',
    );
  if (!cutOver(sqlite))
    throw new Error(
      `orgs: the cutover record ${ORGS_TABLE_MIGRATION} is missing from data_migrations; the table cannot be trusted as the source of truth`,
    );
  const operation = operationOn(sqlite, unit);
  const cache = new Map();
  const q = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  const dec = (rows) => rows.map((d) => deepFreeze(fromDb(d)));
  const byId = (id) => (typeof id === 'string' && id ? (dec(q(`${SELECT} WHERE id = ?`).all(id))[0] ?? null) : null);
  const invalid = (id, problems) =>
    refusal('ORG_RECORD_INVALID', `organisation ${id}: ${problems.join('; ')}`, { problems });
  const readInitState = () => {
    const row = q('SELECT value FROM meta WHERE key = ?').get(ORGS_INIT_META);
    if (!row) return 'done';
    if (row.value !== 'pending' && row.value !== 'done')
      throw new Error(
        `orgs: meta.${ORGS_INIT_META} holds ${JSON.stringify(row.value)}, which is neither "pending" nor "done"`,
      );
    return row.value;
  };
  /** `type`, `level` and `notLevel` narrow a list (`level: null` is the organisations without a level). */
  const where = ({ type, level, notLevel } = {}) => {
    const sql = [];
    const args = [];
    if (type !== undefined) {
      sql.push('type = ?');
      args.push(type);
    }
    if (level === null) sql.push('level IS NULL');
    else if (level !== undefined) {
      sql.push('level = ?');
      args.push(level);
    }
    if (notLevel !== undefined) {
      sql.push('(level IS NULL OR level <> ?)');
      args.push(notLevel);
    }
    return { sql: sql.length ? ` WHERE ${sql.join(' AND ')}` : '', args };
  };
  const repo = {
    // ---------------------------------------------------------- writes
    /**
     * Create an organisation (the id is minted here unless the caller gives one). Absent optional fields take their
     * defaults; junk is refused by field; `passwordHash` is stored, never put on the record. Returns the stored record.
     */
    create: ({ passwordHash = null, ...fields } = {}) =>
      operation(() => {
        const r = withDefaults(
          { ...fields, id: fields.id ?? (nextId ? nextId('org') : undefined) },
          fields.createdAt ?? now(),
        );
        const problems = orgRecordProblems(r);
        const pw = passwordProblem(passwordHash);
        if (pw) problems.push(pw);
        if (problems.length) throw invalid(r.id, problems);
        if (q('SELECT 1 FROM orgs WHERE id = ?').get(r.id))
          throw refusal('ORG_EXISTS', `organisation ${r.id} already exists`);
        q(INSERT).run(params(r, passwordHash));
        return byId(r.id);
      }),
    /**
     * Trust & Safety's standing switches: any of `verified`, `safeguardingContractSigned` and `suspended` (booleans) and
     * `verifiedDomain` (text, or null to clear it). Fields left out keep their value. Returns the stored record.
     */
    setStanding: (id, fields) =>
      operation(() => {
        if (!isPlainObject(fields))
          throw new TypeError(
            'orgs.setStanding(id, { verified, safeguardingContractSigned, verifiedDomain, suspended }) takes an object',
          );
        const columns = {
          verified: 'verified',
          safeguardingContractSigned: 'safeguarding_contract_signed',
          suspended: 'suspended',
          verifiedDomain: 'verified_domain',
        };
        const problems = [];
        const set = {};
        for (const [k, v] of Object.entries(fields)) {
          if (v === undefined) continue;
          if (!columns[k]) problems.push(`${k} is not a standing switch`);
          else if (k === 'verifiedDomain') {
            if (v !== null && !textOk(v, L.domain))
              problems.push(`verifiedDomain must be text of 1 to ${L.domain} characters, or null`);
            else set[columns[k]] = v;
          } else if (typeof v !== 'boolean') problems.push(`${k} must be a boolean (got ${describe(v)})`);
          else set[columns[k]] = v ? 1 : 0;
        }
        if (problems.length) throw invalid(id, problems);
        if (!byId(id)) throw refusal('ORG_NOT_FOUND', `organisation ${id} does not exist`);
        const cols = Object.keys(set);
        if (cols.length)
          q(`UPDATE orgs SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...set, id });
        return byId(id);
      }),
    /** The club proved control of a mailbox at `domain`: the domain is stored and marked verified. Returns the stored record. */
    verifyEmailDomain: (id, domain) =>
      operation(() => {
        if (!textOk(domain, L.domain)) throw invalid(id, [`emailDomain must be text of 1 to ${L.domain} characters`]);
        if (q('UPDATE orgs SET email_domain = ?, email_domain_verified = 1 WHERE id = ?').run(domain, id).changes !== 1)
          throw refusal('ORG_NOT_FOUND', `organisation ${id} does not exist`);
        return byId(id);
      }),
    /** Require (or stop requiring) MFA of the organisation's leads. Returns the stored record. */
    setMfaRequiredForLeads: (id, required) =>
      operation(() => {
        if (typeof required !== 'boolean')
          throw invalid(id, [`mfaRequiredForLeads must be a boolean (got ${describe(required)})`]);
        if (q('UPDATE orgs SET mfa_required_for_leads = ? WHERE id = ?').run(required ? 1 : 0, id).changes !== 1)
          throw refusal('ORG_NOT_FOUND', `organisation ${id} does not exist`);
        return byId(id);
      }),
    /** Trust & Safety revoked the organisation's verification at `at`: it is no longer verified. Returns the stored record. */
    revokeVerification: (id, at) =>
      operation(() => {
        if (!Number.isSafeInteger(at) || at < 0)
          throw invalid(id, ['verificationRevokedAt must be an integer timestamp']);
        if (q('UPDATE orgs SET verified = 0, verification_revoked_at = ? WHERE id = ?').run(at, id).changes !== 1)
          throw refusal('ORG_NOT_FOUND', `organisation ${id} does not exist`);
        return byId(id);
      }),
    /** The organisation was verified again: the revocation no longer stands. Returns the stored record. */
    clearVerificationRevocation: (id) =>
      operation(() => {
        if (q('UPDATE orgs SET verification_revoked_at = NULL WHERE id = ?').run(id).changes !== 1)
          throw refusal('ORG_NOT_FOUND', `organisation ${id} does not exist`);
        return byId(id);
      }),
    /** Store a new password hash (or null to remove the password). Returns the stored record. */
    setPasswordHash: (id, hash) =>
      operation(() => {
        const pw = passwordProblem(hash);
        if (pw) throw invalid(id, [pw]);
        if (q('UPDATE orgs SET password_hash = ? WHERE id = ?').run(hash, id).changes !== 1)
          throw refusal('ORG_NOT_FOUND', `organisation ${id} does not exist`);
        return byId(id);
      }),
    /**
     * First-installation initialisation: import the given records (the seed) and record `done`, in one transaction.
     * Allowed only while the state is `pending` and the table is empty; every record is typed first.
     */
    initialize(given) {
      if (readInitState() !== 'pending')
        throw new Error(
          `orgs: the organisations were already initialised (meta.${ORGS_INIT_META} is "done"); the table is authoritative and nothing is imported`,
        );
      const stored = repo.count();
      if (stored)
        throw new Error(
          `orgs: initialisation is pending but the table already holds ${stored} row(s) written outside the repository; refusing to initialise over them`,
        );
      if (!Array.isArray(given))
        throw new TypeError(
          `orgs: initialize() needs the first installation's organisations as an array (got ${given === undefined ? 'absent' : describe(given)}); nothing was written and initialisation stays pending`,
        );
      const at = now();
      const typed = given.map((raw, i) => {
        const v = typeOrgSnapshotRow(raw, { now: at });
        if (!v.ok) throw new Error(`orgs: entry #${i} cannot be imported — ${v.reason}`);
        return v;
      });
      transaction(sqlite, () => {
        for (const { row, passwordHash } of typed) q(INSERT).run(params(row, passwordHash));
        q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
          ORGS_INIT_META,
          'done',
        );
      });
      log(`orgs: initialised ${typed.length} organisation(s) from the first installation's records`);
      return { engine: 'sqlite', rows: typed.length, imported: typed.length };
    },

    // ---------------------------------------------------------- reads
    byId,
    /** Every organisation (or those of a `type` / `level`, or not of `notLevel`), in creation order. Bounded by the clubs, not the player base. */
    list: (filter = {}) => {
      const w = where(filter);
      return dec(q(`${SELECT}${w.sql} ORDER BY rowid`).all(...w.args));
    },
    /** One page of `list(filter)`, oldest first; `page` is the route's `readPage(query, ['number'])`: `{ items, nextCursor }`. */
    page: (filter = {}, { limit, after = null }) => {
      const w = where(filter);
      const rows = q(
        `SELECT rowid AS rid, ${COLS} FROM orgs${w.sql}${w.sql ? ' AND' : ' WHERE'} rowid > ? ORDER BY rowid LIMIT ?`,
      ).all(...w.args, after ? after[0] : 0, limit + 1);
      const page = pageOf(rows, limit, (r) => [r.rid]);
      return { items: dec(page.items), nextCursor: page.nextCursor };
    },
    /** The organisations of a `level` whose ground lies inside the latitude/longitude `box` (a prefilter; the exact distance is the caller's). */
    locatedInBox: (box, { level } = {}) =>
      dec(
        q(
          `${SELECT} WHERE lat IS NOT NULL AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?${level ? ' AND level = ?' : ''} ORDER BY rowid`,
        ).all(box.minLat, box.maxLat, box.minLng, box.maxLng, ...(level ? [level] : [])),
      ),
    /** An organisation with this name (case-insensitive, surrounding spaces ignored), or null. */
    byName: (name) =>
      typeof name === 'string' && name.trim()
        ? (dec(q(`${SELECT} WHERE lower(name) = lower(?) ORDER BY rowid LIMIT 1`).all(name.trim()))[0] ?? null)
        : null,
    /** The stored password hash for the sign-in check (never on a record), or null. */
    passwordHashOf: (id) => q('SELECT password_hash FROM orgs WHERE id = ?').get(id)?.password_hash ?? null,
    count: (filter = {}) => {
      const w = where(filter);
      return q(`SELECT COUNT(*) AS n FROM orgs${w.sql}`).get(...w.args).n;
    },
    /** `pending` (a first installation that has not been initialised yet) or `done`. */
    initState: () => readInitState(),
    attach() {
      const rows = repo.count();
      log(`orgs: ${rows} organisation(s) in the table`);
      return { engine: 'sqlite', rows, imported: 0 };
    },
  };
  repo.reads = Object.freeze(
    Object.fromEntries(
      Object.entries(repo).filter(([k, v]) => typeof v === 'function' && !WRITES.has(k) && k !== 'attach'),
    ),
  );
  return repo;
}
