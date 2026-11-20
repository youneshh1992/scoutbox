// A call is kept as a case when its arguments and its result are data: plain JSON values, plus byte buffers, Dates and
// Maps, which are written tagged (`{ "$bytes": base64 }`, `{ "$date": ms }`, `{ "$map": [[key, value], …] }`) so a printer can tell them from
// plain objects. A call that changes its arguments (a rule that updates the record it is given) also keeps the
// arguments as they were after it. A call that throws a refusal with a code keeps the code. Everything else is kept as
// a reason only, so the report can list it for porting by hand. Only the calls a suite makes itself are recorded: a
// rule calling another rule is part of the first call.
import fs from 'node:fs';

const calls = [];
let pending = [];
let depth = 0;

/** `v` as JSON-ready data (`{ data }`), or why it can't be (`{ why }`). Object properties holding `undefined` are absent. */
function encode(v, at = '$') {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return { data: v };
  if (typeof v === 'number') return Number.isFinite(v) ? { data: v } : { why: `${at} is ${v}` };
  if (typeof v === 'undefined') return { why: `${at} is undefined` };
  if (typeof v === 'function') return { why: `${at} is a function` };
  if (typeof v !== 'object') return { why: `${at} is a ${typeof v}` };
  if (v instanceof Uint8Array) return { data: { $bytes: Buffer.from(v).toString('base64') } };
  // `instanceof` reads only the prototype (a Proxy's `get` may throw). The suites' Dates are all the preload's frozen
  // `Date`, the global at call time.
  if (v instanceof Date) {
    const ms = v.getTime();
    return Number.isFinite(ms) ? { data: { $date: ms } } : { why: `${at} is an invalid Date` };
  }
  if (Array.isArray(v)) {
    const out = [];
    for (let i = 0; i < v.length; i++) {
      const e = encode(v[i], `${at}[${i}]`);
      if (e.why) return e;
      out.push(e.data);
    }
    return { data: out };
  }
  if (v instanceof Map) {
    const out = [];
    for (const [k, x] of v) {
      const ek = encode(k, `${at} key`);
      if (ek.why) return ek;
      const ex = encode(x, `${at}.get(${JSON.stringify(k)})`);
      if (ex.why) return ex;
      out.push([ek.data, ex.data]);
    }
    return { data: { $map: out } };
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return { why: `${at} is a ${v.constructor?.name ?? 'class instance'}` };
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) continue;
    const e = encode(x, `${at}.${k}`);
    if (e.why) return e;
    out[k] = e.data;
  }
  return { data: out };
}

/** The arguments as plain data, trailing `undefined`s dropped (a missing argument), or the reason they aren't. */
function plainArgs(args) {
  const list = [...args];
  while (list.length && list.at(-1) === undefined) list.pop();
  const e = encode(list, 'args');
  return e.why ? { why: e.why } : { json: JSON.stringify(e.data) };
}

/** A thrown refusal's code: `err.code` when it is one, or the `CODE:` a message starts with. */
const refusalCode = (err) => {
  if (typeof err?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(err.code)) return err.code;
  return /^([A-Z][A-Z0-9_]{2,}):/.exec(String(err?.message ?? ''))?.[1] ?? null;
};

/** `fn`, exported as `name` by `module`, recording each call the suite makes. */
export function wrap(module, name, fn) {
  if (typeof fn !== 'function' || /^class\b/.test(Function.prototype.toString.call(fn))) return fn;
  const wrapped = function (...args) {
    if (depth > 0) return fn.apply(this, args);
    const call = { module, name };
    const a = plainArgs(args);
    if (a.why) call.why = a.why;
    else call.args = a.json;
    depth++;
    try {
      const out = fn.apply(this, args);
      if (out instanceof Promise) call.why ??= 'returns a promise';
      else if (!call.why) {
        const e = encode(out ?? null, 'result');
        if (e.why) call.why = e.why;
        else call.result = JSON.stringify(e.data);
        const after = plainArgs(args);
        if (!call.why && after.json !== call.args) call.argsAfter = after.json;
      }
      return out;
    } catch (err) {
      const code = refusalCode(err);
      if (!code) call.why ??= `throws ${err?.name ?? 'an error'} without a code`;
      else if (!call.why) call.throws = code;
      throw err;
    } finally {
      depth--;
      pending.push(call);
    }
  };
  Object.defineProperty(wrapped, 'name', { value: fn.name });
  return wrapped;
}

/** An assertion was made: the calls since the last one are the ones it checks. */
export function assertion(message) {
  for (const c of pending) calls.push({ ...c, assertion: message });
  pending = [];
}

process.on('exit', () => {
  for (const c of pending) calls.push({ ...c, assertion: null });
  if (process.env.BATTERY_CASES_OUT) fs.writeFileSync(process.env.BATTERY_CASES_OUT, JSON.stringify(calls));
});
