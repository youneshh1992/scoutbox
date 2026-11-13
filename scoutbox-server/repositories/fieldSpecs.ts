/**
 * Field specs: one description of a record's fields drives its typing, its row encoding and decoding, its DDL and its
 * TypeScript type (`RecordOf<typeof SPEC>`), so the four cannot drift.
 *
 * A field is `{ k, c, t, … }`: the record key `k`, the column `c` and the type `t` — `text` (with `max`, optionally
 * `nonEmpty`), `int`, `num` (a finite number, REAL), `bool`, `enum` (with `vals`) or `date` (a football date as given: 'YYYY', 'YYYY-MM' or
 * 'YYYY-MM-DD', a day that exists). `req` makes it required, `def` gives a default. A `group` is a nested object stored
 * as columns: `nullable` groups are null when their first column is; `sparse` objects keep only non-null keys.
 *
 * The constructors keep their keys, enum values and options as literal types, so a spec built from them describes its
 * record exactly; a spec written as plain objects types only as loosely as its literals were inferred.
 */
import type { SQLInputValue } from 'node:sqlite';
import type { Row } from './database.ts';

type FieldOptions = { req?: boolean; def?: string | number | boolean; nonEmpty?: boolean };
type GroupOptions = { nullable?: boolean; sparse?: boolean };
export type TextField = { k: string; c: string; t: 'text'; max: number } & FieldOptions;
export type IntField = { k: string; c: string; t: 'int' } & FieldOptions;
export type NumField = { k: string; c: string; t: 'num' } & FieldOptions;
export type BoolField = { k: string; c: string; t: 'bool' } & FieldOptions;
export type EnumField = { k: string; c: string; t: 'enum'; vals: readonly string[] } & FieldOptions;
export type DateField = { k: string; c: string; t: 'date' } & FieldOptions;
export type ScalarField = TextField | IntField | NumField | BoolField | EnumField | DateField;
export type GroupField = { k: string; group: Spec } & GroupOptions;
export type Field = ScalarField | GroupField;
export type Spec = readonly Field[];

/** What a scalar field holds when set. */
type ScalarValue<F> = F extends { t: 'text' | 'date' }
  ? string
  : F extends { t: 'int' | 'num' }
    ? number
    : F extends { t: 'bool' }
      ? boolean
      : F extends { t: 'enum'; vals: readonly (infer V)[] }
        ? V
        : never;
/** A sparse group's object: only its set keys. */
type SparseOf<S extends Spec> = { [F in S[number] as F['k']]?: NonNullable<ValueOf<F>> };
type GroupValue<F, S extends Spec> = F extends { sparse: true }
  ? F extends { nullable: true }
    ? SparseOf<S> | null
    : SparseOf<S>
  : F extends { nullable: true }
    ? RecordOf<S> | null
    : RecordOf<S>;
/** A field's value in its record: a required scalar is always set, any other may be null. */
type ValueOf<F> = F extends { group: infer S extends Spec }
  ? GroupValue<F, S>
  : F extends { req: true }
    ? ScalarValue<F>
    : ScalarValue<F> | null;
/** A nullable sparse group is left out when null, rather than written as null. */
type Omissible = { group: Spec; nullable: true; sparse: true };
type Flatten<T> = { [K in keyof T]: T[K] } & {};
/** The record a spec types, encodes and decodes. */
export type RecordOf<S extends Spec> = Flatten<
  { [F in S[number] as F extends Omissible ? never : F['k']]: ValueOf<F> } & {
    [F in S[number] as F extends Omissible ? F['k'] : never]?: ValueOf<F>;
  }
>;

/** A refused value: the record and field it was in and what was wrong, never its content. */
export type Refusal = { ok: false; reason: string };
export type Typed<R> = { ok: true; record: R } | Refusal;

/** How a refused value is named in an error: its kind, never its content. */
export const describe = (v: unknown): string =>
  v === null
    ? 'null'
    : v === undefined
      ? 'nothing'
      : Array.isArray(v)
        ? 'an array'
        : typeof v === 'object'
          ? 'an object'
          : `a ${typeof v}`;
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export const ids = (list: readonly string[]): string => list.slice(0, 20).join(', ') + (list.length > 20 ? ', …' : '');

// The options' defaults are `{}` so a field given none is optional and nullable.
export const text = <const K extends string, const O extends FieldOptions = {}>(
  k: K,
  c: string,
  max: number,
  o: O = {} as O,
) => ({ k, c, t: 'text' as const, max, ...o });
export const int = <const K extends string, const O extends FieldOptions = {}>(k: K, c: string, o: O = {} as O) => ({
  k,
  c,
  t: 'int' as const,
  ...o,
});
export const num = <const K extends string, const O extends FieldOptions = {}>(k: K, c: string, o: O = {} as O) => ({
  k,
  c,
  t: 'num' as const,
  ...o,
});
export const bool = <const K extends string, const O extends FieldOptions = {}>(k: K, c: string, o: O = {} as O) => ({
  k,
  c,
  t: 'bool' as const,
  ...o,
});
export const oneOf = <const K extends string, const V extends string, const O extends FieldOptions = {}>(
  k: K,
  c: string,
  vals: readonly V[],
  o: O = {} as O,
) => ({ k, c, t: 'enum' as const, vals, ...o });
export const date = <const K extends string, const O extends FieldOptions = {}>(k: K, c: string, o: O = {} as O) => ({
  k,
  c,
  t: 'date' as const,
  ...o,
});
export const group = <const K extends string, const S extends Spec, const O extends GroupOptions = {}>(
  k: K,
  fields: S,
  o: O = {} as O,
) => ({ k, group: fields, ...o });

// ------------------------------------------------------------------ DDL
export const flat = (spec: Spec): ScalarField[] => spec.flatMap((f) => ('group' in f ? flat(f.group) : [f]));
export const quote = (v: unknown): string => `'${String(v).replace(/'/g, "''")}'`;
const DATE_SQL = (c: string) =>
  `(${c} GLOB '[0-9][0-9][0-9][0-9]' OR ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')`;
export function columnDdl(f: ScalarField, { nullable = false } = {}): string {
  const notNull = f.req && !nullable;
  const nn = notNull ? ' NOT NULL' : '';
  const guard = (cond: string) => (notNull ? `CHECK (${cond})` : `CHECK (${f.c} IS NULL OR ${cond})`);
  if (f.t === 'text')
    return `TEXT${nn} ${guard(`length(${f.c}) <= ${f.max}${f.nonEmpty ? ` AND length(${f.c}) > 0` : ''}`)}`;
  if (f.t === 'int') return `INTEGER${nn}${f.def !== undefined ? ` DEFAULT ${f.def}` : ''}`;
  if (f.t === 'num') return `REAL${nn}`;
  if (f.t === 'bool') return `INTEGER${nn} ${guard(`${f.c} IN (0,1)`)}`;
  if (f.t === 'date') return `TEXT${nn} ${guard(DATE_SQL(f.c))}`;
  return `TEXT${nn} ${guard(`${f.c} IN (${f.vals.map(quote).join(',')})`)}`;
}
const columnsOf = (spec: Spec, inNullableGroup = false): { f: ScalarField; nullable: boolean }[] =>
  spec.flatMap((f) =>
    'group' in f ? columnsOf(f.group, inNullableGroup || !!f.nullable) : [{ f, nullable: inNullableGroup }],
  );
/** `CREATE TABLE` for a spec: its columns, then the given keys and table constraints. A column named `id` is the text primary key. */
export function tableDdl(name: string, spec: Spec, extra: readonly string[] = []): string {
  const cols = columnsOf(spec).map(
    ({ f, nullable }) =>
      `  ${f.c.padEnd(40)} ${f.c === 'id' ? 'TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80)' : columnDdl(f, { nullable })}`,
  );
  return `CREATE TABLE ${name} (\n${[...cols, ...extra.map((e) => `  ${e}`)].join(',\n')}\n) STRICT;`;
}

// ------------------------------------------------------------------ typing (the one place a value is judged)
export const bad = (at: string, field: string, what: string): Refusal => ({
  ok: false,
  reason: `${at}.${field} ${what}`,
});
/** Is `v` a football date as stored: 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD', with a month and day that exist? */
export function isFootballDate(v: unknown): v is string {
  const m = typeof v === 'string' ? /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(v) : null;
  if (!m) return false;
  if (m[2] === undefined) return true;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return false;
  if (m[3] === undefined) return true;
  const d = new Date(Date.UTC(Number(m[1]), month - 1, Number(m[3])));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === Number(m[3]);
}
export function typeScalar<F extends ScalarField>(
  f: F,
  v: unknown,
  at: string,
): { ok: true; value: ValueOf<F> } | Refusal {
  if (v === undefined && f.def !== undefined) v = f.def;
  if (v === undefined || v === null)
    return f.req ? bad(at, f.k, `is required (got ${describe(v)})`) : { ok: true, value: null as ValueOf<F> };
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
  } else if (!(f.vals as readonly unknown[]).includes(v))
    return bad(at, f.k, `must be one of ${f.vals.join('|')} (got ${describe(v)})`);
  return { ok: true, value: v as ValueOf<F> };
}
/** A sparse group's object: only its non-null keys. */
const setOnly = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== null));
/** Type `raw` against `spec`; `extra` lists keys the caller types itself. `{ ok, record }` or `{ ok: false, reason }` naming the field, never its content. */
export function typeSpec<S extends Spec>(
  spec: S,
  raw: unknown,
  at: string,
  extra: readonly string[] = [],
): Typed<RecordOf<S>> {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const known = new Set([...spec.map((f) => f.k), ...extra]);
  const unknown = Object.keys(raw).filter((k) => !known.has(k));
  if (unknown.length)
    return { ok: false, reason: `${at} carries field(s) this build does not store: ${unknown.join(', ')}` };
  const out: Record<string, unknown> = {};
  for (const f of spec) {
    const v = raw[f.k];
    if ('group' in f) {
      if (v === undefined || v === null) {
        if (f.nullable) {
          if (!f.sparse || v === null) out[f.k] = null;
          continue;
        }
        if (f.sparse) {
          const t = typeSpec(f.group, {}, `${at}.${f.k}`);
          if (!t.ok) return t;
          out[f.k] = setOnly(t.record);
          continue;
        }
        return bad(at, f.k, `is required (got ${describe(v)})`);
      }
      const t = typeSpec(f.group, v, `${at}.${f.k}`);
      if (!t.ok) return t;
      out[f.k] = f.sparse ? setOnly(t.record) : t.record;
      continue;
    }
    const t = typeScalar(f, v, at);
    if (!t.ok) return t;
    out[f.k] = t.value;
  }
  return { ok: true, record: out as RecordOf<S> };
}

// ------------------------------------------------------------------ rows
/** A record's columns, as statement parameters. `rec` is a typed record, or the part of one a statement writes. */
export const encode = (
  spec: Spec,
  rec: { readonly [k: string]: unknown },
  row: Record<string, SQLInputValue> = {},
): Record<string, SQLInputValue> => {
  for (const f of spec) {
    if ('group' in f) {
      encode(f.group, (rec[f.k] as { readonly [k: string]: unknown } | null | undefined) ?? {}, row);
      continue;
    }
    const v = rec[f.k];
    row[f.c] = v === undefined || v === null ? null : f.t === 'bool' ? (v ? 1 : 0) : (v as SQLInputValue);
  }
  return row;
};
export const decode = <S extends Spec>(spec: S, row: Row): RecordOf<S> => {
  const out: Record<string, unknown> = {};
  for (const f of spec) {
    if ('group' in f) {
      const inner = decode(f.group, row);
      if (f.nullable && row[(f.group[0] as ScalarField).c] === null) {
        if (!f.sparse) out[f.k] = null;
        continue;
      }
      out[f.k] = f.sparse ? setOnly(inner) : inner;
      continue;
    }
    const v = row[f.c];
    out[f.k] = v === null || v === undefined ? null : f.t === 'bool' ? v === 1 : v;
  }
  return out as RecordOf<S>;
};
export const insertSql = (table: string, spec: Spec): string => {
  const cols = flat(spec).map((f) => f.c);
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`;
};
export const upsertSql = (table: string, spec: Spec, key: readonly string[] = ['id']): string => {
  const cols = flat(spec).map((f) => f.c);
  return `${insertSql(table, spec)} ON CONFLICT(${key.join(', ')}) DO UPDATE SET ${cols
    .filter((c) => !key.includes(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')}`;
};
