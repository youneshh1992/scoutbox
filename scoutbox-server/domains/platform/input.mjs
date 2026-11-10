import { parseStrictDateOnly } from '../../temporal.mjs';

// Free text must be a string or absent: any other type would throw on `.trim()` or be stored as an object.

export const optText = (v, max = 500) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);
export const reqText = (v, max = 500) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export const badField = (res, field) =>
  res.status(400).json({ error: 'FIELD_INVALID', field, message: `${field} must be text.` });
/** Never coerced. Returns true when refused. */
export const switchRefused = (res, v, field) => {
  if (typeof v === 'boolean') return false;
  res.status(400).json({ error: 'FIELD_INVALID', field, message: `${field} must be true or false.` });
  return true;
};

/** Returns false after sending the 400. */
export function dateOnlyOrRefuse(res, value, field) {
  const p = parseStrictDateOnly(value);
  if (p.ok) return true;
  res.status(400).json({
    error: 'DATE_INVALID',
    field,
    message: `${field} must be a calendar day written YYYY-MM-DD (${p.why}).`,
    expected: 'YYYY-MM-DD',
  });
  return false;
}
