// The input-schema layer (domains/platform/schemas.mjs): a strict object refuses fields it doesn't declare and
// returns only the ones it does, unchanged; nothing is coerced; dates and instants are refused with their temporal
// codes; the refusal names the field by its path and never quotes the value sent; a domain can rename the codes; and
// inputOrRefuse answers the 400 itself. Run with: npm test
import assert from 'node:assert/strict';
import * as v from 'valibot';
import {
  ID_MAX,
  dateOnly,
  dayOrBlank,
  dueDate,
  flag,
  id,
  idList,
  inputOrRefuse,
  instant,
  oneOf,
  parseInput,
  requiredText,
  text,
  wholeNumber,
} from '../domains/platform/schemas.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const Body = v.strictObject({
  title: requiredText(40),
  note: v.optional(text(100)),
  urgent: v.optional(flag),
  count: v.optional(wholeNumber({ min: 1, max: 10 })),
  kind: v.optional(oneOf(['trial', 'visit'])),
  ownerId: v.optional(id),
  playerIds: v.optional(idList(3)),
  startsOn: v.optional(dateOnly),
  at: v.optional(instant),
  documents: v.optional(v.array(v.strictObject({ evidenceId: id }))),
});

const refusal = (input, schema = Body, options) => {
  const r = parseInput(schema, input, options);
  assert.equal(r.ok, false, `${JSON.stringify(input)}: refused`);
  return r;
};

test('a valid body comes back with exactly the declared fields, unchanged, and absent optional fields stay absent', () => {
  const input = {
    title: 'Trial day',
    urgent: false,
    count: 3,
    kind: 'trial',
    playerIds: ['pl-1001'],
    startsOn: '2026-11-20',
    at: '2026-11-20T10:00:00Z',
    documents: [{ evidenceId: 'ev-1' }],
  };
  const r = parseInput(Body, input);
  assert.deepEqual(r, { ok: true, value: input });
  assert.equal('note' in r.value, false);
  assert.notEqual(r.value, input, 'a copy, not the request object');
});

test('a field the schema does not declare is refused by name, including inherited and prototype keys', () => {
  for (const key of ['titel', 'constructor', '__proto__', 'toString']) {
    const r = refusal(JSON.parse(`{"title":"x",${JSON.stringify(key)}:1}`));
    assert.equal(r.error, 'FIELD_INVALID');
    assert.equal(r.field, key);
    assert.equal(r.message, `${key} is not a field this request takes.`);
  }
});

test('a missing required field, or a body that is not an object, is refused naming the field or the body', () => {
  assert.deepEqual(refusal({}), {
    ok: false,
    error: 'FIELD_INVALID',
    field: 'title',
    message: 'title is required.',
  });
  for (const body of [undefined, null, 'title', [], 7]) assert.equal(refusal(body).field, 'body');
  assert.equal(refusal(undefined, Body, { root: 'query' }).field, 'query');
});

test('nothing is coerced: numeric strings, fractions, "true", numbers for text and out-of-range values are refused', () => {
  const cases = [
    [{ title: 'x', count: '3' }, 'count', 'count must be a number.'],
    [{ title: 'x', count: 2.5 }, 'count', 'count must be a whole number.'],
    [{ title: 'x', count: 11 }, 'count', 'count must be at most 10.'],
    [{ title: 'x', count: 0 }, 'count', 'count must be at least 1.'],
    [{ title: 'x', urgent: 'true' }, 'urgent', 'urgent must be true or false.'],
    [{ title: 42 }, 'title', 'title must be text.'],
    [{ title: '   ' }, 'title', 'title must not be blank.'],
    [{ title: 'x'.repeat(41) }, 'title', 'title must be at most 40 characters long.'],
    [{ title: 'x', note: null }, 'note', 'note must be text.'],
    [{ title: 'x', kind: 'match' }, 'kind', 'kind must be one of trial, visit.'],
    [{ title: 'x', ownerId: '' }, 'ownerId', 'ownerId must not be empty.'],
    [{ title: 'x', ownerId: 'i'.repeat(ID_MAX + 1) }, 'ownerId', `ownerId must be at most ${ID_MAX} characters long.`],
    [{ title: 'x', playerIds: ['a', 'b', 'c', 'd'] }, 'playerIds', 'playerIds must be at most 3 items long.'],
    [{ title: 'x', playerIds: 'pl-1' }, 'playerIds', 'playerIds must be a list.'],
  ];
  for (const [input, field, message] of cases) {
    const r = refusal(input);
    assert.equal(r.error, 'FIELD_INVALID', JSON.stringify(input));
    assert.equal(r.field, field);
    assert.equal(r.message, message);
  }
});

test('a value outside a vocabulary is refused with the allowed values', () => {
  const r = refusal({ title: 'x', kind: 'match' });
  assert.deepEqual(r.allowed, ['trial', 'visit']);
  assert.equal('allowed' in refusal({ title: 1 }), false);
});

test('a nested problem is named by its path', () => {
  const r = refusal({ title: 'x', documents: [{ evidenceId: 'ev-1' }, { evidenceId: 9 }] });
  assert.equal(r.field, 'documents[1].evidenceId');
  assert.equal(r.message, 'documents[1].evidenceId must be text.');
  assert.equal(refusal({ title: 'x', documents: [{ evidenceId: 'ev-1', extra: 1 }] }).field, 'documents[0].extra');
});

test('a bad calendar day is DATE_INVALID with the expected shape, whatever its type; a bad instant is TIMESTAMP_INVALID', () => {
  for (const day of ['2026-02-30', '20/11/2026', '2026-11-20T10:00:00Z', 20261120, null, {}]) {
    const r = refusal({ title: 'x', startsOn: day });
    assert.equal(r.error, 'DATE_INVALID', JSON.stringify(day));
    assert.equal(r.field, 'startsOn');
    assert.equal(r.expected, 'YYYY-MM-DD');
    assert.match(r.message, /^startsOn must be a calendar day written YYYY-MM-DD \(.+\)\.$/);
  }
  for (const at of ['2026-11-20T10:00', '1700000000000', 1.5, '2026-11-20']) {
    const r = refusal({ title: 'x', at });
    assert.equal(r.error, 'TIMESTAMP_INVALID', JSON.stringify(at));
    assert.equal(r.expected, 'ISO 8601 with offset or Z, or integer milliseconds');
  }
  assert.equal(parseInput(Body, { title: 'x', at: 1700000000000 }).ok, true);
});

test("a refusal never quotes the value that was sent, even for a schema with valibot's default messages", () => {
  const secret = 'maria.keane@example.com';
  const raw = v.strictObject({ name: v.string(), age: v.pipe(v.number(), v.maxValue(18)) });
  for (const [schema, input] of [
    [Body, { title: { secret } }],
    [Body, { title: 'x', kind: secret }],
    [Body, { title: 'x', startsOn: secret }],
    [Body, { title: 'x', note: secret.repeat(10) }],
    [raw, { name: [secret] }],
    [raw, { name: 'x', age: 99 }],
  ]) {
    const r = refusal(input, schema);
    assert.doesNotMatch(JSON.stringify(r), /maria|Received|99/i, JSON.stringify(r));
  }
});

test('a domain can rename the codes for its own contract; codes it does not rename are kept', () => {
  const codes = { FIELD_INVALID: 'TRIAL_INPUT_INVALID' };
  assert.equal(refusal({ title: 1 }, Body, { codes }).error, 'TRIAL_INPUT_INVALID');
  assert.equal(refusal({ title: 'x', startsOn: 'soon' }, Body, { codes }).error, 'DATE_INVALID');
  assert.equal(
    refusal({ title: 'x', startsOn: 'soon' }, Body, { codes: { DATE_INVALID: 'TRIAL_SCHEDULE_INVALID' } }).error,
    'TRIAL_SCHEDULE_INVALID',
  );
});

test('a field code names one field (list positions left out) or, with .*, a field and everything inside it', () => {
  const fieldCodes = {
    title: 'TITLE_REQUIRED',
    'documents.evidenceId': 'EVIDENCE_REF_INVALID',
    'playerIds.*': 'PLAYERS_INVALID',
    startsOn: 'TRIAL_DATE_INVALID',
  };
  const codes = { FIELD_INVALID: 'TRIAL_INPUT_INVALID' };
  assert.equal(refusal({}, Body, { fieldCodes }).error, 'TITLE_REQUIRED');
  assert.equal(
    refusal({ title: 'x', documents: [{ evidenceId: 'e' }, { evidenceId: 1 }] }, Body, { fieldCodes }).error,
    'EVIDENCE_REF_INVALID',
  );
  assert.equal(refusal({ title: 'x', documents: 'none' }, Body, { fieldCodes }).error, 'FIELD_INVALID');
  assert.equal(
    refusal({ title: 'x', documents: [{ evidenceId: 'e', x: 1 }] }, Body, { fieldCodes }).error,
    'FIELD_INVALID',
  );
  assert.equal(refusal({ title: 'x', playerIds: 'p' }, Body, { fieldCodes }).error, 'PLAYERS_INVALID');
  assert.equal(refusal({ title: 'x', playerIds: ['p', 2] }, Body, { fieldCodes }).error, 'PLAYERS_INVALID');
  assert.equal(refusal({ title: 'x', startsOn: 'soon' }, Body, { fieldCodes, codes }).error, 'TRIAL_DATE_INVALID');
  assert.equal(refusal({ title: 'x', count: 'many' }, Body, { fieldCodes, codes }).error, 'TRIAL_INPUT_INVALID');
  assert.equal(refusal({ title: 'x', constructor: 1 }, Body, { fieldCodes: {} }).error, 'FIELD_INVALID');
});

test('dayOrBlank takes a day or an empty string; dueDate takes a day, an instant or nothing, else DATE_INVALID', () => {
  const S = v.strictObject({ on: v.nullish(dayOrBlank), due: v.optional(dueDate) });
  for (const ok of [
    {},
    { on: '' },
    { on: null },
    { on: '2026-11-20' },
    { due: '' },
    { due: null },
    { due: '2026-11-20' },
    { due: '2026-11-20T10:00:00Z' },
    { due: 1700000000000 },
  ])
    assert.equal(parseInput(S, ok).ok, true, JSON.stringify(ok));
  for (const [bad, field] of [
    [{ on: '2026-02-30' }, 'on'],
    [{ on: 5 }, 'on'],
    [{ due: 'friday' }, 'due'],
    [{ due: '2026-11-20T10:00' }, 'due'],
  ]) {
    const r = refusal(bad, S);
    assert.equal(r.error, 'DATE_INVALID', JSON.stringify(bad));
    assert.equal(r.field, field);
  }
});

test('an over-long unknown key is named, but cut short', () => {
  const r = refusal({ title: 'x', ['k'.repeat(1000)]: 1 });
  assert.equal(r.field.length, 201);
});

test('inputOrRefuse returns the value, or answers 400 with the refusal body and returns undefined', () => {
  const res = {
    sent: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.sent = body;
      return this;
    },
  };
  assert.deepEqual(inputOrRefuse(res, Body, { title: 'x' }), { title: 'x' });
  assert.equal(res.sent, null);
  assert.equal(inputOrRefuse(res, Body, { title: 'x', startsOn: 'tomorrow' }), undefined);
  assert.equal(res.code, 400);
  assert.deepEqual(Object.keys(res.sent).sort(), ['error', 'expected', 'field', 'message']);
  assert.equal(res.sent.error, 'DATE_INVALID');
});

console.log(`${passed} input-schema checks passed`);
