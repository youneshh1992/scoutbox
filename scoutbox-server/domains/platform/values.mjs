/** Plain-value helpers shared by repositories and domains. */

/** Freezes a value and everything it holds. Already-frozen branches are left alone. */
export const deepFreeze = (v) => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
};

/**
 * JSON with keys sorted at every level and arrays kept in order, so two equal values always serialise the same way.
 * An undefined value serialises as null.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
