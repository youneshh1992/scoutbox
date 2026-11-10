/**
 * Field specs: one description of a record's fields drives its typing, its row encoding and decoding, and its DDL, so
 * the three cannot drift.
 *
 * A field is `{ k, c, t, … }`: the record key `k`, the column `c` and the type `t` — `text` (with `max`, optionally
 * `nonEmpty`), `int`, `num` (a finite number, REAL), `bool`, `enum` (with `vals`) or `date` (a football date as given: 'YYYY', 'YYYY-MM' or
 * 'YYYY-MM-DD', a day that exists). `req` makes it required, `def` gives a default. A `group` is a nested object stored
 * as columns: `nullable` groups are null when their first column is; `sparse` objects keep only non-null keys.
 */
import { isPlainObject, describe } from './recruitment.mjs';

export const text = (k, c, max, o = {}) => ({ k, c, t: 'text', max, ...o });
export const int = (k, c, o = {}) => ({ k, c, t: 'int', ...o });
export const num = (k, c, o = {}) => ({ k, c, t: 'num', ...o });
export const bool = (k, c, o = {}) => ({ k, c, t: 'bool', ...o });
export const oneOf = (k, c, vals, o = {}) => ({ k, c, t: 'enum', vals, ...o });
export const date = (k, c, o = {}) => ({ k, c, t: 'date', ...o });
export const group = (k, fields, o = {}) => ({ k, group: fields, ...o });

// ------------------------------------------------------------------ DDL
export const flat = (spec) => spec.flatMap((f) => (f.group ? flat(f.group) : [f]));
export const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;
const DATE_SQL = (c) =>
  `(${c} GLOB '[0-9][0-9][0-9][0-9]' OR ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')`;
export function columnDdl(f, { nullable = false } = {}) {
  const notNull = f.req && !nullable;
  const nn = notNull ? ' NOT NULL' : '';
  const guard = (cond) => (notNull ? `CHECK (${cond})` : `CHECK (${f.c} IS NULL OR ${cond})`);
  if (f.t === 'text')
    return `TEXT${nn} ${guard(`length(${f.c}) <= ${f.max}${f.nonEmpty ? ` AND length(${f.c}) > 0` : ''}`)}`;
  if (f.t === 'int') return `INTEGER${nn}${f.def !== undefined ? ` DEFAULT ${f.def}` : ''}`;
  if (f.t === 'num') return `REAL${nn}`;
  if (f.t === 'bool') return `INTEGER${nn} ${guard(`${f.c} IN (0,1)`)}`;
  if (f.t === 'date') return `TEXT${nn} ${guard(DATE_SQL(f.c))}`;
  return `TEXT${nn} ${guard(`${f.c} IN (${f.vals.map(quote).join(',')})`)}`;
}
const columnsOf = (spec, inNullableGroup = false) =>
  spec.flatMap((f) =>
    f.group ? columnsOf(f.group, inNullableGroup || !!f.nullable) : [{ f, nullable: inNullableGroup }],
  );
/** `CREATE TABLE` for a spec: its columns, then the given keys and table constraints. A column named `id` is the text primary key. */
export function tableDdl(name, spec, extra = []) {
  const cols = columnsOf(spec).map(
    ({ f, nullable }) =>
      `  ${f.c.padEnd(40)} ${f.c === 'id' ? 'TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80)' : columnDdl(f, { nullable })}`,
  );
  return `CREATE TABLE ${name} (\n${[...cols, ...extra.map((e) => `  ${e}`)].join(',\n')}\n) STRICT;`;
}

// ------------------------------------------------------------------ typing (the one place a value is judged)
export const bad = (at, field, what) => ({ ok: false, reason: `${at}.${field} ${what}` });
/** Is `v` a football date as stored: 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD', with a month and day that exist? */
export function isFootballDate(v) {
  const m = typeof v === 'string' ? /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(v) : null;
  if (!m) return false;
  if (m[2] === undefined) return true;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return false;
  if (m[3] === undefined) return true;
  const d = new Date(Date.UTC(Number(m[1]), month - 1, Number(m[3])));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === Number(m[3]);
}
export function typeScalar(f, v, at) {
  if (v === undefined && f.def !== undefined) v = f.def;
  if (v === undefined || v === null)
    return f.req ? bad(at, f.k, `is required (got ${describe(v)})`) : { ok: true, value: null };
  if (f.t === 'text') {
    if (typeof v !== 'string') return bad(at, f.k, `must be text (got ${describe(v)})`);
    if (v.length > f.max) return bad(at, f.k, `exceeds ${f.max} characters`);
    if (f.nonEmpty && !v.length) return bad(at, f.k, 'must not be empty');
  } else if (f.t === 'int') {
    if (!Number.isSafeInteger(v)) return bad(at, f.k, `must be an integer (got ${describe(v)})`);
  } else if (f.t === 'num') {
    if (typeof v !== 'number' || !Number.isFinite(v))
      return bad(at, f.k, `must be a finite number (got ${describe(v)})`);
  } else if (f.t === 'bool') {
    if (typeof v !== 'boolean') return bad(at, f.k, `must be true or false (got ${describe(v)})`);
  } else if (f.t === 'date') {
    if (!isFootballDate(v))
      return bad(at, f.k, `must be a date written YYYY, YYYY-MM or YYYY-MM-DD (got ${describe(v)})`);
  } else if (!f.vals.includes(v)) return bad(at, f.k, `must be one of ${f.vals.join('|')} (got ${describe(v)})`);
  return { ok: true, value: v };
}
/** Type `raw` against `spec`; `extra` lists keys the caller types itself. `{ ok, record }` or `{ ok: false, reason }` naming the field, never its content. */
export function typeSpec(spec, raw, at, extra = []) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const known = new Set([...spec.map((f) => f.k), ...extra]);
  const unknown = Object.keys(raw).filter((k) => !known.has(k));
  if (unknown.length)
    return { ok: false, reason: `${at} carries field(s) this build does not store: ${unknown.join(', ')}` };
  const out = {};
  for (const f of spec) {
    const v = raw[f.k];
    if (f.group) {
      if (v === undefined || v === null) {
        if (f.nullable) {
          if (!f.sparse || v === null) out[f.k] = null;
          continue;
        }
        if (f.sparse) {
          const t = typeSpec(f.group, {}, `${at}.${f.k}`);
          if (!t.ok) return t;
          out[f.k] = t.record;
          continue;
        }
        return bad(at, f.k, `is required (got ${describe(v)})`);
      }
      const t = typeSpec(f.group, v, `${at}.${f.k}`);
      if (!t.ok) return t;
      out[f.k] = f.sparse ? Object.fromEntries(Object.entries(t.record).filter(([, x]) => x !== null)) : t.record;
      continue;
    }
    const t = typeScalar(f, v, at);
    if (!t.ok) return t;
    out[f.k] = t.value;
  }
  return { ok: true, record: out };
}

// ------------------------------------------------------------------ rows
export const encode = (spec, rec, row = {}) => {
  for (const f of spec) {
    if (f.group) {
      encode(f.group, rec[f.k] ?? {}, row);
      continue;
    }
    const v = rec[f.k];
    row[f.c] = v === undefined || v === null ? null : f.t === 'bool' ? (v ? 1 : 0) : v;
  }
  return row;
};
export const decode = (spec, row) => {
  const out = {};
  for (const f of spec) {
    if (f.group) {
      const inner = decode(f.group, row);
      if (f.nullable && row[f.group[0].c] === null) {
        if (!f.sparse) out[f.k] = null;
        continue;
      }
      out[f.k] = f.sparse ? Object.fromEntries(Object.entries(inner).filter(([, x]) => x !== null)) : inner;
      continue;
    }
    const v = row[f.c];
    out[f.k] = v === null || v === undefined ? null : f.t === 'bool' ? v === 1 : v;
  }
  return out;
};
export const insertSql = (table, spec) => {
  const cols = flat(spec).map((f) => f.c);
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`;
};
export const upsertSql = (table, spec, key = ['id']) => {
  const cols = flat(spec).map((f) => f.c);
  return `${insertSql(table, spec)} ON CONFLICT(${key.join(', ')}) DO UPDATE SET ${cols
    .filter((c) => !key.includes(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')}`;
};
