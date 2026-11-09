/**
 * The write kit of the repositories whose records change through named acts (docs/architecture.md, Writes): a record
 * is created whole and must read back as written, then each act is an UPDATE or INSERT of the rows it concerns. The
 * tables' columns and keys judge the values; this module turns their refusals into ones that name the record.
 *
 * `writeChecks(prefix)` holds the checks that need no connection, `writeKit(sqlite, prefix)` adds the statements. Their
 * refusals are `${prefix}_INPUT_INVALID`, `_DUPLICATE` and `_STATE_CONFLICT`, and name tables, fields and ids, never a
 * value.
 */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : typeof v);
const SQLITE_CONSTRAINT = 19;
/** A constraint failure: CHECK, NOT NULL, UNIQUE, a foreign key, or a STRICT column refusing a value's type. */
const isConstraintError = (e) => e?.code === 'ERR_SQLITE_ERROR' && (e.errcode & 0xff) === SQLITE_CONSTRAINT;

export function writeChecks(prefix) {
  const refusal = (what, message) => { const code = `${prefix}_${what}`; return Object.assign(new Error(`${code}: ${message}`), { code }); };
  const invalid = (message) => refusal('INPUT_INVALID', message);

  /** Run one write of a record's rows; a constraint failure becomes a refusal naming the record and the part. */
  const rowStep = (table, id, part, fn) => {
    try { return fn(); } catch (e) {
      if (!isConstraintError(e)) throw e;
      throw invalid(`${table} ${id} ${part}: ${e.message}`);
    }
  };
  /** A record's child list: absent is empty, anything but a list is refused; with `objects`, so is an item that is not an object. */
  const listOf = (table, id, field, v, { objects = false } = {}) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw invalid(`${table} ${id} ${field}: must be a list (got ${describe(v)})`);
    if (objects) v.forEach((x, i) => { if (!isPlainObject(x)) throw invalid(`${table} ${id} ${field}[${i}]: must be an object (got ${describe(x)})`); });
    return v;
  };
  /**
   * A created record must read back as it was written. A field the tables have no column for, at any depth, or a value
   * a column coerced, is refused rather than silently lost. Absent and null written values say nothing and are skipped.
   */
  const readsBackAsWritten = (table, id, written, stored, path = '') => {
    if (written === undefined || written === null) return;
    const lost = () => invalid(`${table} ${id} ${path || 'record'}: is not stored as written`);
    if (Array.isArray(written)) {
      if (!Array.isArray(stored) || stored.length !== written.length) throw lost();
      written.forEach((v, i) => readsBackAsWritten(table, id, v, stored[i], `${path}[${i}]`));
    } else if (typeof written === 'object') {
      if (!isPlainObject(stored)) throw lost();
      for (const [k, v] of Object.entries(written)) readsBackAsWritten(table, id, v, stored[k], path ? `${path}.${k}` : k);
    } else if (written !== stored) throw lost();
  };
  /** A whole record handed to `create`: an object with an id that `exists` does not know. */
  const newRecord = (table, exists, r) => {
    if (!isPlainObject(r)) throw invalid(`${table}: a record must be an object (got ${describe(r)})`);
    if (typeof r.id !== 'string' || !r.id) throw invalid(`${table}: a record needs an id`);
    if (exists(r.id)) throw refusal('DUPLICATE', `${table} ${r.id} already exists`);
  };
  return { refusal, invalid, rowStep, listOf, readsBackAsWritten, newRecord };
}

export function writeKit(sqlite, prefix) {
  const checks = writeChecks(prefix);
  const { refusal } = checks;

  const cache = new Map();
  /** A prepared statement, prepared once per connection. */
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  /** An absent (`undefined`) column value is bound as NULL. */
  const absentAsNull = (cols) => Object.fromEntries(Object.entries(cols).map(([c, v]) => [c, v === undefined ? null : v]));
  const assign = (cols) => Object.keys(cols).map((c) => `${c} = @${c}`).join(', ');
  /** `col IN ('a','b')` over a domain vocabulary (its values are code constants, never input); an empty one holds for no row. */
  const sqlIn = (col, values) => (values.length ? `${col} IN (${values.map((v) => `'${v}'`).join(', ')})` : '0');
  /**
   * Update one row, matched by `keys`, only while `where` holds; `set` adds assignments computed in SQL (a rev bump).
   * No row means a route's gate let through a change it should have refused: `what` names the conflict and the unit
   * rolls back. With nothing to assign, the row is only required to be there.
   */
  const guarded = (table, keys, where, cols, what, { set = '' } = {}) => {
    const match = `${Object.keys(keys).map((c) => `${c} = @key_${c}`).join(' AND ')}${where ? ` AND (${where})` : ''}`;
    const params = Object.fromEntries(Object.entries(keys).map(([c, v]) => [`key_${c}`, v]));
    const assignments = [assign(cols), set].filter(Boolean).join(', ');
    const found = assignments
      ? q(`UPDATE ${table} SET ${assignments} WHERE ${match}`).run({ ...absentAsNull(cols), ...params }).changes === 1
      : !!q(`SELECT 1 FROM ${table} WHERE ${match}`).get(params);
    if (!found) throw refusal('STATE_CONFLICT', what);
  };
  /** The next free `position` of an owner's ordered child rows (within `scope`, extra key columns, when given). */
  const nextPosition = (table, owner, id, scope = {}) => {
    const extra = Object.keys(scope).map((c) => ` AND ${c} = @${c}`).join('');
    return q(`SELECT COALESCE(MAX(position) + 1, 0) AS p FROM ${table} WHERE ${owner} = @owner${extra}`).get({ owner: id, ...scope }).p;
  };

  return { ...checks, q, assign, sqlIn, guarded, nextPosition };
}
