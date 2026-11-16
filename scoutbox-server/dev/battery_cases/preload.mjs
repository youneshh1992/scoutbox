// Preloaded (`node --import`) into a TypeScript rules suite's process by dev/battery_cases.mjs. It puts a wrapper module
// between the suite (anything under the TypeScript server's scripts/) and each rule module it imports, so runtime.mjs
// sees every call the suite makes; and it wraps the suite's `ok` and `neg` so each call is attached to the assertion
// that checks it. The rule modules themselves import each other directly, unwrapped and as one instance.
//
// BATTERY_CASES_SERVER  the TypeScript server's directory
// BATTERY_CASES_CLOCK   the instant Date.now() and `new Date()` stand still at
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER = path.resolve(process.env.BATTERY_CASES_SERVER);
const SCRIPTS = `${pathToFileURL(path.join(SERVER, 'scripts')).href}/`;
const RUNTIME = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime.mjs')).href;
const RULES_SUITE = pathToFileURL(path.join(SERVER, 'scripts', 'rulesSuite.mjs')).href;
const MARK = 'battery-cases-wrap';

// The rules: the shared rule modules and every domain module, except Box Cam's analysis (which this server won't port).
const RULE_FILES = ['domain.ts', 'temporal.ts', 'roles.ts'].map((f) => pathToFileURL(path.join(SERVER, f)).href);
const DOMAINS = `${pathToFileURL(path.join(SERVER, 'domains')).href}/`;
const ANALYSIS = ['domains/development/boxcam/cv/', 'domains/development/boxcam/providers', 'domains/development/drills']
  .map((p) => pathToFileURL(path.join(SERVER, p)).href);
const isRule = (url) =>
  RULE_FILES.includes(url) || (url.startsWith(DOMAINS) && !ANALYSIS.some((a) => url.startsWith(a)));

/** The names a module exports, from its source: declarations, export lists, and `export *` followed one level at a time. */
function exportNames(file, seen = new Set()) {
  if (seen.has(file) || !fs.existsSync(file)) return [];
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm))
    names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?!type\b)\{([^}]*)\}/gm))
    for (const part of m[1].split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .at(-1);
      if (name && /^[A-Za-z_$][\w$]*$/.test(name) && !/^type\s/.test(part.trim())) names.add(name);
    }
  for (const m of src.matchAll(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/gm))
    for (const n of exportNames(path.resolve(path.dirname(file), m[1]), seen)) names.add(n);
  if (/^export\s+default\b/m.test(src)) names.add('default');
  return [...names];
}

registerHooks({
  resolve(specifier, context, next) {
    const out = next(specifier, context);
    const parent = context.parentURL ?? '';
    if (!parent.startsWith(SCRIPTS) || parent.includes(MARK)) return out;
    if (out.url === RULES_SUITE || isRule(out.url)) return { ...out, url: `${out.url}?${MARK}`, shortCircuit: true };
    return out;
  },
  load(url, context, next) {
    if (!url.endsWith(`?${MARK}`)) return next(url, context);
    const real = url.slice(0, -MARK.length - 1);
    const J = JSON.stringify;
    if (real === RULES_SUITE) {
      const source = `import { rulesSuite as real } from ${J(real)};
import { assertion } from ${J(RUNTIME)};
export function rulesSuite(battery) {
  const s = real(battery);
  return { ...s, ok: (c, m) => { assertion(m); s.ok(c, m); }, neg: (c, m) => { assertion(\`[neg] \${m}\`); s.neg(c, m); } };
}
`;
      return { format: 'module', source, shortCircuit: true };
    }
    const rel = path.relative(SERVER, fileURLToPath(real)).split(path.sep).join('/');
    const names = exportNames(fileURLToPath(real));
    const lines = [
      `import * as M from ${J(real)};`,
      `import { wrap } from ${J(RUNTIME)};`,
      `export * from ${J(real)};`,
      ...names.map((n) =>
        n === 'default'
          ? `export default wrap(${J(rel)}, 'default', M.default);`
          : `export const ${n} = wrap(${J(rel)}, ${J(n)}, M[${J(n)}]);`,
      ),
    ];
    return { format: 'module', source: `${lines.join('\n')}\n`, shortCircuit: true };
  },
});

// The clock stands still at BATTERY_CASES_CLOCK (milliseconds since the epoch), so every recorded value is
// reproducible and a rule that reads the clock reads a known instant, which the generated tests pass as `now`.
const frozen = Number(process.env.BATTERY_CASES_CLOCK);
if (Number.isFinite(frozen)) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) {
      super(...(a.length ? a : [frozen]));
    }
    static now() {
      return frozen;
    }
  };
}
