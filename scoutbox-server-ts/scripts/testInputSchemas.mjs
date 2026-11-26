// The input-schema layer (domains/platform/schemas.mjs): a strict object refuses fields it doesn't declare and
// returns only the ones it does, unchanged; nothing is coerced; dates and instants are refused with their temporal
// codes; the refusal names the field by its path and never quotes the value sent; a domain can rename the codes; and
// inputOrRefuse answers the 400 itself. Run with: npm test
import assert from 'node:assert/strict';
import * as v from 'valibot';
import {
  ID_MAX,
  PROBLEMS,
  dateOnly,
  dateWrittenAs,
  dayOrBlank,
  declaredCodes,
  dueDate,
  flag,
  id,
  idList,
  idsText,
  inputOrRefuse,
  instant,
  listedIds,
  oneOf,
  oneShapeOf,
  parseInput,
  requiredText,
  text,
  timeOfDay,
  timeOrBlank,
  REV_FIELDS,
  REV_FIELD_CODES,
  wholeNumber,
  wholeNumberText,
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
    assert.equal(r.problem, 'unknown_field');
  }
});

test('a missing required field, or a body that is not an object, is refused naming the field or the body', () => {
  assert.deepEqual(refusal({}), {
    ok: false,
    error: 'FIELD_INVALID',
    field: 'title',
    problem: 'required',
    message: 'title is required.',
  });
  for (const body of [undefined, null, 'title', [], 7]) assert.equal(refusal(body).field, 'body');
  assert.equal(refusal(undefined, Body, { root: 'query' }).field, 'query');
});

test('nothing is coerced, and each refusal says what was wrong as a problem with its values: numeric strings, fractions, "true", numbers for text and out-of-range values are refused', () => {
  const cases = [
    [{ title: 'x', count: '3' }, 'count', 'count must be a number.', { problem: 'not_number' }],
    [{ title: 'x', count: 2.5 }, 'count', 'count must be a whole number.', { problem: 'not_whole_number' }],
    [{ title: 'x', count: 11 }, 'count', 'count must be at most 10.', { problem: 'too_large', max: 10 }],
    [{ title: 'x', count: 0 }, 'count', 'count must be at least 1.', { problem: 'too_small', min: 1 }],
    [{ title: 'x', urgent: 'true' }, 'urgent', 'urgent must be true or false.', { problem: 'not_boolean' }],
    [{ title: 42 }, 'title', 'title must be text.', { problem: 'not_text' }],
    [{ title: '   ' }, 'title', 'title must not be blank.', { problem: 'blank' }],
    [{ title: 'x'.repeat(41) }, 'title', 'title must be at most 40 characters long.', { problem: 'too_long', max: 40 }],
    [{ title: 'x', note: null }, 'note', 'note must be text.', { problem: 'not_text' }],
    [
      { title: 'x', kind: 'match' },
      'kind',
      'kind must be one of trial, visit.',
      { problem: 'not_allowed', allowed: ['trial', 'visit'] },
    ],
    [{ title: 'x', ownerId: '' }, 'ownerId', 'ownerId must not be empty.', { problem: 'too_short', min: 1 }],
    [
      { title: 'x', ownerId: 'i'.repeat(ID_MAX + 1) },
      'ownerId',
      `ownerId must be at most ${ID_MAX} characters long.`,
      { problem: 'too_long', max: ID_MAX },
    ],
    [
      { title: 'x', playerIds: ['a', 'b', 'c', 'd'] },
      'playerIds',
      'playerIds must be at most 3 items long.',
      { problem: 'too_long', max: 3 },
    ],
    [{ title: 'x', playerIds: 'pl-1' }, 'playerIds', 'playerIds must be a list.', { problem: 'not_list' }],
  ];
  for (const [input, field, message, values] of cases) {
    const r = refusal(input);
    assert.equal(r.error, 'FIELD_INVALID', JSON.stringify(input));
    assert.equal(r.field, field);
    assert.equal(r.message, message);
    for (const [k, want] of Object.entries(values)) assert.deepEqual(r[k], want, `${JSON.stringify(input)}: ${k}`);
    assert.ok(PROBLEMS.includes(r.problem));
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
    assert.equal(r.problem, 'not_a_date');
    assert.match(r.message, /^startsOn must be a calendar day written YYYY-MM-DD \(.+\)\.$/);
  }
  for (const at of ['2026-11-20T10:00', '1700000000000', 1.5, '2026-11-20']) {
    const r = refusal({ title: 'x', at });
    assert.equal(r.error, 'TIMESTAMP_INVALID', JSON.stringify(at));
    assert.equal(r.problem, 'not_a_timestamp');
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

test('timeOfDay takes HH:MM on the 24-hour clock and timeOrBlank also an empty string, else TIME_INVALID', () => {
  const S = v.strictObject({ at: v.optional(timeOfDay), quiet: v.nullish(timeOrBlank) });
  for (const ok of [{}, { at: '00:00' }, { at: '23:59' }, { quiet: '' }, { quiet: null }, { quiet: '07:30' }])
    assert.equal(parseInput(S, ok).ok, true, JSON.stringify(ok));
  for (const [bad, field] of [
    [{ at: '' }, 'at'],
    [{ at: '24:00' }, 'at'],
    [{ at: '7:30' }, 'at'],
    [{ at: 730 }, 'at'],
    [{ quiet: '25:99' }, 'quiet'],
    [{ quiet: ['07:30'] }, 'quiet'],
  ]) {
    const r = refusal(bad, S);
    assert.equal(r.error, 'TIME_INVALID', JSON.stringify(bad));
    assert.equal(r.field, field);
    assert.equal(r.problem, 'not_a_time');
    assert.equal(r.expected, 'HH:MM');
  }
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
  assert.deepEqual(Object.keys(res.sent).sort(), ['error', 'expected', 'field', 'message', 'problem']);
  assert.equal(res.sent.error, 'DATE_INVALID');
});

test('a whole number written as text takes digits in range only, with the bound it broke', () => {
  const Q = v.strictObject({ limit: v.optional(wholeNumberText({ min: 1, max: 50 })) });
  assert.deepEqual(parseInput(Q, { limit: '25' }, { root: 'query' }), { ok: true, value: { limit: '25' } });
  for (const bad of ['1.5', '-1', '1e3', ' 7', '', 'ten', '0x10'])
    assert.equal(refusal({ limit: bad }, Q).problem, 'not_whole_number', bad);
  assert.equal(refusal({ limit: 25 }, Q).problem, 'not_text');
  assert.equal(refusal({ limit: ['1', '2'] }, Q).problem, 'not_text');
  const small = refusal({ limit: '0' }, Q);
  assert.equal(small.problem, 'too_small');
  assert.equal(small.min, 1);
  const large = refusal({ limit: '51' }, Q);
  assert.equal(large.problem, 'too_large');
  assert.equal(large.max, 50);
});

test('the rev fields take a whole number or nothing, and REV_FIELD_CODES refuse the rest as guardRev does', () => {
  const R = v.strictObject(REV_FIELDS);
  assert.equal(parseInput(R, { expectedRev: 3 }).ok, true);
  assert.equal(parseInput(R, {}).ok, true);
  for (const bad of ['3', 3.5, -1, { n: 3 }])
    assert.equal(refusal({ expectedRev: bad }, R, { fieldCodes: REV_FIELD_CODES }).error, 'EXPECTED_REV_INVALID');
  assert.equal(refusal({ expectedVersion: '1' }, R, { fieldCodes: REV_FIELD_CODES }).error, 'EXPECTED_REV_INVALID');
});

test('oneShapeOf picks the shape by its key, refuses another value with allowed, and keeps each shape strict', () => {
  const S = oneShapeOf('type', [
    v.strictObject({ type: v.literal('contact'), message: v.optional(text(10)) }),
    v.strictObject({ type: v.literal('trial'), date: v.optional(dateOnly) }),
  ]);
  assert.equal(parseInput(S, { type: 'trial', date: '2026-03-01' }).ok, true);
  const other = refusal({ type: 'call' }, S);
  assert.equal(other.field, 'type');
  assert.equal(other.problem, 'not_allowed');
  assert.deepEqual(other.allowed, ['contact', 'trial']);
  assert.equal(refusal({}, S).problem, 'required');
  assert.equal(refusal({ type: 'contact', date: '2026-03-01' }, S).problem, 'unknown_field');
  assert.equal(refusal({ type: 'contact', message: { t: 1 } }, S).problem, 'not_text');
});

test('idsText takes up to max comma-separated ids written once, and refuses more rather than dropping them', () => {
  const Q = v.strictObject({ ids: v.optional(idsText(3)) });
  assert.deepEqual(listedIds(parseInput(Q, { ids: 'a,,b,c' }).value.ids), ['a', 'b', 'c']);
  assert.deepEqual(listedIds(undefined), []);
  const many = refusal({ ids: 'a,b,c,d' }, Q, { root: 'query' });
  assert.equal(many.field, 'ids');
  assert.equal(many.problem, 'too_long');
  assert.equal(many.max, 3);
  assert.equal(refusal({ ids: `a,${'x'.repeat(ID_MAX + 1)}` }, Q).max, ID_MAX);
  assert.equal(refusal({ ids: ['a', 'b'] }, Q).problem, 'not_text');
});

test('dateWrittenAs judges a domain date with its own test and refuses it as DATE_INVALID with its expected form', () => {
  const D = v.strictObject({ from: dateWrittenAs((x) => x === '2020', 'YYYY') });
  assert.equal(parseInput(D, { from: '2020' }).ok, true);
  const bad = refusal({ from: { y: 2020 } }, D);
  assert.equal(bad.error, 'DATE_INVALID');
  assert.equal(bad.problem, 'not_a_date');
  assert.equal(bad.expected, 'YYYY');
  assert.equal(bad.field, 'from');
});

test('declaredCodes keeps a shared field code only on a schema that declares the field', () => {
  const codes = { ...REV_FIELD_CODES, clientKey: 'KEY_INVALID' };
  const WithRev = v.strictObject({ note: v.optional(text()), ...REV_FIELDS });
  const Bare = v.strictObject({ note: v.optional(text()) });
  assert.deepEqual(declaredCodes(WithRev, codes), REV_FIELD_CODES);
  assert.deepEqual(declaredCodes(Bare, codes), {});
  const opts = (S) => ({ codes: { FIELD_INVALID: 'NOTE_INPUT_INVALID' }, fieldCodes: declaredCodes(S, codes) });
  const malformed = refusal({ expectedRev: '1' }, WithRev, opts(WithRev));
  assert.equal(malformed.error, 'EXPECTED_REV_INVALID');
  assert.equal(malformed.problem, 'not_number');
  const unknown = refusal({ expectedRev: 1 }, Bare, opts(Bare));
  assert.equal(unknown.error, 'NOTE_INPUT_INVALID');
  assert.equal(unknown.problem, 'unknown_field');
});

test('a list sent where an object is expected is refused at any depth, not read as an object with no fields', () => {
  const Nested = v.strictObject({
    target: v.optional(v.strictObject({ value: v.optional(wholeNumber()) })),
    rows: v.optional(v.array(v.strictObject({ id }))),
  });
  for (const [input, field] of [
    [{ target: [] }, 'target'],
    [{ target: ['x'] }, 'target'],
    [{ rows: [{ id: 'a' }, []] }, 'rows[1]'],
  ]) {
    const r = refusal(input, Nested, {
      codes: { FIELD_INVALID: 'NESTED_INVALID' },
      fieldCodes: { 'target.*': 'TARGET_INVALID' },
    });
    assert.equal(r.field, field);
    assert.equal(r.problem, 'not_object');
    assert.equal(r.error, field === 'target' ? 'TARGET_INVALID' : 'NESTED_INVALID');
  }
  assert.equal(
    parseInput(Nested, { target: { value: 1 }, rows: [] }).ok,
    true,
    'a list where a list is expected is fine',
  );
});

console.log(`${passed} input-schema checks passed`);
