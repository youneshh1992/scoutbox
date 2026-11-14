/**
 * The write kit of the repositories whose records change through named acts (docs/architecture.md, Writes): a record
 * is created whole and must read back as written, then each act is an UPDATE or INSERT of the rows it concerns. The
 * tables' columns and keys judge the values; this module turns their refusals into ones that name the record.
 *
 * `writeChecks(prefix)` holds the checks that need no connection, `writeKit(sqlite, prefix)` adds the statements. Their
 * refusals are `${prefix}_INPUT_INVALID`, `_DUPLICATE` and `_STATE_CONFLICT`, and name tables, fields and ids, never a
 * value.
 */
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type { Operation } from './database.ts';

/**
 * One field of a record (repositories/fieldSpecs.ts): its key `k`, column `c` and type `t`, or a `group` of fields
 * stored as columns. The other options (`max`, `req`, `vals`, …) are the field spec's own.
 */
export type FieldSpec = {
  k: string;
  c?: string;
  t?: 'text' | 'int' | 'num' | 'bool' | 'enum' | 'date';
  def?: unknown;
  group?: FieldSpec[];
  [option: string]: unknown;
};
/** A refusal: its `code` is `${prefix}_INPUT_INVALID`, `_DUPLICATE` or `_STATE_CONFLICT`. */
export type Refusal = Error & { code: string };
/** A record kind's history (`actsOn`): its table, owner column, the typer of one entry, and the row it writes. */
export type History<E extends { id: string }> = {
  table: string;
  owner: string;
  type(entry: unknown, at: string): { ok: true; record: E } | { ok: false; reason: string };
  insert: string;
  row(owner: string, entry: E, position: number): Record<string, SQLInputValue>;
};
/** One named act's own writes. */
type ActDef<R> = (id: string, input: never, stored: R) => void;
/** The acts `actsOn` returns: each takes the record's id, the act's input and its history entries, and returns the stored record. */
export type Acts<R, D extends Record<string, ActDef<R>>> = {
  [K in keyof D]: (id: string, input?: Parameters<D[K]>[1], bookkeeping?: { history?: unknown[] }) => R;
};

export type Flatten<T> = { [K in keyof T]: T[K] } & {};
type Omissible<V> = null extends V ? true : V extends readonly unknown[] ? true : false;
/** What a writer passes for a record: a field that may be null, and a list, may be left out, at any depth. */
export type InputFor<T> = T extends readonly (infer E)[]
  ? InputFor<E>[]
  : T extends object
    ? Flatten<
        { [K in keyof T as Omissible<T[K]> extends true ? never : K]: InputFor<T[K]> } & {
          [K in keyof T as Omissible<T[K]> extends true ? K : never]?: InputFor<T[K]>;
        }
      >
    : T;
/** A row as read back: each column an encoder writes, an absent value NULL. */
export type RowOf<F extends (...args: never[]) => object> = {
  [K in keyof ReturnType<F>]-?:
    | Exclude<ReturnType<F>[K], undefined>
    | (undefined extends ReturnType<F>[K] ? null : never);
};
/** A table's columns, which the compiler holds to its encoder's row: none missing, none extra. */
export const columnsOf =
  <R>() =>
  <const C extends readonly (keyof R & string)[]>(
    cols: C & ([Exclude<keyof R, C[number]>] extends [never] ? unknown : never),
  ): readonly string[] =>
    cols;
/** An INSERT of `cols` bound by name; with `upsert`, a row with that key has its other columns replaced. */
export const insertFor = (
  sqlite: DatabaseSync,
  table: string,
  cols: readonly string[],
  { upsert = null }: { upsert?: readonly string[] | null } = {},
): StatementSync =>
  sqlite.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})${
      upsert
        ? ` ON CONFLICT(${upsert.join(', ')}) DO UPDATE SET ${cols
            .filter((c) => !upsert.includes(c))
            .map((c) => `${c} = excluded.${c}`)
            .join(', ')}`
        : ''
    }`,
  );
/** Bind an absent field as NULL. */
export const nulls = (row: object): Record<string, SQLInputValue> => {
  const r = row as Record<string, SQLInputValue | undefined>;
  for (const k of Object.keys(r)) if (r[k] === undefined) r[k] = null;
  return r as Record<string, SQLInputValue>;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const describe = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : typeof v;
const SQLITE_CONSTRAINT = 19;
/** A constraint failure: CHECK, NOT NULL, UNIQUE, a foreign key, or a STRICT column refusing a value's type. */
export const isConstraintError = (e: unknown): e is Error & { code: string; errcode: number } =>
  (e as { code?: unknown })?.code === 'ERR_SQLITE_ERROR' &&
  ((e as { errcode: number }).errcode & 0xff) === SQLITE_CONSTRAINT;

export function writeChecks(prefix: string) {
  const refusal = (what: 'INPUT_INVALID' | 'DUPLICATE' | 'STATE_CONFLICT', message: string): Refusal => {
    const code = `${prefix}_${what}`;
    return Object.assign(new Error(`${code}: ${message}`), { code });
  };
  const invalid = (message: string) => refusal('INPUT_INVALID', message);

  /** Run one write of a record's rows; a constraint failure becomes a refusal naming the record and the part. */
  const rowStep = <T>(table: string, id: string, part: string, fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (!isConstraintError(e)) throw e;
      throw invalid(`${table} ${id} ${part}: ${e.message}`);
    }
  };
  /** A record's child list: absent is empty, anything but a list is refused; with `objects`, so is an item that is not an object. */
  const listOf = (table: string, id: string, field: string, v: unknown, { objects = false } = {}): unknown[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw invalid(`${table} ${id} ${field}: must be a list (got ${describe(v)})`);
    if (objects)
      v.forEach((x, i) => {
        if (!isPlainObject(x)) throw invalid(`${table} ${id} ${field}[${i}]: must be an object (got ${describe(x)})`);
      });
    return v;
  };
  /**
   * A created record must read back as it was written. A field the tables have no column for, at any depth, or a value
   * a column coerced, is refused rather than silently lost. Absent and null written values say nothing and are skipped.
   */
  const readsBackAsWritten = (table: string, id: string, written: unknown, stored: unknown, path = ''): void => {
    if (written === undefined || written === null) return;
    const lost = () => invalid(`${table} ${id} ${path || 'record'}: is not stored as written`);
    if (Array.isArray(written)) {
      if (!Array.isArray(stored) || stored.length !== written.length) throw lost();
      written.forEach((v, i) => readsBackAsWritten(table, id, v, stored[i], `${path}[${i}]`));
    } else if (typeof written === 'object') {
      if (!isPlainObject(stored)) throw lost();
      for (const [k, v] of Object.entries(written))
        readsBackAsWritten(table, id, v, stored[k], path ? `${path}.${k}` : k);
    } else if (written !== stored) throw lost();
  };
  /** A whole record handed to `create`: an object with an id that `exists` does not know. */
  const newRecord: (
    table: string,
    exists: (id: string) => unknown,
    r: unknown,
  ) => asserts r is { id: string; [field: string]: unknown } = (table, exists, r) => {
    if (!isPlainObject(r)) throw invalid(`${table}: a record must be an object (got ${describe(r)})`);
    if (typeof r.id !== 'string' || !r.id) throw invalid(`${table}: a record needs an id`);
    if (exists(r.id)) throw refusal('DUPLICATE', `${table} ${r.id} already exists`);
  };
  /**
   * A record's columns from its field spec (repositories/fieldSpecs.ts): a group fills all its columns (absent ones
   * NULL, or the field's `def` with `defaults`), a boolean is 0 or 1, and any other value is bound as given for the
   * column to judge. An object where a single value goes is refused (the binding cannot take it). With `only`, just the
   * fields given are mapped, and each must be one of those named.
   */
  const columnsOf = (
    table: string,
    id: string,
    spec: readonly FieldSpec[],
    fields: Record<string, unknown> | null | undefined,
    { only = null, defaults = false }: { only?: ReadonlySet<string> | null; defaults?: boolean } = {},
  ): Record<string, unknown> => {
    const cols: Record<string, unknown> = {};
    const put = (f: FieldSpec, v: unknown, at: string) => {
      if (f.group) {
        if (v !== undefined && v !== null && !isPlainObject(v))
          throw invalid(`${table} ${id} ${at}: must be an object (got ${describe(v)})`);
        for (const g of f.group) put(g, (v as Record<string, unknown> | null | undefined)?.[g.k], `${at}.${g.k}`);
        return;
      }
      if (v !== null && typeof v === 'object')
        throw invalid(`${table} ${id} ${at}: must be a single value (got ${describe(v)})`);
      // A field outside a group always names its column.
      cols[f.c as string] =
        v === undefined || v === null
          ? defaults && f.def !== undefined
            ? f.def
            : null
          : f.t === 'bool' && typeof v === 'boolean'
            ? v
              ? 1
              : 0
            : v;
    };
    if (only) {
      for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
        const f = spec.find((x) => x.k === k);
        if (!f || !only.has(k)) throw invalid(`${table} ${id}: ${k} is not a field this act sets`);
        put(f, v, k);
      }
    } else for (const f of spec) put(f, fields?.[f.k], f.k);
    return cols;
  };
  return { refusal, invalid, rowStep, listOf, readsBackAsWritten, newRecord, columnsOf };
}

export function writeKit(sqlite: DatabaseSync, prefix: string) {
  const checks = writeChecks(prefix);
  const { refusal } = checks;

  const cache = new Map<string, StatementSync>();
  /** A prepared statement, prepared once per connection. */
  const q = (sql: string): StatementSync => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  /** An absent (`undefined`) column value is bound as NULL. */
  // The values are bound as given: the column, not this kit, judges them.
  const absentAsNull = (cols: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(cols).map(([c, v]) => [c, v === undefined ? null : v])) as Record<
      string,
      SQLInputValue
    >;
  const assign = (cols: Record<string, unknown>) =>
    Object.keys(cols)
      .map((c) => `${c} = @${c}`)
      .join(', ');
  /** `col IN ('a','b')` over a domain vocabulary (its values are code constants, never input); an empty one holds for no row. */
  const sqlIn = (col: string, values: readonly string[]) =>
    values.length ? `${col} IN (${values.map((v) => `'${v}'`).join(', ')})` : '0';
  /**
   * Update one row, matched by `keys`, only while `where` holds; `set` adds assignments computed in SQL (a rev bump).
   * No row means a route's gate let through a change it should have refused: `what` names the conflict and the unit
   * rolls back. With nothing to assign, the row is only required to be there.
   */
  const guarded = (
    table: string,
    keys: Record<string, SQLInputValue>,
    where: string,
    cols: Record<string, unknown>,
    what: string,
    { set = '' } = {},
  ): void => {
    const match = `${Object.keys(keys)
      .map((c) => `${c} = @key_${c}`)
      .join(' AND ')}${where ? ` AND (${where})` : ''}`;
    const params = Object.fromEntries(Object.entries(keys).map(([c, v]) => [`key_${c}`, v]));
    const assignments = [assign(cols), set].filter(Boolean).join(', ');
    const found = assignments
      ? q(`UPDATE ${table} SET ${assignments} WHERE ${match}`).run({ ...absentAsNull(cols), ...params }).changes === 1
      : !!q(`SELECT 1 FROM ${table} WHERE ${match}`).get(params);
    if (!found) throw refusal('STATE_CONFLICT', what);
  };
  /** The next free `position` of an owner's ordered child rows (within `scope`, extra key columns, when given). */
  const nextPosition = (
    table: string,
    owner: string,
    id: string,
    scope: Record<string, SQLInputValue> = {},
  ): number => {
    const extra = Object.keys(scope)
      .map((c) => ` AND ${c} = @${c}`)
      .join('');
    return (
      q(`SELECT COALESCE(MAX(position) + 1, 0) AS p FROM ${table} WHERE ${owner} = @owner${extra}`).get({
        owner: id,
        ...scope,
      }) as { p: number }
    ).p;
  };

  /**
   * Named acts on one record kind, each `act(id, input, bookkeeping)`: the act's own writes (`fn(id, input, stored)`),
   * then the bookkeeping's history entries, inserted after the stored ones, in one operation that returns the stored
   * record. A value a column refuses names the record and the act. `history`, when the kind has one, is its table,
   * owner column, the typer of one entry (`(entry, at) => { ok, record } | { ok: false, reason }`) and the row it writes.
   */
  const actsOn = <R, D extends Record<string, ActDef<R>>, E extends { id: string } = { id: string }>(
    {
      operation,
      label,
      must,
      history = null,
    }: { operation: Operation; label: string; must: (id: string) => R; history?: History<E> | null },
    defs: D,
  ): Acts<R, D> =>
    Object.fromEntries(
      Object.entries(defs).map(([name, fn]) => [
        name,
        (id: string, input: unknown = {}, { history: entries = [] }: { history?: unknown[] } = {}) =>
          operation(() => {
            const stored = must(id);
            if (entries.length && !history) throw checks.invalid(`${label} ${id}: ${name} keeps no history`);
            // From here on, entries are only typed and written when the kind keeps a history (checked above).
            const typed = checks.listOf(label, id, 'history', entries, { objects: true }).map((h, i) => {
              const t = history!.type(h, `${label} ${id} history[${i}]`);
              if (!t.ok) throw checks.invalid(t.reason);
              return t.record;
            });
            checks.rowStep(label, id, name, () => {
              fn(id, input as never, stored);
              let position = typed.length ? nextPosition(history!.table, history!.owner, id) : 0;
              for (const h of typed) {
                if (q(`SELECT 1 FROM ${history!.table} WHERE id = ?`).get(h.id))
                  throw refusal('DUPLICATE', `history entry ${h.id} already exists`);
                q(history!.insert).run(history!.row(id, h, position++));
              }
            });
            return must(id);
          }),
      ]),
    ) as Acts<R, D>;

  return { ...checks, q, assign, sqlIn, guarded, nextPosition, actsOn };
}
