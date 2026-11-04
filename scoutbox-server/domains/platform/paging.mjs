/**
 * The one paging convention for lists that grow without limit (migration.md §4.3 step 2): "continue from here".
 *
 *   GET …?limit=<1..100>&cursor=<opaque>  →  { items, nextCursor }
 *
 * `limit` defaults to 50. `cursor` is the `nextCursor` of the previous page, opaque to clients: the sort key of the
 * last row it returned. The repository asks for one row more than the page, so `nextCursor` is null exactly when
 * there is nothing after the page, and a row inserted while a client pages never shifts what it has not seen yet.
 * Junk is refused at the route (400), never clamped: a non-integer or out-of-range limit, or a cursor that does not
 * decode to the query's key shape.
 */
export const PAGE_LIMITS = Object.freeze({ default: 50, max: 100 });

const pageError = (error, message) => Object.assign(new Error(`${error}: ${message}`), { code: error, status: 400, pageError: true });

/** Encode a sort key (a short array of numbers and strings) as an opaque cursor. */
export const encodeCursor = (key) => Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');

/**
 * Read `limit` and `cursor` from a query string. `shape` lists the key's types in order (e.g. ['number', 'string']).
 * Returns `{ limit, after }` (`after` is the decoded key or null), or throws a 400 page error.
 */
export function readPage(query = {}, shape) {
  let limit = PAGE_LIMITS.default;
  if (query.limit !== undefined && query.limit !== '') {
    const n = Number(query.limit);
    if (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit) || !Number.isSafeInteger(n) || n < 1 || n > PAGE_LIMITS.max) throw pageError('PAGE_LIMIT_INVALID', `limit must be a whole number from 1 to ${PAGE_LIMITS.max}`);
    limit = n;
  }
  let after = null;
  if (query.cursor !== undefined && query.cursor !== '') {
    let key = null;
    try { key = typeof query.cursor === 'string' && query.cursor.length <= 512 ? JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) : null; } catch { key = null; }
    const fits = Array.isArray(key) && key.length === shape.length && key.every((v, i) => (shape[i] === 'number' ? Number.isSafeInteger(v) : typeof v === shape[i]));
    if (!fits) throw pageError('PAGE_CURSOR_INVALID', 'cursor is not a cursor this list handed out');
    after = key;
  }
  return { limit, after };
}

/** `rows` holds up to `limit + 1` rows in page order; `keyOf(row)` is the row's sort key. */
export function pageOf(rows, limit, keyOf) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(keyOf(items[items.length - 1])) : null };
}

/** Answer a page error as 400 `{ error, message }`; returns true when it did. Any other error is rethrown. */
export function sendPageError(res, e) {
  if (!e?.pageError) throw e;
  res.status(400).json({ error: e.code, message: e.message.slice(e.code.length + 2) });
  return true;
}

/**
 * Page a list that is already filtered and sorted in code (a filter SQL cannot express, e.g. a per-viewer access rule).
 * `cmpKey(a, b)` orders two keys exactly as the list is sorted; the page starts after `after`. The rows still come from
 * an indexed query (one organisation's), so this pages the response, not the read.
 */
export function pageSorted(rows, { limit, after = null }, keyOf, cmpKey) {
  const rest = after ? rows.filter((r) => cmpKey(keyOf(r), after) > 0) : rows;
  return pageOf(rest.slice(0, limit + 1), limit, keyOf);
}
