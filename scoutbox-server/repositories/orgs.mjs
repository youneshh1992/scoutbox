/**
 * Organisations — the third live domain (plan step S3).
 *
 * Owns the `orgs` table and the `db.orgs` view. Every organisation field has
 * exactly one authoritative location:
 *
 *   COLUMNS (migrated scalars, written only through `insert`/`update`, one
 *   row written immediately inside a transaction): id, name, type, level,
 *   plan, country, trustedPartner, verified, verifiedDomain,
 *   safeguardingContractSigned, suspended, password (→ password_hash),
 *   emailDomain, emailDomainVerified, mfaRequiredForLeads, createdAt, and the
 *   two composites location{city,lat,lng} and federationRef{federation,
 *   registrationId}.
 *
 *   FACETS (`facets_json`, the transitional storage for everything else:
 *   tactical, squad, lookingFor, federationCheck, agencySettings, the whole
 *   `verification` object, and any field this step does not know): mutated in
 *   place by the modules that own them, exactly as the blob record was, and
 *   persisted by `flush()` inside every snapshot save transaction. They have
 *   their own cutover steps (S9 tactical/squad, S10 verification, S11 agency
 *   settings). The two columns `verification_revoked_at` /
 *   `verification_org_type` are a derived MIRROR of the verification facet,
 *   rewritten by `flush()` and read by nothing; the facet is authoritative
 *   until S10.
 *
 * Shape preservation. A record read back from a row has the same keys, in
 * the same order, with the same absent-versus-null distinction as the record
 * that was written: `facets_json.__meta` records the key order, which migrated
 * keys were explicitly null, and which composites were present. `__meta` never
 * appears on a record.
 *
 * Authority is decided by the cutover record `0004_orgs_live` in
 * `data_migrations`, never by the table existing (the S1 shadow created it)
 * or holding rows.
 */
import { readonlyView } from './readonly.mjs';
import { migrationApplied } from './database.mjs';

export const ORGS_CUTOVER_MIGRATION = '0004_orgs_live';
export const ORG_TYPES = Object.freeze(['club', 'agency']);
export const ORG_LEVELS = Object.freeze(['pro', 'academy', 'agency', 'grassroots']);
export const ORG_PLANS = Object.freeze(['Pro', 'Academy', 'Agency', 'Grassroots']);

/** Scalar record keys that live in a column of their own. */
const SCALARS = Object.freeze({
  name: 'name', type: 'type', level: 'level', plan: 'plan', country: 'country',
  trustedPartner: 'trusted_partner', verified: 'verified', verifiedDomain: 'verified_domain',
  safeguardingContractSigned: 'safeguarding_contract_signed', suspended: 'suspended', password: 'password_hash',
  emailDomain: 'email_domain', emailDomainVerified: 'email_domain_verified', mfaRequiredForLeads: 'mfa_required_for_leads',
  createdAt: 'created_at',
});
const BOOLEANS = new Set(['trustedPartner', 'verified', 'safeguardingContractSigned', 'suspended', 'emailDomainVerified', 'mfaRequiredForLeads']);
/** Composite record keys: an object whose listed sub-keys are columns; any other sub-key is a facet remainder. */
const COMPOSITES = Object.freeze({
  location: { city: 'city', lat: 'lat', lng: 'lng' },
  federationRef: { federation: 'federation', registrationId: 'federation_registration_id' },
});
/** Every record key the columns own; anything else is a facet. */
export const MIGRATED_KEYS = Object.freeze(new Set(['id', ...Object.keys(SCALARS), ...Object.keys(COMPOSITES)]));

const COLUMNS = ['id', 'name', 'type', 'level', 'plan', 'country', 'city', 'lat', 'lng', 'federation', 'federation_registration_id',
  'trusted_partner', 'verified', 'verified_domain', 'safeguarding_contract_signed', 'suspended', 'password_hash',
  'email_domain', 'email_domain_verified', 'mfa_required_for_leads', 'verification_revoked_at', 'verification_org_type', 'created_at', 'facets_json'];
const INSERT_SQL = `INSERT INTO orgs (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`;
const UPDATE_SQL = `UPDATE orgs SET ${COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`;
const SELECT_SQL = `SELECT ${COLUMNS.join(', ')} FROM orgs`;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v} (${JSON.stringify(v)})`);

/**
 * Decide whether a record can be stored, without coercing it. Returns
 * `{ ok: true }` or `{ ok: false, reason }`. Booleans must be booleans, text
 * fields strings, `createdAt` a non-negative integer, lat/lng finite numbers
 * both present or both absent, `type`/`plan` in their CHECK lists, `level`
 * in its list or null (the verification review creates non-grassroots
 * organisations with `level: null`, which the column allows).
 */
export function validateOrgRecord(rec) {
  if (!isPlainObject(rec)) return { ok: false, reason: 'not an object' };
  if (typeof rec.id !== 'string' || !rec.id) return { ok: false, reason: 'no id' };
  if (typeof rec.name !== 'string' || !rec.name) return { ok: false, reason: 'no name' };
  if (!ORG_TYPES.includes(rec.type)) return { ok: false, reason: `type ${describe(rec.type)} is not one of ${ORG_TYPES.join('/')}` };
  if (rec.level !== null && rec.level !== undefined && !ORG_LEVELS.includes(rec.level)) return { ok: false, reason: `level ${describe(rec.level)} is not one of ${ORG_LEVELS.join('/')} or null` };
  if (!ORG_PLANS.includes(rec.plan)) return { ok: false, reason: `plan ${describe(rec.plan)} is not one of ${ORG_PLANS.join('/')}` };
  for (const key of ['country', 'verifiedDomain', 'password', 'emailDomain']) {
    if (rec[key] !== undefined && rec[key] !== null && typeof rec[key] !== 'string') return { ok: false, reason: `${key} is ${describe(rec[key])}, not a string` };
  }
  for (const key of BOOLEANS) {
    if (rec[key] !== undefined && rec[key] !== null && typeof rec[key] !== 'boolean') return { ok: false, reason: `${key} is ${describe(rec[key])}, not a boolean` };
  }
  if (rec.createdAt !== undefined && rec.createdAt !== null && !(Number.isInteger(rec.createdAt) && rec.createdAt >= 0)) return { ok: false, reason: `createdAt is ${describe(rec.createdAt)}, not an integer timestamp` };
  if (rec.location !== undefined && rec.location !== null) {
    if (!isPlainObject(rec.location)) return { ok: false, reason: `location is ${describe(rec.location)}, not an object` };
    const { lat, lng, city } = rec.location;
    const hasLat = lat !== undefined && lat !== null, hasLng = lng !== undefined && lng !== null;
    if (hasLat !== hasLng) return { ok: false, reason: 'location has one of lat/lng without the other' };
    if (hasLat && !(Number.isFinite(lat) && Number.isFinite(lng))) return { ok: false, reason: 'location lat/lng are not finite numbers' };
    if (city !== undefined && city !== null && typeof city !== 'string') return { ok: false, reason: `location.city is ${describe(city)}, not a string` };
  }
  if (rec.federationRef !== undefined && rec.federationRef !== null) {
    if (!isPlainObject(rec.federationRef)) return { ok: false, reason: `federationRef is ${describe(rec.federationRef)}, not an object` };
    for (const key of ['federation', 'registrationId']) {
      const v = rec.federationRef[key];
      if (v !== undefined && v !== null && typeof v !== 'string') return { ok: false, reason: `federationRef.${key} is ${describe(v)}, not a string` };
    }
  }
  if (rec.verification !== undefined && rec.verification !== null && !isPlainObject(rec.verification)) return { ok: false, reason: `verification is ${describe(rec.verification)}, not an object` };
  if ('__meta' in rec) return { ok: false, reason: 'the reserved field "__meta" is not allowed on a record' };
  return { ok: true };
}

/** Record → row parameters. Every migrated key goes to its column; the rest, plus the shape metadata, to facets_json. */
export function toRow(rec) {
  const p = {};
  for (const c of COLUMNS) p[c] = null;
  p.id = rec.id;
  const meta = { order: Object.keys(rec), nulls: [], present: [], sub: {} };
  for (const [key, col] of Object.entries(SCALARS)) {
    const v = rec[key];
    if (v === null) { meta.nulls.push(key); continue; }
    if (v === undefined) continue;
    p[col] = BOOLEANS.has(key) ? (v ? 1 : 0) : v;
  }
  for (const [key, subs] of Object.entries(COMPOSITES)) {
    const v = rec[key];
    if (v === null) { meta.nulls.push(key); continue; }
    if (v === undefined) continue;
    meta.present.push(key);
    meta.sub[key] = Object.keys(v);
    for (const [sub, col] of Object.entries(subs)) {
      if (v[sub] === null) meta.nulls.push(`${key}.${sub}`);
      else if (v[sub] !== undefined) p[col] = v[sub];
    }
  }
  // Booleans default to 0 in the table; an absent boolean reads back as absent via meta (not in order → not rendered).
  for (const key of BOOLEANS) if (p[SCALARS[key]] === null) p[SCALARS[key]] = 0;
  const facets = {};
  for (const key of meta.order) {
    if (MIGRATED_KEYS.has(key)) continue;
    facets[key] = rec[key];
  }
  // Composite remainders: sub-keys the columns do not know stay with the record.
  for (const [key, subs] of Object.entries(COMPOSITES)) {
    const v = rec[key];
    if (!isPlainObject(v)) continue;
    const rest = Object.fromEntries(Object.entries(v).filter(([sub]) => !(sub in subs)));
    if (Object.keys(rest).length) { facets.__rest ??= {}; facets.__rest[key] = rest; }
  }
  facets.__meta = meta;
  p.facets_json = JSON.stringify(facets);
  // Derived mirror of the verification facet (read by nothing; authoritative in the facet until S10).
  const ver = isPlainObject(rec.verification) ? rec.verification : null;
  p.verification_revoked_at = ver && Number.isInteger(ver.revokedAt) ? ver.revokedAt : null;
  p.verification_org_type = ver && typeof ver.orgType === 'string' ? ver.orgType : null;
  return p;
}

/** Row → record, in the original key order with the original absent/null shape. */
export function fromRow(r) {
  const facets = r.facets_json ? JSON.parse(r.facets_json) : {};
  const meta = facets.__meta ?? { order: [], nulls: [], present: [] };
  const rest = facets.__rest ?? {};
  const nulls = new Set(meta.nulls);
  const values = {};
  values.id = r.id;
  for (const [key, col] of Object.entries(SCALARS)) {
    if (nulls.has(key)) { values[key] = null; continue; }
    const v = r[col];
    if (v === null || v === undefined) continue;
    values[key] = BOOLEANS.has(key) ? v === 1 : v;
  }
  for (const [key, subs] of Object.entries(COMPOSITES)) {
    if (nulls.has(key)) { values[key] = null; continue; }
    const obj = {};
    let any = meta.present.includes(key);
    for (const [sub, col] of Object.entries(subs)) {
      if (nulls.has(`${key}.${sub}`)) { obj[sub] = null; any = true; continue; }
      if (r[col] !== null && r[col] !== undefined) { obj[sub] = r[col]; any = true; }
    }
    if (rest[key]) { Object.assign(obj, rest[key]); any = true; }
    if (!any) continue;
    // Sub-keys in the order the record had them (then anything new at the end).
    const ordered = {};
    for (const sub of meta.sub?.[key] ?? []) if (sub in obj) ordered[sub] = obj[sub];
    for (const sub of Object.keys(obj)) if (!(sub in ordered)) ordered[sub] = obj[sub];
    values[key] = ordered;
  }
  for (const [key, v] of Object.entries(facets)) {
    if (key === '__meta' || key === '__rest') continue;
    values[key] = v;
  }
  // Original key order first, then anything the row holds that the order did not list.
  const rec = {};
  for (const key of meta.order) if (key in values) rec[key] = values[key];
  for (const key of Object.keys(values)) if (!(key in rec)) rec[key] = values[key];
  // Booleans that were absent on the way in are absent on the way out (the table stores 0).
  for (const key of BOOLEANS) if (!meta.order.includes(key) && rec[key] === false) delete rec[key];
  return rec;
}

const cutOver = (sqlite) => migrationApplied(sqlite, ORGS_CUTOVER_MIGRATION);

/**
 * Whole-table access for tools that treat the file as one snapshot (backups,
 * restores, the persistence suites). Declines (`null` / `false`) before the
 * cutover record exists, so the caller keeps using the legacy blob. `replace`
 * upserts every record and THROWS on the first unsupported one (rolling the
 * caller's whole save back); `prune` deletes the rows a snapshot no longer
 * lists and runs after the staff table was written, so a staff member who
 * still names the organisation makes the foreign key refuse the save instead
 * of the organisation vanishing under them.
 */
export const ORGS_TABLE = {
  name: 'orgs',
  read(sqlite) {
    if (!cutOver(sqlite)) return null;
    return sqlite.prepare(`${SELECT_SQL} ORDER BY rowid`).all().map(fromRow);
  },
  replace(sqlite, rows) {
    if (!cutOver(sqlite)) return false;
    if (!Array.isArray(rows)) throw new TypeError('orgs: the snapshot collection must be an array of records');
    const seen = new Set();
    rows.forEach((rec, i) => {
      const v = validateOrgRecord(rec);
      const label = isPlainObject(rec) && typeof rec.id === 'string' ? `id ${rec.id}` : `entry #${i}`;
      if (!v.ok) throw new Error(`orgs: snapshot row ${label} was refused (${v.reason}); the save was rolled back and no organisation was changed`);
      if (seen.has(rec.id)) throw new Error(`orgs: snapshot row ${label} was refused (duplicate id); the save was rolled back and no organisation was changed`);
      seen.add(rec.id);
    });
    const exists = sqlite.prepare('SELECT 1 FROM orgs WHERE id = ?');
    const insert = sqlite.prepare(INSERT_SQL);
    const update = sqlite.prepare(UPDATE_SQL);
    for (const rec of rows) (exists.get(rec.id) ? update : insert).run(toRow(rec));
    return true;
  },
  prune(sqlite, rows) {
    if (!cutOver(sqlite) || !Array.isArray(rows)) return;
    const keep = new Set(rows.map((r) => r.id));
    const del = sqlite.prepare('DELETE FROM orgs WHERE id = ?');
    for (const r of sqlite.prepare('SELECT id FROM orgs').all()) {
      if (keep.has(r.id)) continue;
      try { del.run(r.id); } catch (err) {
        throw new Error(`orgs: the snapshot no longer lists organisation ${r.id} but other records still reference it (${String(err?.message ?? err).replace(/^SQLITE_\w+:\s*/, '')}); the save was rolled back`);
      }
    }
  },
};

export function createOrgsRepository({ sqlite, log = () => {}, warn = () => {} }) {
  if (!sqlite) throw new TypeError('the organisations repository needs a SQLite connection (node:sqlite); the data layer has no in-memory fallback');
  // Checked before any statement is prepared: on a pre-S3 file the table is the
  // S1 shadow (no facets column) and the clear message must win over SQLite's.
  if (!migrationApplied(sqlite, ORGS_CUTOVER_MIGRATION)) throw new Error(`orgs: the cutover record ${ORGS_CUTOVER_MIGRATION} is missing from data_migrations; the table cannot be trusted as the source of truth`);
  const stmt = {
    all: sqlite.prepare(`${SELECT_SQL} ORDER BY rowid`),
    insert: sqlite.prepare(INSERT_SQL),
    update: sqlite.prepare(UPDATE_SQL),
    facets: sqlite.prepare('UPDATE orgs SET facets_json = @facets_json, verification_revoked_at = @verification_revoked_at, verification_org_type = @verification_org_type WHERE id = @id'),
    count: sqlite.prepare('SELECT COUNT(*) AS n FROM orgs'),
    cutover: sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?'),
  };

  const records = [];                 // plain record objects (scalars + facets), insertion order
  const proxies = [];                 // the view records, same order
  const byIdMap = new Map();          // id → plain record
  const lastFacets = new Map();       // id → facets_json last written, for change detection

  const refuse = (what) => { throw new TypeError(`${what} is written through the organisations repository (orgs.insert / orgs.update), never directly on the in-memory view.`); };

  /**
   * The view of one organisation: reading is the plain record; assigning a
   * MIGRATED key throws (use `update`); assigning or deleting any other key is
   * allowed and lands in the facets, persisted by the next save's `flush`.
   */
  const recordView = (target) => new Proxy(target, {
    set(t, key, value) {
      if (MIGRATED_KEYS.has(key)) return refuse(`an organisation (field "${String(key)}")`);
      if (key === '__meta' || key === '__rest') return refuse(`an organisation (reserved field "${String(key)}")`);
      t[key] = value; return true;
    },
    deleteProperty(t, key) {
      if (MIGRATED_KEYS.has(key)) return refuse(`an organisation (field "${String(key)}")`);
      delete t[key]; return true;
    },
    defineProperty(t, key, desc) {
      if (MIGRATED_KEYS.has(key)) return refuse(`an organisation (field "${String(key)}")`);
      return Reflect.defineProperty(t, key, desc);
    },
  });
  const remember = (rec, facetsJson) => {
    records.push(rec); byIdMap.set(rec.id, rec); lastFacets.set(rec.id, facetsJson);
    const view = recordView(rec); proxies.push(view); return view;
  };
  /** `db.orgs`: the records, read-only as an array (push/splice/assignment throw); each element is a record view. */
  const view = new Proxy(proxies, {
    set(_t, key) { return refuse(`the organisations collection (index "${String(key)}")`); },
    deleteProperty(_t, key) { return refuse(`the organisations collection (index "${String(key)}")`); },
    defineProperty(_t, key) { return refuse(`the organisations collection (index "${String(key)}")`); },
  });

  const load = () => {
    records.length = 0; proxies.length = 0; byIdMap.clear(); lastFacets.clear();
    for (const r of stmt.all.all()) remember(fromRow(r), r.facets_json);
  };

  const repo = {
    view,
    byId: (id) => (id && byIdMap.has(id) ? proxies[records.indexOf(byIdMap.get(id))] : null),
    count: () => records.length,
    cutOver: () => !!stmt.cutover.get(ORGS_CUTOVER_MIGRATION),

    /**
     * Boot. Refuses to run without the cutover record. Loads the table. When
     * the table is empty and the caller holds organisation records (a first
     * installation booting from the seed, or demo fixtures) they are imported;
     * when the table has rows, the caller's array is the superseded blob copy
     * and only a row the table does not hold is reported as stale.
     */
    attach(given) {
      if (!repo.cutOver()) throw new Error(`orgs: the cutover record ${ORGS_CUTOVER_MIGRATION} is missing from data_migrations; the table cannot be trusted as the source of truth`);
      const rows = Array.isArray(given) ? given : [];
      const stored = stmt.count.get().n;
      let imported = 0;
      if (stored === 0 && rows.length) {
        const problems = [];
        const seen = new Set();
        rows.forEach((rec, i) => {
          const v = validateOrgRecord(rec);
          const label = isPlainObject(rec) && typeof rec.id === 'string' ? `id ${rec.id}` : `entry #${i}`;
          if (!v.ok) problems.push(`${label}: ${v.reason}`); else if (seen.has(rec.id)) problems.push(`${label}: duplicate id`); else seen.add(rec.id);
        });
        if (problems.length) throw new Error(`orgs: ${problems.length} organisation record(s) cannot be imported — ${problems.slice(0, 20).join('; ')}`);
        sqlite.exec('BEGIN');
        try { for (const rec of rows) stmt.insert.run(toRow(clone(rec))); sqlite.exec('COMMIT'); } catch (err) { sqlite.exec('ROLLBACK'); throw err; }
        imported = rows.length;
        log(`orgs: imported ${imported} organisation(s) from the in-memory records (first boot)`);
      } else if (stored && rows.length) {
        const ids = new Set(sqlite.prepare('SELECT id FROM orgs').all().map((r) => r.id));
        const unknown = rows.filter((o) => isPlainObject(o) && !ids.has(o.id)).length;
        if (unknown) warn(`orgs: the table holds ${stored} row(s); an in-memory array with ${unknown} organisation(s) the table does not hold was ignored`);
      }
      load();
      return { engine: 'sqlite', loaded: records.length, imported };
    },

    /** Create an organisation. The caller supplies the id (ids are minted by the server's counter, as before). */
    insert(fields) {
      const rec = clone(fields);
      const v = validateOrgRecord(rec);
      if (!v.ok) throw new TypeError(`an organisation record was refused: ${v.reason}`);
      if (byIdMap.has(rec.id)) throw new Error(`organisation ${rec.id} already exists`);
      const row = toRow(rec);
      stmt.insert.run(row);
      return remember(rec, row.facets_json);
    },

    /**
     * Change migrated fields. `undefined` leaves a field alone, `null` sets an
     * explicit null (where the column allows it). Composites are replaced
     * whole. Facet keys cannot be set here: they are written on the record.
     */
    update(id, patch) {
      const rec = byIdMap.get(id);
      if (!rec) throw new Error(`organisation ${id} does not exist`);
      if (patch.id !== undefined && patch.id !== id) throw new TypeError('an organisation id never changes');
      const next = clone(rec);
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id' || value === undefined) continue;
        if (!MIGRATED_KEYS.has(key)) throw new TypeError(`"${key}" is not a migrated organisation field; write it on the record (it is kept in the facets)`);
        next[key] = clone(value);
      }
      const v = validateOrgRecord(next);
      if (!v.ok) throw new TypeError(`an organisation update was refused: ${v.reason}`);
      const row = toRow(next);
      stmt.update.run(row);
      for (const key of Object.keys(rec)) if (!(key in next)) delete rec[key];
      Object.assign(rec, next);
      lastFacets.set(id, row.facets_json);
      return proxies[records.indexOf(rec)];
    },

    /**
     * Persist facet changes made on the records since the last flush: one
     * UPDATE per changed organisation, inside the caller's transaction (the
     * store calls this from every snapshot save). Returns how many rows changed.
     */
    flush() {
      let changed = 0;
      for (const rec of records) {
        const row = toRow(rec);
        if (row.facets_json === lastFacets.get(rec.id)) continue;
        stmt.facets.run({ id: rec.id, facets_json: row.facets_json, verification_revoked_at: row.verification_revoked_at, verification_org_type: row.verification_org_type });
        lastFacets.set(rec.id, row.facets_json);
        changed += 1;
      }
      return changed;
    },
  };
  return repo;
}

export { readonlyView };
