/**
 * Request input schemas (valibot) and the one adapter from a refusal to the API's error body.
 *
 * Routes declare their input with `v.strictObject({ … })` built from the shared field schemas here, and read it with
 * `inputOrRefuse` (which answers the 400 itself) or `parseInput` (which returns the refusal for a domain's own error
 * sender). Schemas check shape and type only and never convert a value: input is valid as sent, or refused.
 *
 * A refusal says what was wrong in fields a client can read: `error`, `field`, `problem` (one of PROBLEMS) and the
 * values the problem needs (`max`, `min`, `allowed`, `expected`). Clients turn those into the words a screen shows.
 * `message` is English for developers and logs, not for display. It is written here from the issue's kind, never
 * taken from valibot, whose default messages quote the value that was sent.
 */
import * as v from 'valibot';
import { isAbsent, parseDateOrInstant, parseInstant, parseStrictDateOnly } from '../../temporal.mjs';

export const TEXT_MAX = 500;
export const ID_MAX = 80;
const FIELD_MAX = 200;

/** What a refusal's `problem` can say. */
export const PROBLEMS = Object.freeze([
  'required',
  'unknown_field',
  'not_object',
  'not_list',
  'not_text',
  'not_boolean',
  'not_number',
  'not_whole_number',
  'blank',
  'too_short',
  'too_long',
  'too_small',
  'too_large',
  'not_allowed',
  'not_a_date',
  'not_a_timestamp',
  'invalid',
]);

// A check's requirement → the problem it reports, the values it needs, and the code and `expected` that replace
// FIELD_INVALID.
const CODED = new Map();
const coded = (requirement, { problem, error, expected, min, max }) => {
  CODED.set(requirement, { problem, error, expected, min, max });
  return requirement;
};

const DAY = { problem: 'not_a_date', error: 'DATE_INVALID', expected: 'YYYY-MM-DD' };
const isDateOnly = coded((x) => parseStrictDateOnly(x).ok, DAY);
const isDayOrBlank = coded((x) => x === '' || parseStrictDateOnly(x).ok, DAY);
const isDue = coded((x) => isAbsent(x) || parseDateOrInstant(x).ok, {
  ...DAY,
  expected: 'YYYY-MM-DD, ISO 8601 with offset or Z, or integer milliseconds',
});
const isInstant = coded((x) => parseInstant(x).ok, {
  problem: 'not_a_timestamp',
  error: 'TIMESTAMP_INVALID',
  expected: 'ISO 8601 with offset or Z, or integer milliseconds',
});
const hasText = coded((s) => s.trim().length > 0, { problem: 'blank' });

/** Text of at most `max` characters; may be empty. */
export const text = (max = TEXT_MAX) => v.pipe(v.string(), v.maxLength(max));

/** Text with something other than spaces in it, of at most `max` characters. */
export const requiredText = (max = TEXT_MAX) =>
  v.pipe(v.string(), v.check(hasText, 'must not be blank'), v.maxLength(max));

export const flag = v.boolean();

export const id = v.pipe(v.string(), v.minLength(1), v.maxLength(ID_MAX));

const isDigits = coded((s) => /^\d{1,15}$/.test(s), { problem: 'not_whole_number' });

/**
 * A whole number written as text, as a query string carries it: digits only, so `1.5`, `-1`, `1e3` and ` 7` are
 * refused rather than read as some other number. The route converts it with `Number`.
 */
export const wholeNumberText = ({ min = 0, max = Number.MAX_SAFE_INTEGER } = {}) =>
  v.pipe(
    v.string(),
    v.check(isDigits, 'must be a whole number'),
    v.check(
      coded((s) => Number(s) >= min, { problem: 'too_small', min }),
      `must be at least ${min}`,
    ),
    v.check(
      coded((s) => Number(s) <= max, { problem: 'too_large', max }),
      `must be at most ${max}`,
    ),
  );

/** A list of at most `max` ids. */
export const idList = (max) => v.pipe(v.array(id), v.maxLength(max));

/** A whole number (never a numeric string) from `min` to `max`. */
export const wholeNumber = ({ min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) =>
  v.pipe(v.number(), v.safeInteger(), v.minValue(min), v.maxValue(max));

/**
 * The optimistic-concurrency fields `guardRev` reads (platform/concurrency.mjs). With REV_FIELD_CODES a malformed
 * one is refused as EXPECTED_REV_INVALID, as `guardRev` itself refuses it; a domain with its own rev code maps
 * these fields to that instead.
 */
export const REV_FIELDS = Object.freeze({
  expectedRev: v.nullish(wholeNumber({ min: 0 })),
  expectedVersion: v.nullish(wholeNumber({ min: 0 })),
});
export const REV_FIELD_CODES = Object.freeze({
  expectedRev: 'EXPECTED_REV_INVALID',
  expectedVersion: 'EXPECTED_REV_INVALID',
});

// A vocabulary's refusal message → its values, so the refusal can list them as `allowed`. An issue does not name the
// schema it came from, but its message is the one written here.
const ALLOWED = new Map();

/** One of a fixed vocabulary. Its refusal carries `allowed`. */
export const oneOf = (values) => {
  const message = `must be one of ${values.join(', ')}`;
  ALLOWED.set(message, Object.freeze([...values]));
  return v.picklist(values, message);
};

/**
 * One of several shapes, chosen by the literal value of `key` in each (`v.literal('trial')`). A value outside them
 * is refused like `oneOf`, with `allowed`.
 */
export const oneShapeOf = (key, options) => {
  const values = options.map((o) => o.entries[key].literal);
  const message = `must be one of ${values.join(', ')}`;
  ALLOWED.set(message, Object.freeze(values));
  return v.variant(key, options, message);
};

/** A calendar day, YYYY-MM-DD (temporal.mjs). Anything else, including a non-string, is DATE_INVALID. */
export const dateOnly = v.pipe(
  v.unknown(),
  v.guard(isDateOnly, (issue) => `must be a calendar day written YYYY-MM-DD (${parseStrictDateOnly(issue.input).why})`),
);

/** An instant: ISO 8601 with an offset or Z, or integer milliseconds (temporal.mjs). Refused as TIMESTAMP_INVALID. */
export const instant = v.pipe(
  v.unknown(),
  v.guard(
    isInstant,
    (issue) => `must be a date-time with an offset or Z, or whole milliseconds (${parseInstant(issue.input).why})`,
  ),
);

/** A day the form may leave empty: `''` is accepted here, and the route reads it as no day. */
export const dayOrBlank = v.pipe(
  v.unknown(),
  v.guard(
    isDayOrBlank,
    (issue) => `must be a calendar day written YYYY-MM-DD (${parseStrictDateOnly(issue.input).why})`,
  ),
);

/**
 * A due date: a calendar day (the deadline is the end of it) or an instant, or absent (undefined, null or `''`). The
 * route converts it with `parseDateOrInstant`.
 */
export const dueDate = v.pipe(
  v.unknown(),
  v.guard(
    isDue,
    (issue) =>
      `must be a calendar day (YYYY-MM-DD) or an ISO 8601 date-time with an offset (${parseDateOrInstant(issue.input).why})`,
  ),
);

// The API names a nested field as `ratings[0].evidenceRefs[1].t`.
const fieldOf = (issue, root) => {
  let field = '';
  for (const p of issue.path ?? []) field += typeof p.key === 'number' ? `[${p.key}]` : `${field ? '.' : ''}${p.key}`;
  if (!field) field = root;
  return field.length > FIELD_MAX ? `${field.slice(0, FIELD_MAX)}…` : field;
};

/** `fieldCodes` keys name a field without its list positions: `ratings.confidence`, or `terms.*` for a subtree. */
function fieldCodeFor(issue, fieldCodes) {
  const keys = (issue.path ?? []).map((p) => p.key).filter((k) => typeof k !== 'number');
  if (!keys.length) return null;
  const exact = keys.join('.');
  if (Object.hasOwn(fieldCodes, exact)) return fieldCodes[exact];
  for (let n = keys.length; n > 0; n--) {
    const subtree = `${keys.slice(0, n).join('.')}.*`;
    if (Object.hasOwn(fieldCodes, subtree)) return fieldCodes[subtree];
  }
  return null;
}

const isKeyIssue = (issue) =>
  issue.type === 'strict_object' || issue.type === 'object' || issue.type === 'loose_object';

/** The problem, the values it needs, and an English phrase for it, none of which quote the value that was sent. */
function describe(issue) {
  const known = CODED.get(issue.requirement);
  const n = issue.requirement;
  const many = `${n} ${typeof issue.input === 'string' ? 'characters' : 'items'}`;
  if (isKeyIssue(issue) && issue.expected === 'never')
    return { problem: 'unknown_field', phrase: 'is not a field this request takes' };
  if (issue.input === undefined && issue.kind === 'schema') return { problem: 'required', phrase: 'is required' };
  if (known?.problem === 'blank') return { problem: 'blank', phrase: 'must not be blank' };
  if (known) return { problem: known.problem, min: known.min, max: known.max, phrase: 'is not valid' };
  switch (issue.type) {
    case 'string':
      return { problem: 'not_text', phrase: 'must be text' };
    case 'boolean':
      return { problem: 'not_boolean', phrase: 'must be true or false' };
    case 'number':
      return { problem: 'not_number', phrase: 'must be a number' };
    case 'array':
      return { problem: 'not_list', phrase: 'must be a list' };
    case 'object':
    case 'strict_object':
    case 'loose_object':
    case 'record':
      return { problem: 'not_object', phrase: 'must be an object' };
    case 'picklist':
    case 'variant':
      return { problem: 'not_allowed', phrase: 'is not one of the allowed values' };
    case 'max_length':
      return { problem: 'too_long', max: n, phrase: `must be at most ${many} long` };
    case 'min_length':
      return { problem: 'too_short', min: n, phrase: n === 1 ? 'must not be empty' : `must be at least ${many} long` };
    case 'integer':
    case 'safe_integer':
      return { problem: 'not_whole_number', phrase: 'must be a whole number' };
    case 'min_value':
      return { problem: 'too_small', min: n, phrase: `must be at least ${n}` };
    case 'max_value':
      return { problem: 'too_large', max: n, phrase: `must be at most ${n}` };
    default:
      return { problem: 'invalid', phrase: 'is not valid' };
  }
}
const phraseFor = (issue) => describe(issue).phrase;

/**
 * `{ ok: true, value }`, or `{ ok: false, error, field, problem, message, …values }` for the first problem found. `root`
 * names the input as a whole when it is the input itself that is wrong. `codes` renames this module's codes for a
 * domain whose contract has its own, e.g. `{ FIELD_INVALID: 'TRANSACTION_INPUT_INVALID' }`. `fieldCodes` gives one
 * field a code of its own (`{ 'ratings.confidence': 'CONFIDENCE_INVALID' }`), or a field and everything inside it
 * (`{ 'terms.*': 'TERMS_INPUT_INVALID' }`); it wins over `codes`.
 */
export function parseInput(schema, input, { root = 'body', codes = {}, fieldCodes = {} } = {}) {
  // Valibot's object schemas take an array as an object, so `[]` would pass as a body with no fields.
  if (Array.isArray(input) && isKeyIssue(schema)) {
    const error = codes.FIELD_INVALID ?? 'FIELD_INVALID';
    return { ok: false, error, field: root, problem: 'not_object', message: `${root} must be an object.` };
  }
  const result = v.safeParse(schema, input, { abortEarly: true, message: phraseFor });
  if (result.success) return { ok: true, value: result.output };
  const issue = result.issues[0];
  const field = fieldOf(issue, root);
  const known = CODED.get(issue.requirement);
  const allowed = ALLOWED.get(issue.message);
  const { problem, min, max } = describe(issue);
  const error =
    fieldCodeFor(issue, fieldCodes) ?? codes[known?.error ?? 'FIELD_INVALID'] ?? known?.error ?? 'FIELD_INVALID';
  return {
    ok: false,
    error,
    field,
    problem,
    message: `${field} ${issue.message}.`,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(known?.expected ? { expected: known.expected } : {}),
    ...(allowed ? { allowed } : {}),
  };
}

/** The parsed value, or `undefined` once the 400 has been sent. */
export function inputOrRefuse(res, schema, input, options) {
  const parsed = parseInput(schema, input, options);
  if (parsed.ok) return parsed.value;
  const { ok: _ok, ...body } = parsed;
  res.status(400).json(body);
  return undefined;
}
