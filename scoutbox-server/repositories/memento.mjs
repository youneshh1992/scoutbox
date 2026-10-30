/**
 * Object-graph memento, by identity.
 *
 * `captureGraph(roots)` records, for every plain object and array reachable
 * from the roots, its own data properties (or its elements) **by reference**,
 * so that `restoreGraph(memento)` can put every one of those objects back to
 * its captured state **in place**: the same array object gets its old length
 * and elements, the same record object gets its old keys and values, keys
 * added later are deleted, keys removed later come back. Objects created
 * after the capture are simply no longer referenced once their parents are
 * restored; objects removed after the capture are referenced again by the
 * restored parents. Callers that kept a reference to a record, a nested array
 * or the collection itself therefore see the pre-capture state after a
 * restore — which is what the store's unit of work needs: a failed operation
 * must leave memory, not only the database, as it was.
 *
 * Leaves (kept by reference, never walked, never restored): anything that is
 * not a plain object or array (Dates, Maps, class instances), frozen objects,
 * and every object registered as a repository view (`isView`) — views are
 * read-only proxies over state the repository restores itself. Non-writable
 * own properties (the table-backed collections the data layer defines on
 * `db`) are neither walked nor assigned.
 */
import { isView } from './readonly.mjs';

const isPlain = (o) => { const p = Object.getPrototypeOf(o); return p === Object.prototype || p === null; };
const walkable = (v) => v !== null && typeof v === 'object' && !isView(v) && !Object.isFrozen(v) && (Array.isArray(v) || isPlain(v));

export function captureGraph(roots) {
  const seen = new Map();
  const stack = [];
  const consider = (v) => { if (walkable(v) && !seen.has(v)) stack.push(v); };
  for (const r of roots) consider(r);
  while (stack.length) {
    const o = stack.pop();
    if (seen.has(o)) continue;
    if (Array.isArray(o)) {
      const items = o.slice();
      seen.set(o, { array: true, items });
      for (const v of items) consider(v);
    } else {
      const entries = [];
      for (const key of Reflect.ownKeys(o)) {
        const d = Object.getOwnPropertyDescriptor(o, key);
        if (!d || !('value' in d) || !d.writable) continue; // accessors and read-only properties are not data this memento owns
        entries.push([key, d.value]);
        consider(d.value);
      }
      seen.set(o, { array: false, entries });
    }
  }
  return seen;
}

export function restoreGraph(memento) {
  for (const [o, snap] of memento) {
    if (snap.array) {
      o.length = 0;
      for (const v of snap.items) o.push(v);
      continue;
    }
    const keep = new Set(snap.entries.map(([k]) => k));
    for (const key of Reflect.ownKeys(o)) {
      const d = Object.getOwnPropertyDescriptor(o, key);
      if (d && 'value' in d && d.writable && d.configurable && !keep.has(key)) delete o[key];
    }
    for (const [key, value] of snap.entries) o[key] = value;
  }
}
