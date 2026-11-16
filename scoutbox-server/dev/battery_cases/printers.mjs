// Printers for dev/battery_cases/map.mjs: each turns a recorded JavaScript value into a Gleam expression. They are
// written per type, not per function. A printer is `(value, ctx) => string`; `ctx.use(module)` imports a Gleam
// module and returns its alias. A printer refuses a value it doesn't understand (an unknown field, an unknown
// vocabulary value) by throwing, so a gap in the mapping fails the generator instead of producing a weaker test.
//
// Constructor names are read from the Gleam source, never written here: a vocabulary's from its generated `*_pairs`
// constant, an error code's from the hand-written `*_code` function that turns it into its text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const sources = new Map();
const source = (module) => {
  if (!sources.has(module)) sources.set(module, fs.readFileSync(path.join(SRC, `${module}.gleam`), 'utf8'));
  return sources.get(module);
};

/** text → constructor, from `pub const <name> = [#("text", Constructor), …]` in `module`. */
function pairsConst(module, name) {
  const src = source(module);
  const at = src.indexOf(`pub const ${name} = [`);
  if (at < 0) throw new Error(`${module} has no ${name}`);
  const body = src.slice(at, src.indexOf(']', at));
  return new Map([...body.matchAll(/#\("((?:[^"\\]|\\.)*)",\s*(\w+)\)/g)].map((m) => [m[1], m[2]]));
}

/** text → constructor, from the arms `Constructor -> "TEXT"` of `pub fn <name>(…) -> String` in `module`. */
function codeFn(module, name) {
  const src = source(module);
  const at = src.indexOf(`pub fn ${name}(`);
  if (at < 0) throw new Error(`${module} has no ${name}`);
  const body = src.slice(at, src.indexOf('\n}\n', at));
  return new Map([...body.matchAll(/^\s+(\w+) -> "((?:[^"\\]|\\.)*)"$/gm)].map((m) => [m[2], m[1]]));
}

const alias = (module) => module.split('/').at(-1);

/** A Gleam string literal. */
export function gleamString(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\u{${c.toString(16).toUpperCase()}}`;
    else out += ch;
  }
  return `${out}"`;
}

const fail = (what, v) => {
  throw new Error(`cannot print ${JSON.stringify(v)} as ${what}`);
};

export const string = (v) => (typeof v === 'string' ? gleamString(v) : fail('a String', v));
export const int = (v) => (Number.isInteger(v) ? String(v) : fail('an Int', v));
export const bool = (v) => (typeof v === 'boolean' ? (v ? 'True' : 'False') : fail('a Bool', v));
export const option = (p) => (v, ctx) => (v === null || v === undefined ? 'None' : `Some(${p(v, ctx)})`);
export const list = (p) => (v, ctx) => (Array.isArray(v) ? `[${v.map((x) => p(x, ctx)).join(', ')}]` : fail('a List', v));

/** A vocabulary value: the constructor `module` pairs it with in its `pairs` constant (default `pairs`). */
export const vocab =
  (module, pairs = 'pairs') =>
  (v, ctx) => {
    const c = pairsConst(module, pairs).get(v);
    if (!c) fail(`a value of ${module}.${pairs}`, v);
    return `${ctx.use(module)}.${c}`;
  };

/** A code: the constructor `module`'s `fnName` turns into `v`. */
export const code =
  (module, fnName) =>
  (v, ctx) => {
    const c = codeFn(module, fnName).get(v);
    if (!c) fail(`a code of ${module}.${fnName}`, v);
    return `${ctx.use(module)}.${c}`;
  };

/** A byte buffer, recorded as `{ $bytes: base64 }`. */
export const bytes = (v) =>
  typeof v?.$bytes === 'string' ? `<<${[...Buffer.from(v.$bytes, 'base64')].join(', ')}>>` : fail('bytes', v);

/** A Map, recorded as `{ $map: [[key, value], …] }`, as a Dict. */
export const dict = (k, x) => (v, ctx) =>
  Array.isArray(v?.$map)
    ? `${ctx.use('gleam/dict')}.from_list([${v.$map.map(([a, b]) => `#(${k(a, ctx)}, ${x(b, ctx)})`).join(', ')}])`
    : fail('a Map', v);

/**
 * A record: `Constructor(..base, field: value, …)`, or the full constructor when there is no base. `fields` maps
 * each JavaScript key to `[gleamField, printer]`, or to a function `(value, ctx) => [[gleamField, expression], …]`
 * for a key that spreads over several fields; `ignore` lists keys the Gleam type deliberately has no field for. A key
 * that is in neither is refused. Without a `base`, `defaults` gives the Gleam expression for a field the value leaves
 * out.
 */
export const record =
  ({ module, constructor, base, fields, ignore = [], defaults = {} }) =>
  (v, ctx) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(`a ${constructor}`, v);
    const parts = [];
    for (const [key, value] of Object.entries(v)) {
      if (ignore.includes(key)) continue;
      const f = fields[key];
      if (!f) throw new Error(`${constructor} has no field for the JavaScript key ${key} (value ${JSON.stringify(value)})`);
      const pairs = typeof f === 'function' ? f(value, ctx) : [[f[0], f[1](value, ctx)]];
      parts.push(...pairs.map(([name, expr]) => `${name}: ${expr}`));
    }
    for (const [name, expr] of Object.entries(defaults))
      if (!parts.some((p) => p.startsWith(`${name}: `))) parts.push(`${name}: ${expr}`);
    const ctor = `${ctx.use(module)}.${constructor}`;
    if (!base) return `${ctor}(${parts.join(', ')})`;
    if (!parts.length) return base(ctx);
    return `${ctor}(..${base(ctx)}, ${parts.join(', ')})`;
  };

/** A typed id (`scoutbox/rows/id`): `id.<name>("…")`. */
export const ident = (name) => (v, ctx) => `${ctx.use('scoutbox/rows/id')}.${name}(${string(v, ctx)})`;

/** A record from a function of a module: `name()` in `module`, imported (a record holding an opaque id can't be a constant). */
export const call = (module, name) => (ctx) => `${ctx.use(module)}.${name}()`;

/** A value from a module: `name` in `module`, imported. */
export const ref = (module, name) => (ctx) => `${ctx.use(module)}.${name}`;

export { alias };

/** Any JSON value, as a `gleam/json` expression (objects keep their key order). */
export const jsonValue = (v, ctx) => {
  const j = ctx.use('gleam/json');
  if (v === null) return `${j}.null()`;
  if (typeof v === 'string') return `${j}.string(${gleamString(v)})`;
  if (typeof v === 'boolean') return `${j}.bool(${v ? 'True' : 'False'})`;
  if (Number.isInteger(v)) return `${j}.int(${v})`;
  if (typeof v === 'number' && Number.isFinite(v)) return `${j}.float(${v})`;
  if (Array.isArray(v)) return `${j}.preprocessed_array([${v.map((x) => jsonValue(x, ctx)).join(', ')}])`;
  if (typeof v === 'object')
    return `${j}.object([${Object.entries(v)
      .map(([k, x]) => `#(${gleamString(k)}, ${jsonValue(x, ctx)})`)
      .join(', ')}])`;
  return fail('JSON', v);
};

/** A JavaScript number or numeric text given where JavaScript's `Number()` would read it, as the Gleam text. */
export const numberText = (v) =>
  typeof v === 'string' ? gleamString(v) : Number.isFinite(v) ? gleamString(String(v)) : fail('a number or text', v);
