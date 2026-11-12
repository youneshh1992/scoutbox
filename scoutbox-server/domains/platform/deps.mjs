/**
 * A domain factory's dependencies are exactly the names it declares. A declared name that is missing (or undefined)
 * fails the boot, so a misspelt or forgotten dependency is found at once rather than on the one path that uses it. A
 * name it did not declare fails too, so a wide context can't be handed on and the declaration stays the whole list.
 * A dependency that is deliberately absent is passed as null.
 */
export function needs(factory, deps, names) {
  if (!deps || typeof deps !== 'object') throw new TypeError(`${factory} needs its dependencies`);
  const declared = new Set(names);
  const missing = names.filter((n) => deps[n] === undefined);
  const undeclared = Object.keys(deps).filter((n) => !declared.has(n));
  const problems = [];
  if (missing.length) problems.push(`missing ${missing.join(', ')}`);
  if (undeclared.length) problems.push(`not declared: ${undeclared.join(', ')}`);
  if (problems.length) throw new TypeError(`${factory}: ${problems.join('; ')}`);
  return deps;
}

// Read by Node, the console and JSON on any object; never a dependency.
const INTROSPECTION = new Set(['then', 'toJSON', 'constructor', 'inspect', 'nodeType', 'asymmetricMatch']);

/**
 * The context a factory hands its own route modules: outside production, reading a name it does not hold throws, so a
 * dependency the declaration left out fails where it is read (a battery fails there) instead of reading as undefined.
 * In production it is the plain object.
 */
export function strictContext(factory, ctx) {
  if (process.env.NODE_ENV === 'production') return ctx;
  return new Proxy(ctx, {
    get(target, key, receiver) {
      if (typeof key === 'string' && !(key in target) && !INTROSPECTION.has(key))
        throw new TypeError(`${factory}: ${key} is not one of its dependencies`);
      return Reflect.get(target, key, receiver);
    },
  });
}
