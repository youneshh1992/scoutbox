// The recorder's runtime, loaded into a TypeScript rules suite's process by preload.mjs. The wrapper modules the hooks
// put between a suite and the rules it imports call `wrap` for each exported function, and the rules suite's `ok` and
// `neg` call `assertion`; on exit the calls go to BATTERY_CASES_OUT as JSON.
//
// A call is kept as a case when its arguments and its result are plain data (they survive a JSON round trip), or when
// it throws a refusal with a code. Everything else is kept as a reason only, so the report can list it for porting by
// hand. Only the calls a suite makes itself are recorded: a rule calling another rule is part of the first call.
import fs from 'node:fs';

const calls = [];
let pending = [];
let depth = 0;

/** Why `v` would not survive a JSON round trip, or null if it would. Object properties holding `undefined` are absent. */
function notPlain(v, at = '$') {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : `${at} is ${v}`;
  if (typeof v === 'undefined') return `${at} is undefined`;
  if (typeof v === 'function') return `${at} is a function`;
  if (typeof v !== 'object') return `${at} is a ${typeof v}`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const why = notPlain(v[i], `${at}[${i}]`);
      if (why) return why;
    }
    return null;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return `${at} is a ${v.constructor?.name ?? 'class instance'}`;
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) continue;
    const why = notPlain(x, `${at}.${k}`);
    if (why) return why;
  }
  return null;
}

/** The arguments as plain data, trailing `undefined`s dropped (a missing argument), or the reason they aren't. */
function plainArgs(args) {
  const list = [...args];
  while (list.length && list.at(-1) === undefined) list.pop();
  const why = notPlain(list, 'args');
  return why ? { why } : { json: JSON.stringify(list) };
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
        const why = notPlain(out, 'result');
        if (why) call.why = why;
        else call.result = JSON.stringify(out ?? null);
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
