/**
 * Player and guardian mapping for the S4a cutover (migration plan step S4,
 * readiness review §2–§4) — the record ⇄ row contract the live repositories
 * will own, written first so it can be tested and used for a read-only
 * preflight before anything cuts over.
 *
 * NOT a migration-only representation. `playerToRow` / `playerFromRow` and
 * `guardianToRow` / `guardianFromRow` are the S3 organisation pattern applied
 * to the two remaining core identity domains: every scalar and composite of
 * the target schema (`docs/architecture/sql/01_identity.sql`) goes to its
 * column; everything else — the nested arrays that wait for S5 (`media`,
 * `attendance`, `seasonHistory`, `drillResults`, …), the split-composite
 * remainders (`medical.records`, `programme.completed`), the guardian's
 * `coGuardians` and its outstanding `emailCode`, and any field this step does
 * not know — travels in the row's transitional `facets_json`, with the
 * record's shape (`__meta`: key order, explicit nulls, present composites and
 * their sub-key order) so the record read back is byte-for-byte the record
 * written: absent stays absent, `null` stays `null`, unknown fields stay,
 * nested arrays keep their order and content.
 *
 * Today's application record shapes are the compatibility contract: the
 * adult signup (server.mjs `/auth/player/signup`), the guardian-created
 * child (`POST /guardian/children`), the seed's `player()` defaults, the
 * guardian signup and the co-guardian route (no password, no `emailVerified`,
 * no `createdAt`), plus the boot defaults (`firstTeamSeeker`, `programme`,
 * `notificationPrefs`, `seasonHistory`).
 *
 * Decisions this module encodes, and the ones it does not take:
 *   - The guardian's `emailCode` stays EXACTLY what it is today — the plain
 *     value on the record, as a facet. It is not hashed, not copied, not
 *     verified here; the `email_code_hash` column stays NULL (readiness
 *     review §8.2: hashing moves to S6 with expiry, attempt limits and a
 *     resend route, so a rollback stays lossless).
 *   - `childIds` is not a facet: it becomes `guardian_children` rows (one per
 *     entry, in order; `role` is `primary` where the child's `guardianId`
 *     names this guardian, `co` otherwise). `guardianToRow` records where the
 *     key sat so `guardianFromRow(row, childIds)` puts it back in place.
 *   - Nothing is coerced and nothing is invented: a value the target refuses
 *     is reported by `validatePlayerRecord` / `validateGuardianRecord` with
 *     the field and the reason; `disclaimer_accepted_at`, `deleted_at`,
 *     `email_code_hash` are NULL for every imported row.
 *
 * Reports built from these validators carry ids, field names and reasons
 * only — never a password hash, an e-mail code, an e-mail address or a record.
 */
import { parseStrictDateOnly } from '../temporal.mjs';

export const PLAYER_POSITIONS = Object.freeze(['GK', 'CB', 'RB', 'LB', 'RWB', 'LWB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST', 'CF']);
export const PLAYER_FEET = Object.freeze(['left', 'right']);
export const PLAYER_AVAILABILITY = Object.freeze(['available_now', 'end_of_season', 'loan_open', 'overseas_open', 'not_seeking']);
export const PLAYER_CONTRACT_STATUS = Object.freeze(['under_contract', 'expiring_summer', 'scholarship_ending', 'release_approaching', 'free_agent', 'unknown']);
export const PLAYER_LEVELS = Object.freeze(['amateur', 'semi_pro', 'pro']);
/**
 * The nested arrays (validated as arrays when present at this level; their
 * items are validated by `playerSubrecords.mjs`). Until migration 0007 they
 * ride in the facets (`subrecords: 'facets'`, the S4a layout); once it is
 * recorded they are rows of the `player_*` tables (`subrecords: 'tables'`) and
 * the mapping keeps only their presence and null/absent shape in `__meta`.
 */
export const PLAYER_S5_ARRAYS = Object.freeze(['media', 'attendance', 'timeline', 'badges', 'trialReports', 'drills', 'drillResults', 'activityLog', 'externalIds', 'seasonHistory']);
/** The top-level arrays that become tables in S5 (`trialReports` is derived from the trials, not stored: PLAYER_DERIVED_KEYS). */
export const PLAYER_SUBRECORD_KEYS = Object.freeze(['media', 'attendance', 'timeline', 'badges', 'drills', 'drillResults', 'activityLog', 'externalIds', 'seasonHistory']);
/** Split composites whose remainder sub-key becomes a table in S5 (`facets_json.medical.records` → `player_medical_records`, …). */
export const PLAYER_COMPOSITE_SUBRECORDS = Object.freeze({ medical: Object.freeze(['records']), programme: Object.freeze(['completed']) });
/** The table each composite sub-key's rows live in (named in the decoder's refusal of an inconsistent row; playerSubrecords.mjs checks it against its specs). */
export const PLAYER_COMPOSITE_SUBRECORD_TABLES = Object.freeze({ 'medical.records': 'player_medical_records', 'programme.completed': 'player_programme_completions' });
/** Record keys served as derived values since S5 (never stored; presence kept in `__meta`). */
export const PLAYER_DERIVED_KEYS = Object.freeze(['trialReports']);
export const RESERVED_KEYS = Object.freeze(['__meta', '__rest']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const describe = (v) => (v === null ? 'null' : v === undefined ? 'absent' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : typeof v === 'bigint' ? 'a bigint' : `a ${typeof v}`);
const absentOrNull = (v) => v === null || v === undefined;
// A JSON record may carry OWN properties named like Object.prototype members
// (`constructor`, `toString`, `__proto__`, `hasOwnProperty`): they are data.
// Every key lookup below is an own-property check and every dynamic key is
// written as an own data property, so such a key is neither mistaken for a
// column (an inherited `constructor` is not a spec entry) nor allowed to
// change an object's prototype (`obj.__proto__ = v` would).
const hasOwn = (o, k) => Object.hasOwn(o, k);
const setOwn = (o, k, v) => { Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true }); return o; };
/**
 * The integer range this code can store and read back EXACTLY: node:sqlite
 * binds a JavaScript number as a 64-bit integer only when it is an integer
 * inside the safe range and reads an INTEGER column back as a number, so a
 * value outside ±(2^53 − 1) would be bound as REAL (refused by the STRICT
 * column) or read back imprecisely. Nothing is clamped or rounded: such a
 * value is refused with the field and the value.
 */
const isStorableInteger = (v) => typeof v === 'number' && Number.isSafeInteger(v);

// ------------------------------------------------------------------ specs
// A spec is the one description of a domain's mapping: which record keys are
// scalar columns, which are booleans, which composites split into columns,
// which columns the table requires (NOT NULL with a default the record may
// leave implicit), and which record keys are handled elsewhere (not facets).

const PLAYER_SPEC = Object.freeze({
  table: 'players',
  scalars: Object.freeze({
    name: 'name', dob: 'birth_date', country: 'country', city: 'city', position: 'position', foot: 'foot',
    heightCm: 'height_cm', weightKg: 'weight_kg', squadNumber: 'squad_number', contractUntil: 'contract_until_date',
    marketValueRange: 'market_value_range', agentName: 'agent_name', academyPlus: 'academy_plus', firstTeamSeeker: 'first_team_seeker',
    availability: 'availability', contractStatus: 'contract_status', level: 'level', footballCategory: 'football_category',
    identityVerified: 'identity_verified', guardianId: 'guardian_id', password: 'password_hash', createdAt: 'created_at',
  }),
  booleans: new Set(['academyPlus', 'firstTeamSeeker', 'identityVerified']),
  composites: Object.freeze({
    location: Object.freeze({ lat: 'lat', lng: 'lng' }),
    stats: Object.freeze({ appearances: 'stats_appearances', goals: 'stats_goals', assists: 'stats_assists', paceKmh: 'stats_pace_kmh', passCompletionPct: 'stats_pass_completion_pct', duelSuccessPct: 'stats_duel_success_pct', cleanSheets: 'stats_clean_sheets' }),
    medical: Object.freeze({ shared: 'medical_shared', conditionStatus: 'medical_condition_status' }),
    notificationPrefs: Object.freeze({ quietStart: 'prefs_quiet_start', quietEnd: 'prefs_quiet_end', schoolHoursMute: 'prefs_school_hours_mute', timezone: 'prefs_timezone' }),
    programme: Object.freeze({ track: 'programme_track', startedAt: 'programme_started_at' }),
  }),
  compositeBooleans: new Set(['medical.shared', 'notificationPrefs.schoolHoursMute']),
  // Columns the table requires; written as the table default when the record leaves the key out.
  defaults: Object.freeze({ academy_plus: 0, first_team_seeker: 0, identity_verified: 0, availability: 'not_seeking', contract_status: 'unknown', level: 'amateur', medical_shared: 0, medical_condition_status: 'unknown' }),
  excluded: new Set(),
  columns: Object.freeze(['id', 'name', 'birth_date', 'country', 'city', 'position', 'foot', 'height_cm', 'weight_kg', 'squad_number',
    'contract_until_date', 'market_value_range', 'agent_name', 'academy_plus', 'first_team_seeker', 'availability', 'contract_status', 'level',
    'football_category', 'identity_verified', 'guardian_id', 'lat', 'lng', 'stats_appearances', 'stats_goals', 'stats_assists', 'stats_pace_kmh',
    'stats_pass_completion_pct', 'stats_duel_success_pct', 'stats_clean_sheets', 'medical_shared', 'medical_condition_status', 'prefs_quiet_start',
    'prefs_quiet_end', 'prefs_school_hours_mute', 'prefs_timezone', 'programme_track', 'programme_started_at', 'password_hash', 'created_at',
    'deleted_at', 'facets_json']),
});

const GUARDIAN_SPEC = Object.freeze({
  table: 'guardians',
  scalars: Object.freeze({
    name: 'name', email: 'email', password: 'password_hash', emailVerified: 'email_verified', idVerified: 'id_verified',
    idvReference: 'idv_reference', disclaimerAccepted: 'disclaimer_accepted', coGuardianOf: 'co_guardian_of', createdAt: 'created_at',
  }),
  booleans: new Set(['emailVerified', 'idVerified', 'disclaimerAccepted']),
  composites: Object.freeze({
    notificationPrefs: Object.freeze({ quietStart: 'prefs_quiet_start', quietEnd: 'prefs_quiet_end', schoolHoursMute: 'prefs_school_hours_mute', timezone: 'prefs_timezone' }),
  }),
  compositeBooleans: new Set(['notificationPrefs.schoolHoursMute']),
  defaults: Object.freeze({ email_verified: 0, id_verified: 0, disclaimer_accepted: 0 }),
  // `childIds` becomes link rows; it is neither a column nor a facet (its position is kept in __meta.order).
  excluded: new Set(['childIds']),
  columns: Object.freeze(['id', 'name', 'email', 'password_hash', 'email_verified', 'email_code_hash', 'id_verified', 'idv_reference',
    'disclaimer_accepted', 'disclaimer_accepted_at', 'co_guardian_of', 'prefs_quiet_start', 'prefs_quiet_end', 'prefs_school_hours_mute',
    'prefs_timezone', 'created_at', 'deleted_at', 'facets_json']),
});

export const PLAYER_COLUMNS = PLAYER_SPEC.columns;
export const GUARDIAN_COLUMNS = GUARDIAN_SPEC.columns;
/** Composite record keys and their column-backed sub-keys (the repositories guard exactly these; other sub-keys are facets). */
export const PLAYER_COMPOSITES = PLAYER_SPEC.composites;
export const GUARDIAN_COMPOSITES = GUARDIAN_SPEC.composites;
/** Record keys the player columns own (anything else on a record is a facet). */
export const PLAYER_MIGRATED_KEYS = Object.freeze(new Set(['id', ...Object.keys(PLAYER_SPEC.scalars), ...Object.keys(PLAYER_SPEC.composites)]));
export const GUARDIAN_MIGRATED_KEYS = Object.freeze(new Set(['id', ...Object.keys(GUARDIAN_SPEC.scalars), ...Object.keys(GUARDIAN_SPEC.composites)]));

// ---------------------------------------------------------- record → row
/**
 * `tableKeys` (S5): record keys that are stored as child rows rather than
 * facets — their presence stays in `order`, a null in `nulls`, nothing of
 * their content in the facets. `tableSubs` does the same for a composite's
 * sub-keys (`medical.records`). `facetsColumn` names the JSON column (the
 * records' `facets_json`; an item's `extra_json`).
 */
function toRowWith(spec, rec, { tableKeys = new Set(), tableSubs = {} } = {}) {
  const facetsColumn = spec.facetsColumn ?? 'facets_json';
  const p = {};
  for (const c of spec.columns) p[c] = null;
  if (spec.columns.includes('id')) p.id = rec.id;
  const meta = { order: Object.keys(rec), nulls: [], present: [], sub: {} };
  for (const [key, col] of Object.entries(spec.scalars)) {
    const v = rec[key];
    if (v === null) { meta.nulls.push(key); continue; }
    if (v === undefined) continue;
    // A JSON column (an item's free-form `claim`) stores the value as text, exactly as given.
    p[col] = spec.booleans.has(key) ? (v ? 1 : 0) : spec.json?.has(key) ? JSON.stringify(v) : v;
  }
  for (const [key, subs] of Object.entries(spec.composites)) {
    const v = rec[key];
    if (v === null) { meta.nulls.push(key); continue; }
    if (v === undefined) continue;
    meta.present.push(key);
    meta.sub[key] = Object.keys(v);
    for (const [sub, col] of Object.entries(subs)) {
      if (!hasOwn(v, sub)) continue; // an inherited `constructor` is not a value of the record
      if (v[sub] === null) meta.nulls.push(`${key}.${sub}`);
      else if (v[sub] !== undefined) p[col] = spec.compositeBooleans.has(`${key}.${sub}`) ? (v[sub] ? 1 : 0) : v[sub];
    }
  }
  // Required columns the record left implicit take the table default; their
  // absence is remembered through `order` and restored on the way back.
  for (const [col, dflt] of Object.entries(spec.defaults ?? {})) if (p[col] === null) p[col] = dflt;
  const facets = {};
  for (const key of meta.order) {
    if (key === 'id' || hasOwn(spec.scalars, key) || hasOwn(spec.composites, key) || spec.excluded.has(key)) continue;
    // A table-backed array (S5): its rows are written by the caller; the facets keep only whether it was null.
    if (tableKeys.has(key)) { if (rec[key] === null) meta.nulls.push(key); continue; }
    setOwn(facets, key, rec[key]);
  }
  for (const [key, subs] of Object.entries(spec.composites)) {
    const v = rec[key];
    if (!isPlainObject(v)) continue;
    const rest = {};
    const subTables = tableSubs[key] ?? [];
    for (const sub of Object.keys(v)) {
      if (hasOwn(subs, sub)) continue;
      if (subTables.includes(sub)) { if (v[sub] === null) meta.nulls.push(`${key}.${sub}`); continue; }
      setOwn(rest, sub, v[sub]);
    }
    // A composite's remainder (medical.records, programme.completed, an unknown
    // stats sub-key) rides under the composite's OWN key in the facets —
    // `facets_json.medical.records` is what the documents describe and what a
    // reader of the file expects. (Rows written before this layout kept it
    // under the reserved `__rest`; the reverse mapping still reads those.)
    if (Object.keys(rest).length) setOwn(facets, key, rest);
  }
  facets.__meta = meta;
  p[facetsColumn] = JSON.stringify(facets);
  return p;
}

// ---------------------------------------------------------- row → record
/**
 * The shape metadata is authoritative: a key is emitted only if the record
 * had it (absent stays absent even where the column holds a default), a
 * null only where the record had one, a composite with exactly the sub-keys
 * it had, in their order. A row without metadata (written by something other
 * than this mapping) yields every non-null column.
 */
/**
 * `extra`: values the row does not hold (a guardian's `childIds`, the S5
 * arrays read from their tables): emitted where the record had the key, null
 * where it was null, omitted when the record never had it and the value is
 * empty — unless `extraAlways` lists the key (a derived value that exists must
 * never be hidden). `compositeExtra`: the same for a composite's sub-keys
 * (`{ medical: { records: [...] } }`).
 */
const isEmptyValue = (v) => (Array.isArray(v) ? v.length === 0 : isPlainObject(v) ? Object.keys(v).length === 0 : false);
/**
 * `compositeTables`: the table behind each composite sub-key supplied through
 * `compositeExtra` (`medical.records` → `player_medical_records`), for the one
 * refusal this decoder makes (review of 132eda2, finding 3): rows of a sub-key
 * whose composite the row's shape metadata says is null or absent cannot be
 * placed anywhere, so the row is NOT read as if they did not exist — an error
 * with `code: 'INCONSISTENT_ROWS'` names the record, the sub-key, the count and
 * the table, and every reader (the boot, a backup, the rollback tool) refuses
 * rather than certifies a view that hides authoritative rows. Rows of a sub-key
 * the composite's shape did not list are appended to the composite (never
 * hidden).
 */
function fromRowWith(spec, r, { extra = {}, compositeExtra = {}, compositeTables = {} } = {}) {
  const facetsColumn = spec.facetsColumn ?? 'facets_json';
  const facets = r[facetsColumn] ? JSON.parse(r[facetsColumn]) : {};
  const meta = facets.__meta ?? null;
  const legacyRest = facets.__rest ?? {}; // rows written before the remainders moved under their own key
  const remainderOf = (key) => (hasOwn(facets, key) && isPlainObject(facets[key]) ? facets[key] : hasOwn(legacyRest, key) ? legacyRest[key] : null);
  const nulls = new Set(meta?.nulls ?? []);
  const order = meta?.order ?? null;
  const values = spec.columns.includes('id') ? { id: r.id } : {};
  for (const [key, col] of Object.entries(spec.scalars)) {
    if (nulls.has(key)) { values[key] = null; continue; }
    if (order && !order.includes(key)) continue;
    const v = r[col];
    if (v === null || v === undefined) continue;
    values[key] = spec.booleans.has(key) ? v === 1 : spec.json?.has(key) ? JSON.parse(v) : v;
  }
  for (const [key, subs] of Object.entries(spec.composites)) {
    const subExtra = compositeExtra[key] ?? null;
    // Sub-keys whose rows exist (supplied by the caller from their tables), whatever the composite's shape says.
    const held = subExtra ? Object.entries(subExtra).filter(([, v]) => v !== undefined && !isEmptyValue(v)) : [];
    const compositeGone = nulls.has(key) || (order && !order.includes(key));
    if (compositeGone && held.length) {
      const [sub, v] = held[0];
      const n = Array.isArray(v) ? v.length : Object.keys(v).length;
      throw Object.assign(new Error(`${spec.table} ${r.id}: ${key} is ${nulls.has(key) ? 'null' : 'absent'} in the row's shape metadata but ${n} ${key}.${sub} row(s) exist in ${compositeTables[`${key}.${sub}`] ?? 'their table'}; the stored state is inconsistent and is not read as if the rows did not exist (resolve it by hand: the rows are authoritative)`), { code: 'INCONSISTENT_ROWS', id: r.id, key: `${key}.${sub}`, rows: n });
    }
    if (nulls.has(key)) { values[key] = null; continue; }
    if (order && !order.includes(key)) continue;
    const obj = {};
    const subOrder = meta?.sub?.[key] ?? null;
    const restOf = remainderOf(key);
    if (subOrder) {
      for (const sub of subOrder) {
        if (hasOwn(subs, sub)) {
          if (nulls.has(`${key}.${sub}`)) { setOwn(obj, sub, null); continue; }
          const v = r[subs[sub]];
          if (v !== null && v !== undefined) setOwn(obj, sub, spec.compositeBooleans.has(`${key}.${sub}`) ? v === 1 : v);
        } else if (subExtra && hasOwn(subExtra, sub)) {
          setOwn(obj, sub, nulls.has(`${key}.${sub}`) && isEmptyValue(subExtra[sub]) ? null : subExtra[sub]);
        } else if (restOf && hasOwn(restOf, sub)) {
          setOwn(obj, sub, restOf[sub]);
        }
      }
      // Rows of a sub-key the composite's shape never listed: appended, never hidden (the rows are authoritative).
      for (const [sub, v] of held) if (!subOrder.includes(sub)) setOwn(obj, sub, v);
      values[key] = obj;
      continue;
    }
    let any = false;
    for (const [sub, col] of Object.entries(subs)) {
      if (r[col] !== null && r[col] !== undefined) { setOwn(obj, sub, spec.compositeBooleans.has(`${key}.${sub}`) ? r[col] === 1 : r[col]); any = true; }
    }
    if (restOf) { for (const sub of Object.keys(restOf)) setOwn(obj, sub, restOf[sub]); any = true; }
    if (subExtra) { for (const sub of Object.keys(subExtra)) if (subExtra[sub] !== undefined && !isEmptyValue(subExtra[sub])) { setOwn(obj, sub, subExtra[sub]); any = true; } }
    if (any) values[key] = obj;
  }
  for (const key of Object.keys(facets)) {
    if (RESERVED_KEYS.includes(key) || hasOwn(spec.composites, key)) continue; // a composite's key holds its remainder, merged above
    setOwn(values, key, facets[key]);
  }
  for (const key of Object.keys(extra)) {
    if (extra[key] === undefined) continue;
    const empty = isEmptyValue(extra[key]);
    // A null the record had stays null — unless the value exists (a derived list that is not empty is never hidden).
    if (nulls.has(key) && empty) { setOwn(values, key, null); continue; }
    const had = order ? order.includes(key) : true;
    if (had || !empty) setOwn(values, key, extra[key]);
  }
  const rec = {};
  if (order) for (const key of order) if (hasOwn(values, key)) setOwn(rec, key, values[key]);
  for (const key of Object.keys(values)) if (!hasOwn(rec, key)) setOwn(rec, key, values[key]);
  return rec;
}

const TABLE_KEYS = new Set([...PLAYER_SUBRECORD_KEYS, ...PLAYER_DERIVED_KEYS]);
/**
 * Player record → row parameters for the live `players` table (facets_json
 * included). `subrecords: 'facets'` (the default, the S4a layout) keeps the
 * nested arrays in the facets; `'tables'` (S5, once migration 0007 is
 * recorded) leaves them out — the caller writes their rows — and keeps only
 * their presence and null/absent shape.
 */
export function playerToRow(rec, { subrecords = 'facets' } = {}) {
  if (subrecords !== 'facets' && subrecords !== 'tables') throw new TypeError(`playerToRow: subrecords is 'facets' or 'tables', not ${JSON.stringify(subrecords)}`);
  return subrecords === 'tables' ? toRowWith(PLAYER_SPEC, rec, { tableKeys: TABLE_KEYS, tableSubs: PLAYER_COMPOSITE_SUBRECORDS }) : toRowWith(PLAYER_SPEC, rec);
}
/**
 * Row → player record, original key order and absent/null shape. With
 * `children` (S5: `{ media: [...], …, medical: { records }, programme: { completed } }`,
 * read from the child tables) the arrays are put back where the record had them;
 * `trialReports` (derived) is put back where the record had it, or appended when
 * reports exist for a record that never had the key.
 */
export function playerFromRow(row, { children = null, trialReports = undefined } = {}) {
  if (!children && trialReports === undefined) return fromRowWith(PLAYER_SPEC, row);
  const extra = {};
  for (const key of PLAYER_SUBRECORD_KEYS) extra[key] = children ? (children[key] ?? []) : undefined;
  if (trialReports !== undefined) extra.trialReports = trialReports;
  const compositeExtra = {};
  if (children) for (const [key, subs] of Object.entries(PLAYER_COMPOSITE_SUBRECORDS)) { compositeExtra[key] = {}; for (const sub of subs) compositeExtra[key][sub] = children[key]?.[sub] ?? []; }
  return fromRowWith(PLAYER_SPEC, row, { extra, compositeExtra, compositeTables: PLAYER_COMPOSITE_SUBRECORD_TABLES });
}
/** Guardian record → row parameters; `childIds` is left out (it becomes link rows). */
export function guardianToRow(rec) { return toRowWith(GUARDIAN_SPEC, rec); }
/**
 * Row → guardian record. `childIds` (from the link rows, in their order) is put
 * back where the record had it; a guardian whose record never had the key
 * stays without it when the list is empty.
 */
export function guardianFromRow(row, childIds = []) {
  const facets = row.facets_json ? JSON.parse(row.facets_json) : {};
  const had = facets.__meta?.order?.includes('childIds') ?? false;
  return fromRowWith(GUARDIAN_SPEC, row, { extra: { childIds: had || childIds.length ? childIds.slice() : undefined } });
}
/** The generic item mapping (S5): a sub-record item ⇄ its row, by a spec `{ scalars, booleans, json?, composites, compositeBooleans, defaults?, columns, excluded, facetsColumn }`; `tableKeys` are item keys stored as rows of their own (`media.tags`). */
export function itemToRow(spec, item, { tableKeys = new Set() } = {}) { return toRowWith(spec, item, { tableKeys }); }
export function itemFromRow(spec, row, { extra = {} } = {}) { return fromRowWith(spec, row, { extra }); }

// --------------------------------------------------------------- validation
// Every check lists the field and why; nothing is coerced. "Absent is not
// invalid" for optional fields (readiness review §5.6): a co-guardian without
// `password`, a signed-up player without `drillResults`, a guardian without
// `createdAt` are all supported shapes.

/**
 * `required`: must be present, non-null and non-empty. `nonEmpty`: may be
 * absent or null, but a PRESENT string must not be empty — the shape of a
 * reference (`guardianId`, `coGuardianOf`): `null`/absent is "no link", `''`
 * is a present id that names nobody and is refused as such (never trimmed,
 * never converted to null).
 */
const checkString = (problems, rec, key, { required = false, nonEmpty = false } = {}) => {
  const v = rec[key];
  if (v === undefined) { if (required) problems.push(`${key} is absent`); return; }
  if (v === null) { if (required) problems.push(`${key} is null`); return; }
  if (typeof v !== 'string') { problems.push(`${key} is ${describe(v)}, not text`); return; }
  if ((required || nonEmpty) && v === '') problems.push(`${key} is empty`);
};
const checkBoolean = (problems, obj, key, label = key) => {
  const v = obj[key];
  if (!absentOrNull(v) && typeof v !== 'boolean') problems.push(`${label} is ${describe(v)}, not a boolean`);
};
/** INTEGER columns: a safe integer (see `isStorableInteger`), optionally with a lower bound. */
const checkInteger = (problems, obj, key, label = key, { min = null } = {}) => {
  const v = obj[key];
  if (absentOrNull(v)) return;
  if (!isStorableInteger(v)) problems.push(`${label} is ${typeof v === 'number' ? String(v) : describe(v)}, not a safe integer (an integer within ±9007199254740991, which the INTEGER column stores and reads back exactly)`);
  else if (min !== null && v < min) problems.push(`${label} is ${v}, below ${min}`);
};
const checkNumber = (problems, obj, key, label = key) => {
  const v = obj[key];
  if (!absentOrNull(v) && !(typeof v === 'number' && Number.isFinite(v))) problems.push(`${label} is ${typeof v === 'number' ? String(v) : describe(v)}, not a finite number`);
};
const checkEnum = (problems, rec, key, list, { nullable = true } = {}) => {
  const v = rec[key];
  if (v === undefined) return;
  if (v === null) { if (!nullable) problems.push(`${key} is null (the column is NOT NULL)`); return; }
  if (!list.includes(v)) problems.push(`${key} is not one of ${list.join('/')}${nullable ? ' or null' : ''}`);
};
const checkDateOnly = (problems, rec, key, { required = false } = {}) => {
  const v = rec[key];
  if (v === undefined) { if (required) problems.push(`${key} is absent`); return; }
  if (v === null) { if (required) problems.push(`${key} is null`); return; }
  const p = parseStrictDateOnly(v);
  if (!p.ok) problems.push(`${key} is not a valid YYYY-MM-DD date (${p.why})`);
};
const checkObject = (problems, rec, key) => {
  const v = rec[key];
  if (absentOrNull(v)) return false;
  if (!isPlainObject(v)) { problems.push(`${key} is ${describe(v)}, not an object`); return false; }
  return true;
};
const checkPrefs = (problems, rec) => {
  if (!checkObject(problems, rec, 'notificationPrefs')) return;
  const n = rec.notificationPrefs;
  for (const k of ['quietStart', 'quietEnd', 'timezone']) if (!absentOrNull(n[k]) && typeof n[k] !== 'string') problems.push(`notificationPrefs.${k} is ${describe(n[k])}, not text`);
  checkBoolean(problems, n, 'schoolHoursMute', 'notificationPrefs.schoolHoursMute');
};
const checkReserved = (problems, rec) => { for (const k of RESERVED_KEYS) if (hasOwn(rec, k)) problems.push(`the reserved field "${k}" is not allowed on a record`); };
const checkFacetsSerialisable = (problems, rec, migrated, excluded) => {
  for (const key of Object.keys(rec)) {
    if (migrated.has(key) || excluded.has(key) || RESERVED_KEYS.includes(key)) continue;
    try { JSON.stringify(rec[key]); } catch (err) { problems.push(`${key} cannot be stored as JSON (${String(err?.message ?? err).slice(0, 80)})`); }
  }
};

/** `{ ok: true }` or `{ ok: false, problems: [...] }` — every problem on the record, field by field. */
export function validatePlayerRecord(rec) {
  if (!isPlainObject(rec)) return { ok: false, problems: [`not an object (${describe(rec)})`] };
  const problems = [];
  checkString(problems, rec, 'id', { required: true });
  checkString(problems, rec, 'name', { required: true });
  checkDateOnly(problems, rec, 'dob', { required: true });
  checkString(problems, rec, 'country', { required: true });
  for (const key of ['city', 'marketValueRange', 'agentName', 'footballCategory', 'password']) checkString(problems, rec, key);
  checkString(problems, rec, 'guardianId', { nonEmpty: true });
  checkEnum(problems, rec, 'position', PLAYER_POSITIONS);
  checkEnum(problems, rec, 'foot', PLAYER_FEET);
  checkEnum(problems, rec, 'availability', PLAYER_AVAILABILITY, { nullable: false });
  checkEnum(problems, rec, 'contractStatus', PLAYER_CONTRACT_STATUS, { nullable: false });
  checkEnum(problems, rec, 'level', PLAYER_LEVELS, { nullable: false });
  checkDateOnly(problems, rec, 'contractUntil');
  for (const key of ['heightCm', 'weightKg', 'squadNumber']) checkInteger(problems, rec, key);
  checkInteger(problems, rec, 'createdAt', 'createdAt', { min: 0 });
  for (const key of PLAYER_SPEC.booleans) checkBoolean(problems, rec, key);
  if (checkObject(problems, rec, 'stats')) {
    for (const k of ['appearances', 'goals', 'assists', 'cleanSheets']) checkInteger(problems, rec.stats, k, `stats.${k}`);
    for (const k of ['paceKmh', 'passCompletionPct', 'duelSuccessPct']) checkNumber(problems, rec.stats, k, `stats.${k}`);
  }
  if (checkObject(problems, rec, 'location')) {
    const { lat, lng } = rec.location;
    if (absentOrNull(lat) !== absentOrNull(lng)) problems.push('location has one of lat/lng without the other');
    checkNumber(problems, rec.location, 'lat', 'location.lat'); checkNumber(problems, rec.location, 'lng', 'location.lng');
  }
  if (checkObject(problems, rec, 'medical')) {
    checkBoolean(problems, rec.medical, 'shared', 'medical.shared');
    const cs = rec.medical.conditionStatus;
    if (cs === null) problems.push('medical.conditionStatus is null (the column is NOT NULL)');
    else if (cs !== undefined && typeof cs !== 'string') problems.push(`medical.conditionStatus is ${describe(cs)}, not text`);
    if (!absentOrNull(rec.medical.records) && !Array.isArray(rec.medical.records)) problems.push(`medical.records is ${describe(rec.medical.records)}, not an array`);
  }
  checkPrefs(problems, rec);
  if (checkObject(problems, rec, 'programme')) {
    if (!absentOrNull(rec.programme.track) && typeof rec.programme.track !== 'string') problems.push(`programme.track is ${describe(rec.programme.track)}, not text`);
    checkInteger(problems, rec.programme, 'startedAt', 'programme.startedAt', { min: 0 });
    if (!absentOrNull(rec.programme.completed) && !Array.isArray(rec.programme.completed)) problems.push(`programme.completed is ${describe(rec.programme.completed)}, not an array`);
  }
  for (const key of PLAYER_S5_ARRAYS) if (!absentOrNull(rec[key]) && !Array.isArray(rec[key])) problems.push(`${key} is ${describe(rec[key])}, not an array`);
  checkReserved(problems, rec);
  checkFacetsSerialisable(problems, rec, PLAYER_MIGRATED_KEYS, PLAYER_SPEC.excluded);
  return problems.length ? { ok: false, problems } : { ok: true };
}

/** `{ ok: true }` or `{ ok: false, problems: [...] }`. The e-mail code is checked for shape only and never reported. */
export function validateGuardianRecord(rec) {
  if (!isPlainObject(rec)) return { ok: false, problems: [`not an object (${describe(rec)})`] };
  const problems = [];
  checkString(problems, rec, 'id', { required: true });
  checkString(problems, rec, 'name', { required: true });
  checkString(problems, rec, 'email', { required: true });
  for (const key of ['password', 'idvReference']) checkString(problems, rec, key);
  checkString(problems, rec, 'coGuardianOf', { nonEmpty: true });
  if (!absentOrNull(rec.emailCode) && typeof rec.emailCode !== 'string') problems.push(`emailCode is ${describe(rec.emailCode)}, not text`);
  for (const key of GUARDIAN_SPEC.booleans) checkBoolean(problems, rec, key);
  checkInteger(problems, rec, 'createdAt', 'createdAt', { min: 0 });
  if (rec.childIds !== undefined) {
    if (!Array.isArray(rec.childIds)) problems.push(`childIds is ${describe(rec.childIds)}, not an array`);
    else rec.childIds.forEach((c, i) => { if (typeof c !== 'string' || !c) problems.push(`childIds[${i}] is ${describe(c)}, not a player id`); });
  }
  if (!absentOrNull(rec.coGuardians) && !Array.isArray(rec.coGuardians)) problems.push(`coGuardians is ${describe(rec.coGuardians)}, not an array`);
  checkPrefs(problems, rec);
  checkReserved(problems, rec);
  checkFacetsSerialisable(problems, rec, GUARDIAN_MIGRATED_KEYS, GUARDIAN_SPEC.excluded);
  return problems.length ? { ok: false, problems } : { ok: true };
}
