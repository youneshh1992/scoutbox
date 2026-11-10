/**
 * Cursor paging: `?limit=<1..100>&cursor=<opaque>` → `{ items, nextCursor }`. The cursor is the last row's sort key,
 * so a row inserted mid-paging never shifts what the client has not seen. Junk is refused (400), never clamped.
 */
/** The older offset convention, unlike cursors, clamps junk to the defaults. */
export const offsetPage = (req) => {
  const limit = Math.min(Math.max(Math.floor(Number(req.query?.limit)) || 50, 1), 200);
  const offset = Math.max(Math.floor(Number(req.query?.offset)) || 0, 0);
  return { limit, offset: Number.isSafeInteger(offset) ? offset : 0 };
};

export const PAGE_LIMITS = Object.freeze({ default: 50, max: 100 });

const pageError = (error, message) =>
  Object.assign(new Error(`${error}: ${message}`), { code: error, status: 400, pageError: true });

export const encodeCursor = (key) => Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');

/** `shape` lists the key's types in order, e.g. ['number', 'string']. Throws a 400 page error on junk. */
export function readPage(query = {}, shape) {
  let limit = PAGE_LIMITS.default;
  if (query.limit !== undefined && query.limit !== '') {
    const n = Number(query.limit);
    if (
      typeof query.limit !== 'string' ||
      !/^\d+$/.test(query.limit) ||
      !Number.isSafeInteger(n) ||
      n < 1 ||
      n > PAGE_LIMITS.max
    )
      throw pageError('PAGE_LIMIT_INVALID', `limit must be a whole number from 1 to ${PAGE_LIMITS.max}`);
    limit = n;
  }
  let after = null;
  if (query.cursor !== undefined && query.cursor !== '') {
    let key = null;
    try {
      key =
        typeof query.cursor === 'string' && query.cursor.length <= 512
          ? JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))
          : null;
    } catch {
      key = null;
    }
    const fits =
      Array.isArray(key) &&
      key.length === shape.length &&
      key.every((v, i) => (shape[i] === 'number' ? Number.isSafeInteger(v) : typeof v === shape[i]));
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

/** Any other error is rethrown. */
export function sendPageError(res, e) {
  if (!e?.pageError) throw e;
  res.status(400).json({ error: e.code, message: e.message.slice(e.code.length + 2) });
  return true;
}

/**
 * For lists filtered in code by a rule SQL cannot express, such as per-viewer access. `cmpKey` must order keys
 * exactly as the list is sorted. This pages the response, not the read.
 */
export function pageSorted(rows, { limit, after = null }, keyOf, cmpKey) {
  const rest = after ? rows.filter((r) => cmpKey(keyOf(r), after) > 0) : rows;
  return pageOf(rest.slice(0, limit + 1), limit, keyOf);
}
