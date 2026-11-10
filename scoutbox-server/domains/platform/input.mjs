// Request-body checks shared by the routes. Free text is a string or absent: any other type would throw on `.trim()`
// (a 500) or be stored as an object that a screen then crashes on.

/** Absent, or a string within the length limit. */
export const optText = (v, max = 500) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);
/** A non-blank string within the length limit. */
export const reqText = (v, max = 500) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export const badField = (res, field) => res.status(400).json({ error: 'FIELD_INVALID', field, message: `${field} must be text.` });
/** A switch must be sent as true or false (400 FIELD_INVALID naming it), never coerced. Returns true when refused. */
export const switchRefused = (res, v, field) => { if (typeof v === 'boolean') return false; res.status(400).json({ error: 'FIELD_INVALID', field, message: `${field} must be true or false.` }); return true; };
