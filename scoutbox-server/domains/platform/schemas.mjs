/**
 * Request input schemas (valibot) and the one adapter from a refusal to the API's error body.
 *
 * Routes declare their input with `v.strictObject({ … })` built from the shared field schemas here, and read it with
 * `inputOrRefuse` (which answers the 400 itself) or `parseInput` (which returns the refusal for a domain's own error
 * sender). Schemas check shape and type only and never convert a value: input is valid as sent, or refused.
 *
 * Refusal messages are written here from the issue's kind, never taken from valibot, whose default messages quote the
 * value that was sent.
 */
import * as v from 'valibot';
import { parseInstant, parseStrictDateOnly } from '../../temporal.mjs';

export const TEXT_MAX = 500;
export const ID_MAX = 80;
const FIELD_MAX = 200;

// A guard's requirement → the error code and `expected` its refusal carries instead of FIELD_INVALID.
const CODED = new Map();
const coded = (requirement, error, expected) => {
  CODED.set(requirement, { error, expected });
  return requirement;
};

const isDateOnly = coded((x) => parseStrictDateOnly(x).ok, 'DATE_INVALID', 'YYYY-MM-DD');
const isInstant = coded(
  (x) => parseInstant(x).ok,
  'TIMESTAMP_INVALID',
  'ISO 8601 with offset or Z, or integer milliseconds',
);
const hasText = (s) => s.trim().length > 0;

/** Text of at most `max` characters; may be empty. */
export const text = (max = TEXT_MAX) => v.pipe(v.string(), v.maxLength(max));

/** Text with something other than spaces in it, of at most `max` characters. */
export const requiredText = (max = TEXT_MAX) =>
  v.pipe(v.string(), v.check(hasText, 'must not be blank'), v.maxLength(max));

export const flag = v.boolean();

export const id = v.pipe(v.string(), v.minLength(1), v.maxLength(ID_MAX));

/** A list of at most `max` ids. */
export const idList = (max) => v.pipe(v.array(id), v.maxLength(max));

/** A whole number (never a numeric string) from `min` to `max`. */
export const wholeNumber = ({ min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) =>
  v.pipe(v.number(), v.safeInteger(), v.minValue(min), v.maxValue(max));

/** One of a fixed vocabulary. */
export const oneOf = (values) => v.picklist(values, `must be one of ${values.join(', ')}`);

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

const fieldOf = (issue, root) => {
  const keys = (issue.path ?? []).map((p) => String(p.key));
  const field = keys.length ? keys.join('.') : root;
  return field.length > FIELD_MAX ? `${field.slice(0, FIELD_MAX)}…` : field;
};

const isKeyIssue = (issue) =>
  issue.type === 'strict_object' || issue.type === 'object' || issue.type === 'loose_object';

/** What was wrong, without the value that was sent. Used for every issue whose schema sets no message of its own. */
function phraseFor(issue) {
  const many = (n) => (typeof issue.input === 'string' ? `${n} characters` : `${n} items`);
  if (isKeyIssue(issue) && issue.expected === 'never') return 'is not a field this request takes';
  if (issue.input === undefined && issue.kind === 'schema') return 'is required';
  switch (issue.type) {
    case 'string':
      return 'must be text';
    case 'boolean':
      return 'must be true or false';
    case 'number':
      return 'must be a number';
    case 'array':
      return 'must be a list';
    case 'object':
    case 'strict_object':
    case 'loose_object':
      return 'must be an object';
    case 'picklist':
      return 'is not one of the allowed values';
    case 'max_length':
      return `must be at most ${many(issue.requirement)} long`;
    case 'min_length':
      return issue.requirement === 1 ? 'must not be empty' : `must be at least ${many(issue.requirement)} long`;
    case 'integer':
    case 'safe_integer':
      return 'must be a whole number';
    case 'min_value':
      return `must be at least ${issue.requirement}`;
    case 'max_value':
      return `must be at most ${issue.requirement}`;
    default:
      return 'is not valid';
  }
}

/**
 * `{ ok: true, value }`, or `{ ok: false, error, field, message, expected? }` for the first problem found. `root`
 * names the input as a whole when it is the input itself that is wrong. `codes` renames this module's codes for a
 * domain whose contract has its own, e.g. `{ FIELD_INVALID: 'TRANSACTION_INPUT_INVALID' }`. `fieldCodes` gives a
 * top-level field (and everything inside it) a code of its own, e.g. `{ terms: 'TERMS_INPUT_INVALID' }`; it wins over
 * `codes`.
 */
export function parseInput(schema, input, { root = 'body', codes = {}, fieldCodes = {} } = {}) {
  // Valibot's object schemas take an array as an object, so `[]` would pass as a body with no fields.
  if (Array.isArray(input) && isKeyIssue(schema)) {
    const error = codes.FIELD_INVALID ?? 'FIELD_INVALID';
    return { ok: false, error, field: root, message: `${root} must be an object.` };
  }
  const result = v.safeParse(schema, input, { abortEarly: true, message: phraseFor });
  if (result.success) return { ok: true, value: result.output };
  const issue = result.issues[0];
  const field = fieldOf(issue, root);
  const known = CODED.get(issue.requirement);
  const top = issue.path?.[0]?.key;
  const error =
    (Object.hasOwn(fieldCodes, top) ? fieldCodes[top] : null) ??
    codes[known?.error ?? 'FIELD_INVALID'] ??
    known?.error ??
    'FIELD_INVALID';
  return {
    ok: false,
    error,
    field,
    message: `${field} ${issue.message}.`,
    ...(known?.expected ? { expected: known.expected } : {}),
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
