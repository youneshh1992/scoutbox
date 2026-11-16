// Test helper: a battery's view of what a server run left in its database, as stored rows read with plain SQL, so it
// does not depend on the server's language. The reading half of sqlFixture.mjs: rows come back exactly as stored
// (column names, types, JSON still as text), never in a repository's shapes.
//
//   const R = readRows(dir);   R.rows('table', { column: value }); R.row(…); R.count(…); R.all(); R.close();
//   rows(dir, 'table', where)  one read, then closed
//
// `where` matches each column exactly: `null` is IS NULL, an array is IN. A table or column the schema doesn't have
// throws, so a misspelt name can't read as "no rows". Rows come back in primary-key order unless `order` says
// otherwise (`{ order: 'at DESC, id' }`, raw SQL).
//
// A directory with no database yet reads as a fresh one (the migrated schema, as the fixture writer creates it).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openFixture } from './sqlFixture.mjs';

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;

/** A stored JSON column's value: `null` stays `null`, text is parsed. */
export const json = (text) => (text == null ? null : JSON.parse(text));

/** Open `dataDir` read-only. Nothing is written, and no server needs to be stopped first (the database is in WAL mode). */
export function readRows(dataDir) {
  const file = path.join(dataDir, 'scoutbox.db');
  if (!fs.existsSync(file)) openFixture(dataDir).close();
  const sql = new DatabaseSync(file, { readOnly: true });
  const columns = new Map();
  const info = (table) => {
    if (!columns.has(table)) {
      const cols = sql.prepare(`PRAGMA table_info(${quote(table)})`).all();
      if (!cols.length) throw new Error(`sqlRows: no table ${table}`);
      columns.set(table, cols);
    }
    return columns.get(table);
  };
  const query = (table, where = {}, { order = null, select = '*' } = {}) => {
    const cols = info(table);
    const known = new Set(cols.map((c) => c.name));
    const clauses = [];
    const args = [];
    for (const [col, v] of Object.entries(where)) {
      if (!known.has(col)) throw new Error(`sqlRows: ${table} has no column ${col}`);
      if (v === null) clauses.push(`${quote(col)} IS NULL`);
      else if (Array.isArray(v)) {
        clauses.push(v.length ? `${quote(col)} IN (${v.map(() => '?').join(', ')})` : '0');
        args.push(...v);
      } else {
        clauses.push(`${quote(col)} = ?`);
        args.push(v);
      }
    }
    const pk = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => quote(c.name));
    const orderBy = order ?? (pk.length ? pk.join(', ') : 'rowid');
    const text = `SELECT ${select} FROM ${quote(table)}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${orderBy}`;
    return sql.prepare(text).all(...args);
  };
  const R = {
    sql,
    /** Every row of `table` matching `where`. */
    rows: (table, where = {}, opts = {}) => query(table, where, opts).map((r) => ({ ...r })),
    /** The one row matching `where`, or `null`; more than one throws. */
    row(table, where = {}) {
      const found = R.rows(table, where);
      if (found.length > 1) throw new Error(`sqlRows: ${found.length} rows of ${table} match ${JSON.stringify(where)}`);
      return found[0] ?? null;
    },
    count: (table, where = {}) => query(table, where, { select: 'COUNT(*) AS n', order: 'n' })[0].n,
    /** The tables, in name order. */
    tables: () =>
      sql
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((t) => t.name),
    /** Every table's rows, `{ table: [row, …] }`: a whole-database snapshot to compare before and after. */
    all: () => Object.fromEntries(R.tables().map((t) => [t, R.rows(t)])),
    close: () => sql.close(),
  };
  return R;
}

/** One read of `table`, then closed. */
export function rows(dataDir, table, where = {}, opts = {}) {
  const R = readRows(dataDir);
  try {
    return R.rows(table, where, opts);
  } finally {
    R.close();
  }
}
