// The one paging convention (domains/platform/paging.mjs): "continue from here". A missing limit is the default and a
// valid one is taken as given; a limit that is not a whole number from 1 to 100 is refused (never clamped); a cursor
// round-trips through encodeCursor, and one that does not decode to the list's key shape is refused; pageOf cuts the
// extra row and hands out the last item's key exactly when there is more; sendPageError answers 400 with the code and
// rethrows anything else. Run with: npm test
import assert from 'node:assert/strict';
import { PAGE_LIMITS, readPage, encodeCursor, pageOf, sendPageError } from '../domains/platform/paging.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const refused = (query, shape, code) => {
  let err = null;
  try {
    readPage(query, shape);
  } catch (e) {
    err = e;
  }
  assert.ok(err?.pageError, `${JSON.stringify(query)}: refused`);
  assert.equal(err.code, code);
  assert.equal(err.status, 400);
};

test('limit: absent or empty is the default; a whole number from 1 to 100 is taken; anything else is refused with PAGE_LIMIT_INVALID', () => {
  assert.deepEqual(readPage({}, ['number']), { limit: PAGE_LIMITS.default, after: null });
  assert.deepEqual(readPage({ limit: '' }, ['number']), { limit: 50, after: null });
  for (const n of ['1', '37', '100']) assert.equal(readPage({ limit: n }, ['number']).limit, Number(n));
  for (const bad of ['0', '101', '-1', '2.5', 'ten', ' 5', '1e2', ['5'], '99999999999999999999'])
    refused({ limit: bad }, ['number'], 'PAGE_LIMIT_INVALID');
});

test('cursor: encodeCursor round-trips through readPage for the shape it was made for; a cursor of another shape, a non-integer number, junk, an array query value or an over-long string is refused with PAGE_CURSOR_INVALID', () => {
  assert.deepEqual(readPage({ cursor: encodeCursor([1700000000000, 'fup-9']) }, ['number', 'string']).after, [
    1700000000000,
    'fup-9',
  ]);
  assert.deepEqual(readPage({ cursor: encodeCursor([12]), limit: '5' }, ['number']), { limit: 5, after: [12] });
  for (const bad of [
    encodeCursor([12]),
    encodeCursor(['x', 'y']),
    encodeCursor([1.5, 'a']),
    encodeCursor({ a: 1 }),
    encodeCursor([1, 'a', 2]),
    'not base64 at all!',
    Buffer.from('not json').toString('base64url'),
    [encodeCursor([1, 'a'])],
    'x'.repeat(600),
  ])
    refused({ cursor: bad }, ['number', 'string'], 'PAGE_CURSOR_INVALID');
});

test("pageOf: up to limit items; nextCursor is the last item's key when there was one row more, else null", () => {
  const rows = [{ k: 1 }, { k: 2 }, { k: 3 }];
  const more = pageOf(rows, 2, (r) => [r.k]);
  assert.deepEqual(more.items, [{ k: 1 }, { k: 2 }]);
  assert.deepEqual(readPage({ cursor: more.nextCursor }, ['number']).after, [2]);
  assert.deepEqual(
    pageOf(rows, 3, (r) => [r.k]),
    { items: rows, nextCursor: null },
  );
  assert.deepEqual(
    pageOf([], 3, (r) => [r.k]),
    { items: [], nextCursor: null },
  );
});

test('sendPageError: a page error is a 400 { error, message } without the code repeated; any other error is rethrown', () => {
  const sent = {};
  const res = {
    status(n) {
      sent.status = n;
      return this;
    },
    json(b) {
      sent.body = b;
      return this;
    },
  };
  let err = null;
  try {
    readPage({ limit: '0' }, ['number']);
  } catch (e) {
    err = e;
  }
  assert.equal(sendPageError(res, err), true);
  assert.equal(sent.status, 400);
  assert.equal(sent.body.error, 'PAGE_LIMIT_INVALID');
  assert.match(sent.body.message, /^limit must be a whole number from 1 to 100$/);
  assert.throws(() => sendPageError(res, new Error('other')), /other/);
});

console.log(`${passed} paging checks passed`);
