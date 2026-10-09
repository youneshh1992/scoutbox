/**
 * Read-only views over a repository's in-memory rows.
 *
 * The rest of the server still reads a migrated domain through its old
 * `db.<collection>` array. That array, and every row in it, is now a view the
 * repository keeps current: reading works exactly as before (find, filter,
 * JSON.stringify, spread), while any direct write — a field assignment, a
 * push, a splice on a nested array — throws with a message that names the
 * repository to use. A write that bypassed the repository would otherwise
 * live only in memory and vanish on restart, which is the class of bug this
 * guard exists to turn into a loud failure in the test batteries.
 */

const views = new WeakMap();

const refuse = (what) => {
  throw new TypeError(`${what} is written through its domain repository under scoutbox-server/repositories/, never directly on the in-memory view.`);
};

export function readonlyView(target, label = 'this record') {
  if (target === null || typeof target !== 'object') return target;
  const existing = views.get(target);
  if (existing) return existing;
  const view = new Proxy(target, {
    get(t, key, receiver) {
      const value = Reflect.get(t, key, receiver);
      return value !== null && typeof value === 'object' ? readonlyView(value, label) : value;
    },
    set(_t, key) { return refuse(`${label} (field "${String(key)}")`); },
    deleteProperty(_t, key) { return refuse(`${label} (field "${String(key)}")`); },
    defineProperty(_t, key) { return refuse(`${label} (field "${String(key)}")`); },
    setPrototypeOf() { return refuse(label); },
  });
  views.set(target, view);
  return view;
}
